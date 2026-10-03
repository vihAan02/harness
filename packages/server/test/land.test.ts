// The land step on the server (0B item 5; D-20, D-51): ordering, the fencing check, and landed notices.
// Leases are inserted directly: the lease commands come later in 0B, but the check is real now.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
const human = { principal: 'human_test', deviceId: null };
const device = { principal: 'human_test', deviceId: 'dev_1' };
const otherDevice = { principal: 'human_test', deviceId: 'dev_2' };
const cmd = (name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (name: string, args: Record<string, unknown>, caller: { principal: string; deviceId: string | null } = human) => executeCommand(db.pool, caller, cmd(name, args));
const res = (r: { result: unknown }) => r.result as Record<string, any>;
const rejects = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code && (!re || re.test(e.message)));
const SHA = (c: string) => c.repeat(40);
const kinds = async (seqs: number[]) => (await db.pool.query('SELECT kind, data FROM events WHERE project_id = $1 AND seq = ANY($2) ORDER BY seq', [project, seqs])).rows;

async function worker(name: string) {
  const agent = res(await run('agent.create', { name, vendor: 'claude' })).agent_id as string;
  const task = res(await run('task.create', { title: name, text: name, scope: [], assignee_agent_id: agent })).task_id as string;
  const session = randomUUID();
  await executeCommand(db.pool, device, cmd('session.report', { session_id: session, status: 'working', task_id: task, worktree: `/w/${task}`, branch: `harness/task/${task}` }, agent));
  return {
    agent, task, session,
    read: (path: string, hash: string | null) => executeCommand(db.pool, device, cmd('readset.add', { session_id: session, entries: [{ path, hash, source: 'read_tool', confidence: 'high' }] }, agent)),
  };
}
async function lease(task: string, path: string, opts: { current?: boolean; released?: boolean } = {}) {
  const token = Number((await db.pool.query('UPDATE projects SET next_fencing_token = next_fencing_token + 1 WHERE id = $1 RETURNING next_fencing_token', [project])).rows[0].next_fencing_token);
  const id = `lease_${randomUUID().slice(0, 8)}`;
  await db.pool.query(
    `INSERT INTO leases (id, project_id, task_id, path, token, expires_at, released_at) VALUES ($1, $2, $3, $4, $5, now() + $6::interval, $7)`,
    [id, project, task, path, token, opts.current === false ? '-1 minute' : '10 minutes', opts.released ? new Date() : null]);
  return { id, token };
}
const landArgs = (landId: string, changed: string[], tokens: { lease_id: string; token: number }[] = []) =>
  ({ land_id: landId, base_branch: 'main', base_sha: SHA('1'), merge_base_sha: SHA('1'), head_sha: SHA('2'), changed_paths: changed, lease_tokens: tokens });
async function finished(name: string) {
  const w = await worker(name);
  await run('task.complete', { task_id: w.task });
  return w;
}
async function request(task: string) {
  return res(await run('land.request', { task_id: task })).land_id as string;
}

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_1', 'human_test', 'laptop'), ('dev_2', 'human_test', 'other')");
});
after(async () => { await db?.drop(); });

test('a land: requested by a human for a finished task, run by its device, one at a time; completing it lands the task', async () => {
  const w = await worker('agent/w1');
  await rejects(run('land.request', { task_id: w.task }), 'conflict', /only a finished task/);
  await run('task.complete', { task_id: w.task });
  await rejects(executeCommand(db.pool, device, cmd('land.request', { task_id: w.task }, w.agent)), 'forbidden');
  const r = await run('land.request', { task_id: w.task });
  assert.equal(res(r).device_id, 'dev_1');
  assert.deepEqual((await kinds(r.seqs)).map((e) => e.kind), ['land.requested']);
  const landId = res(r).land_id;
  const w2 = await finished('agent/w1b');
  await rejects(run('land.request', { task_id: w2.task }), 'conflict', /one at a time/);
  await rejects(run('land', landArgs(landId, ['src/a.ts']), otherDevice), 'forbidden', /another device/);
  await rejects(run('land', landArgs(landId, ['src/a.ts'])), 'forbidden', /only harnessd/);
  const s = await run('land', landArgs(landId, ['src/a.ts']), device);
  assert.equal(res(s).accepted, true);
  await run('land.report', { land_id: landId, step: 'testing' }, device);
  const c = await run('land.complete', { land_id: landId, old_base_sha: SHA('1'), new_base_sha: SHA('3'), changed: [{ path: 'src/a.ts', new_hash: SHA('a') }] }, device);
  assert.deepEqual((await kinds(c.seqs)).map((e) => e.kind), ['land.completed']);
  assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id = $1', [w.task])).rows[0].status, 'landed');
  await rejects(run('land.complete', { land_id: landId, old_base_sha: SHA('1'), new_base_sha: SHA('3'), changed: [] }, device), 'conflict');
  // The next land can start now.
  await request(w2.task);
  await run('land.cancel', { task_id: w2.task });
});

test('fencing: no leases → accepted; another task\'s current lease → rejected and logged, not thrown', async () => {
  const a = await finished('agent/f1');
  const b = await worker('agent/f2');
  const held = await lease(b.task, 'src/api/');
  const landId = await request(a.task);
  const r = await run('land', landArgs(landId, ['src/api/login.ts', 'src/other.ts']), device);
  assert.equal(res(r).accepted, false);
  assert.deepEqual(res(r).problems, [{ path: 'src/api/login.ts', reason: 'leased_by_other', lease_id: held.id, token: held.token }]);
  assert.deepEqual((await kinds(r.seqs)).map((e) => e.kind), ['land.rejected'], 'the rejection is in the log');
  assert.equal((await db.pool.query('SELECT status FROM lands WHERE id = $1', [landId])).rows[0].status, 'rejected');
  // An expired lease of another task no longer blocks.
  await db.pool.query("UPDATE leases SET expires_at = now() - interval '1 minute' WHERE id = $1", [held.id]);
  const again = await request(a.task);
  assert.equal(res(await run('land', landArgs(again, ['src/api/login.ts']), device)).accepted, true);
  await run('land.fail', { land_id: again, reason: 'tests', detail: 'boom\u0007' }, device);
});

test('fencing: a stale token (a newer lease was issued on the path since) is rejected; T-2\'s shape', async () => {
  const a = await finished('agent/t1');
  const b = await worker('agent/t2');
  const mine = await lease(a.task, 'src/types.ts', { current: false }); // laptop slept: my lease expired
  const theirs = await lease(b.task, 'src/types.ts', { released: true }); // someone else took and released it since
  const landId = await request(a.task);
  const r = await run('land', landArgs(landId, ['src/types.ts'], [{ lease_id: mine.id, token: mine.token }]), device);
  assert.equal(res(r).accepted, false);
  assert.deepEqual(res(r).problems, [{ path: 'src/types.ts', reason: 'stale_token', lease_id: mine.id, token: mine.token, highest: theirs.token }]);
});

test('fencing: my current, highest lease → accepted; an expired one of mine → lease_not_current; unknown tokens rejected', async () => {
  const a = await finished('agent/m1');
  const cur = await lease(a.task, 'src/m/');
  let landId = await request(a.task);
  assert.equal(res(await run('land', landArgs(landId, ['src/m/x.ts'], [{ lease_id: cur.id, token: cur.token }]), device)).accepted, true);
  await run('land.fail', { land_id: landId, reason: 'error' }, device);
  await db.pool.query("UPDATE leases SET expires_at = now() - interval '1 minute' WHERE id = $1", [cur.id]);
  landId = await request(a.task);
  assert.deepEqual(res(await run('land', landArgs(landId, ['src/m/x.ts']), device)).problems.map((p: any) => p.reason), ['lease_not_current']);
  landId = await request(a.task);
  assert.deepEqual(res(await run('land', landArgs(landId, [], [{ lease_id: 'lease_forged', token: 999 }]), device)).problems.map((p: any) => p.reason), ['unknown_token']);
});

test('landing tells every reader whose content differs, including finished-but-unlanded tasks; same content, no notice', async () => {
  const writer = await worker('agent/backend');
  const reader = await worker('agent/frontend');
  const same = await worker('agent/same');
  const done = await worker('agent/done');
  await reader.read('src/types.ts', SHA('a'));
  await same.read('src/types.ts', SHA('c')); // already read the new content
  await done.read('src/types.ts', SHA('a'));
  await run('task.complete', { task_id: done.task });
  await run('task.complete', { task_id: writer.task });
  const landId = await request(writer.task);
  await run('land', landArgs(landId, ['src/types.ts']), device);
  const c = await run('land.complete', { land_id: landId, old_base_sha: SHA('1'), new_base_sha: SHA('4'), changed: [{ path: 'src/types.ts', new_hash: SHA('c') }] }, device);
  const sent = (await kinds(c.seqs)).filter((e) => e.kind === 'message.sent');
  assert.deepEqual(sent.map((e) => e.data.to_task_id).sort(), [done.task, reader.task].sort());
  const toReader = sent.find((e) => e.data.to_task_id === reader.task)!.data;
  assert.equal(toReader.stage, 'landed');
  assert.equal(toReader.land_id, landId);
  assert.match(toReader.text, /^Dependency changed: src\/types\.ts has changed since you read it\./);
  assert.deepEqual(toReader.new_hashes, { 'src/types.ts': SHA('c') });
});

test('a landed notice supersedes an undelivered in-progress one; an in-progress one never supersedes a landed one', async () => {
  const writer = await worker('agent/sw');
  const reader = await worker('agent/sr');
  await reader.read('src/s.ts', SHA('a'));
  await executeCommand(db.pool, device, cmd('claim.observe', { session_id: writer.session, paths: ['src/s.ts'], source: 'hook' }, writer.agent));
  await run('task.complete', { task_id: writer.task });
  const landId = await request(writer.task);
  await run('land', landArgs(landId, ['src/s.ts']), device);
  await run('land.complete', { land_id: landId, old_base_sha: SHA('1'), new_base_sha: SHA('5'), changed: [{ path: 'src/s.ts', new_hash: SHA('b') }] }, device);
  const third = await worker('agent/s3');
  await executeCommand(db.pool, device, cmd('claim.observe', { session_id: third.session, paths: ['src/s.ts'], source: 'hook' }, third.agent));
  const msgs = (await db.pool.query("SELECT data->>'stage' AS stage, superseded_by FROM messages WHERE to_task_id = $1 ORDER BY created_at, id", [reader.task])).rows;
  assert.deepEqual(msgs.map((m) => [m.stage, m.superseded_by !== null]), [['in_progress', true], ['landed', false], ['in_progress', false]]);
});
