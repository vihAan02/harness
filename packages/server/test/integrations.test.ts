// GitHub integration records on the server (D-114, D-115; protocol.md §11): a task's PR and what its device polls
// of it, blocked publishes, the base branch's tip moved only by compare-and-swap, merges made outside the harness
// noticed once, and the local land refused in a GitHub project.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
let local: string;
const human = { principal: 'human_test', deviceId: null };
const device = { principal: 'human_test', deviceId: 'dev_1' };
const other = { principal: 'human_test', deviceId: 'dev_2' };
const cmd = (projectId: string, name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: projectId, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (name: string, args: Record<string, unknown>, caller: { principal: string; deviceId: string | null } = human, p = project) => executeCommand(db.pool, caller, cmd(p, name, args));
const res = (r: { result: unknown }) => r.result as Record<string, any>;
const rejects = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code && (!re || re.test(e.message)));
const SHA = (c: string) => c.repeat(40);
const kinds = async (seqs: number[]) => (await db.pool.query('SELECT kind, data FROM events WHERE seq = ANY($1) AND project_id = $2 ORDER BY seq', [seqs, project])).rows;

/** A task its agent ran on dev_1 and finished. */
async function finished(name: string, p = project) {
  const agent = res(await run('agent.create', { name, vendor: 'claude' }, human, p)).agent_id as string;
  const task = res(await run('task.create', { title: name, text: name, scope: [], assignee_agent_id: agent }, human, p)).task_id as string;
  const session = randomUUID();
  await executeCommand(db.pool, device, cmd(p, 'session.report', { session_id: session, status: 'working', task_id: task, worktree: `/w/${task}`, branch: `b/${task}` }, agent));
  const read = (path: string, hash: string | null) => executeCommand(db.pool, device, cmd(p, 'readset.add', { session_id: session, entries: [{ path, hash, source: 'read_tool', confidence: 'high' }] }, agent));
  return { agent, task, session, read, complete: () => run('task.complete', { task_id: task }, human, p) };
}
const publish = (task: string, n: number, head = SHA('2'), caller = device) =>
  run('pr.publish', { task_id: task, pr_number: n, url: `https://github.com/o/r/pull/${n}`, head_sha: head, base_sha: SHA('1'), remote_ref: `refs/heads/harness/p/e/${task}` }, caller);
const status = (task: string, n: number, over: Record<string, unknown> = {}) =>
  run('pr.status', { task_id: task, pr_number: n, head_sha: SHA('2'), state: 'open', merged: false, mergeable_state: 'clean', checks: { guard: 'success' }, reviews: [], ...over }, device);

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  local = await seedProject(db.pool);
  await db.pool.query("UPDATE projects SET integration_mode = 'github', github_repo = 'o/r' WHERE id = $1", [project]);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_1', 'human_test', 'laptop'), ('dev_2', 'human_test', 'other')");
});
after(async () => { await db?.drop(); });

test('a task\'s PR: published by the device that ran it, once it\'s done; polled status is recorded only when it changes', async () => {
  const w = await finished('agent/p1');
  await rejects(publish(w.task, 7), 'conflict', /only a finished task/);
  await w.complete();
  await rejects(publish(w.task, 7, SHA('2'), other), 'forbidden', /another device/);
  await rejects(run('pr.publish', { task_id: w.task, pr_number: 7, url: 'x', head_sha: SHA('2'), base_sha: SHA('1'), remote_ref: 'refs/heads/b' }), 'forbidden', /only harnessd/);
  await rejects(run('pr.publish', { task_id: w.task, pr_number: 0, url: 'https://x', head_sha: SHA('2'), base_sha: SHA('1'), remote_ref: 'refs/heads/b' }, device), 'bad_request');
  await rejects(run('pr.publish', { task_id: w.task, pr_number: 7, url: 'https://x', head_sha: SHA('2'), base_sha: SHA('1'), remote_ref: 'main' }, device), 'bad_request', /remote_ref/);
  const p = await publish(w.task, 7);
  assert.deepEqual((await kinds(p.seqs)).map((e) => e.kind), ['pr.published']);
  const s1 = await status(w.task, 7);
  assert.deepEqual((await kinds(s1.seqs)).map((e) => e.kind), ['pr.updated']);
  const same = await status(w.task, 7);
  assert.deepEqual(same.seqs, [], 'nothing changed: no event');
  assert.equal(res(same).changed, false);
  const pushed = await status(w.task, 7, { head_sha: SHA('4'), mergeable_state: 'behind' });
  assert.equal((await kinds(pushed.seqs))[0].data.head_sha, SHA('4'));
  await rejects(status(w.task, 8), 'conflict', /#7/);
  await rejects(status(w.task, 7, { checks: { guard: 'green' } }), 'bad_request', /conclusion/);
  await rejects(status(w.task, 7, { merged: true }), 'bad_request', /merge_sha/);
  await rejects(run('pr.status', { task_id: w.task, pr_number: 7, head_sha: SHA('2'), state: 'open', merged: false, mergeable_state: 'clean', checks: {}, reviews: [] }, other), 'forbidden');
  const row = (await db.pool.query('SELECT head_sha, mergeable_state, checks FROM task_prs WHERE task_id = $1', [w.task])).rows[0];
  assert.deepEqual(row, { head_sha: SHA('4'), mergeable_state: 'behind', checks: { guard: 'success' } });
});

test('a blocked publish is recorded for the human; nothing else changes', async () => {
  const w = await finished('agent/b1');
  await w.complete();
  const r = await run('publish.blocked', { task_id: w.task, reasons: [{ rule: 'denied_path', path: '.github/workflows/ci.yml' }, { rule: 'secret:sk-or-', commit: SHA('5') }] }, device);
  const [e] = await kinds(r.seqs);
  assert.equal(e.kind, 'publish.blocked');
  assert.deepEqual(e.data.reasons, [{ rule: 'denied_path', path: '.github/workflows/ci.yml' }, { rule: 'secret:sk-or-', commit: SHA('5') }]);
  await rejects(run('publish.blocked', { task_id: w.task, reasons: [] }, device), 'bad_request');
});

test('the base chain: the first observation seeds it, then only a compare-and-swap moves it; a move is noticed once', async () => {
  const reader = await finished('agent/r1');
  await reader.read('src/shared.ts', SHA('a'));
  await reader.read('src/same.ts', SHA('b'));
  await db.pool.query('UPDATE tasks SET base_set_at = now() WHERE id = $1', [reader.task]);
  const seed = await run('base.observe', { old_sha: SHA('0'), new_sha: SHA('1'), changed: [] }, device);
  assert.equal(res(seed).status, 'seeded');
  assert.deepEqual(seed.seqs, []);
  const changed = [{ path: 'src/shared.ts', new_hash: SHA('c') }, { path: 'src/same.ts', new_hash: SHA('b') }];
  const stale = await run('base.observe', { old_sha: SHA('9'), new_sha: SHA('3'), changed }, device);
  assert.deepEqual(res(stale), { status: 'stale', tip: SHA('1') });
  const applied = await run('base.observe', { old_sha: SHA('1'), new_sha: SHA('3'), changed }, other);
  assert.equal(res(applied).status, 'applied');
  const events = await kinds(applied.seqs);
  assert.deepEqual(events.map((e) => e.kind), ['base.advanced', 'message.sent']);
  assert.match(events[1].data.text, /src\/shared\.ts has changed since you read it/);
  assert.match(events[1].data.text, /a merge outside the harness \(commit 3333333\)/);
  assert.equal(events[1].data.new_base_sha, SHA('3'));
  assert.deepEqual(events[1].data.paths, ['src/shared.ts'], 'the unchanged file is not news');
  // Another daemon reporting the same move: known, nothing new.
  const again = await run('base.observe', { old_sha: SHA('1'), new_sha: SHA('3'), changed }, device);
  assert.deepEqual([res(again).status, again.seqs], ['known', []]);
  assert.equal((await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha, SHA('3'));
  await rejects(run('base.observe', { old_sha: SHA('3'), new_sha: SHA('3'), changed: [] }, device), 'bad_request');
  await rejects(run('base.observe', { old_sha: SHA('3'), new_sha: SHA('4'), changed: [] }), 'forbidden', /only harnessd/);
  // A reader whose base predates an outside move hears of it when it reads one of its files (trigger 2b).
  const late = await finished('agent/r2');
  await db.pool.query("UPDATE tasks SET base_set_at = now() - interval '1 hour' WHERE id = $1", [late.task]);
  const r = await late.read('src/shared.ts', SHA('a'));
  const notices = (await kinds(r.seqs)).filter((e) => e.kind === 'message.sent');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].data.land_id, `base:${SHA('3')}`);
});

test('a move seen while a merge is armed is parked: no notice, no tip move, until the merge\'s outcome is known', async () => {
  const w = await finished('agent/a1');
  await w.complete();
  const tip = (await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha;
  await db.pool.query(
    `INSERT INTO lands (id, project_id, task_id, device_id, requested_by, status, mode, pr_number, approved_head_sha, approved_base_sha, step, merge_requested_at)
     VALUES ('land_armed00000000', $1, $2, 'dev_1', 'human_test', 'accepted', 'github', 9, $3, $4, 'merge_requested', now())`, [project, w.task, SHA('2'), tip]);
  try {
    const r = await run('base.observe', { old_sha: tip, new_sha: SHA('6'), changed: [{ path: 'x.ts', new_hash: SHA('d') }] }, other);
    assert.deepEqual(res(r), { status: 'parked', land_id: 'land_armed00000000' });
    assert.deepEqual(r.seqs, []);
    assert.equal((await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha, tip);
    assert.equal((await db.pool.query('SELECT status FROM base_advances WHERE new_sha = $1', [SHA('6')])).rows[0].status, 'parked');
  } finally {
    await db.pool.query("UPDATE lands SET status = 'failed', reason = 'error' WHERE id = 'land_armed00000000'");
    await db.pool.query('DELETE FROM base_advances WHERE new_sha = $1', [SHA('6')]);
  }
});

test('a PR merged outside the harness lands once: task landed, leases released, readers told, the chain moved', async () => {
  const w = await finished('agent/x1');
  const reader = await finished('agent/x2');
  await reader.read('src/api.ts', SHA('a'));
  await w.complete();
  await publish(w.task, 11);
  const tip = (await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha;
  const token = Number((await db.pool.query('UPDATE projects SET next_fencing_token = next_fencing_token + 1 WHERE id = $1 RETURNING next_fencing_token', [project])).rows[0].next_fencing_token);
  await db.pool.query("INSERT INTO leases (id, project_id, task_id, path, token, expires_at) VALUES ('ls_x1', $1, $2, 'src/api.ts', $3, now() + interval '10 minutes')", [project, w.task, token]);
  const args = { task_id: w.task, pr_number: 11, merge_sha: SHA('7'), old_base_sha: tip, changed: [{ path: 'src/api.ts', new_hash: SHA('e') }] };
  await rejects(run('land.external', { ...args, pr_number: 12 }, device), 'conflict', /#12/);
  const stale = await run('land.external', { ...args, old_base_sha: SHA('8') }, device);
  assert.equal(res(stale).status, 'stale');
  const r = await run('land.external', args, device);
  assert.equal(res(r).status, 'landed');
  const events = await kinds(r.seqs);
  assert.deepEqual(events.map((e) => e.kind), ['land.completed', 'lease.released', 'message.sent']);
  assert.equal(events[0].data.external, true);
  assert.equal(events[0].data.new_base_sha, SHA('7'));
  assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id = $1', [w.task])).rows[0].status, 'landed');
  assert.deepEqual((await db.pool.query('SELECT merged, merge_sha FROM task_prs WHERE task_id = $1', [w.task])).rows[0], { merged: true, merge_sha: SHA('7') });
  assert.equal((await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha, SHA('7'));
  // Once: a repeat, and an observation of the same commit by another daemon, are both known.
  assert.equal(res(await run('land.external', args, device)).status, 'known');
  assert.equal(res(await run('base.observe', { old_sha: tip, new_sha: SHA('7'), changed: [] }, other)).status, 'known');
});

test('a land in flight for the task is the harness\'s own merge: land.external leaves it to its device', async () => {
  const w = await finished('agent/y1');
  await w.complete();
  await publish(w.task, 13);
  await db.pool.query(
    `INSERT INTO lands (id, project_id, task_id, device_id, requested_by, status, mode, pr_number) VALUES ('land_inflight00000', $1, $2, 'dev_2', 'human_test', 'accepted', 'github', 13)`, [project, w.task]);
  try {
    const r = await run('land.external', { task_id: w.task, pr_number: 13, merge_sha: SHA('9'), old_base_sha: SHA('7'), changed: [] }, device);
    assert.deepEqual(res(r), { status: 'reservation_active', land_id: 'land_inflight00000' });
  } finally {
    await db.pool.query("UPDATE lands SET status = 'failed', reason = 'error' WHERE id = 'land_inflight00000'");
  }
});

test('the project\'s mode decides: no local land in a GitHub project, no GitHub records in a local one', async () => {
  const w = await finished('agent/m1');
  await w.complete();
  await rejects(run('land.request', { task_id: w.task }), 'conflict', /integrates through GitHub/);
  await rejects(run('land.request', { task_id: w.task, run_tests: false }), 'conflict', /integrates through GitHub/);
  const l = await finished('agent/m2', local);
  await l.complete();
  await rejects(run('pr.publish', { task_id: l.task, pr_number: 1, url: 'https://x', head_sha: SHA('2'), base_sha: SHA('1'), remote_ref: 'refs/heads/b' }, device, local), 'conflict', /lands locally/);
  await rejects(run('base.observe', { old_sha: SHA('1'), new_sha: SHA('2'), changed: [] }, device, local), 'conflict', /lands locally/);
  const landId = res(await run('land.request', { task_id: l.task }, human, local)).land_id;
  assert.match(landId, /^land_/);
  await run('land.cancel', { task_id: l.task }, human, local);
});

test('a PR merge another daemon saw first as an outside move of the base still lands its task, once, with no second notice', async () => {
  const w = await finished('agent/z1');
  await w.complete();
  await publish(w.task, 21);
  const tip = (await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha;
  const changed = [{ path: 'src/z.ts', new_hash: SHA('f') }];
  const seen = await run('base.observe', { old_sha: tip, new_sha: SHA('a'), changed }, other);
  assert.equal(res(seen).status, 'applied');
  const r = await run('land.external', { task_id: w.task, pr_number: 21, merge_sha: SHA('a'), old_base_sha: tip, changed }, device);
  assert.equal(res(r).status, 'landed');
  assert.deepEqual((await kinds(r.seqs)).map((e) => e.kind), ['land.completed'], 'no second notice, no tip move');
  assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id = $1', [w.task])).rows[0].status, 'landed');
  assert.match((await db.pool.query('SELECT source FROM base_advances WHERE new_sha = $1', [SHA('a')])).rows[0].source, /^land:/);
  assert.equal(res(await run('land.external', { task_id: w.task, pr_number: 21, merge_sha: SHA('a'), old_base_sha: tip, changed }, device)).status, 'known');
});

test('an armed GitHub land fails only on GitHub\'s evidence, can\'t be cancelled, and can\'t complete unless armed', async () => {
  const w = await finished('agent/g1');
  await w.complete();
  await publish(w.task, 31);
  const tip = (await db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [project])).rows[0].tip_sha;
  const approver = { principal: 'human_test', deviceId: null, authDeviceId: 'dev_1' };
  const land = res(await run('land.request', { task_id: w.task, mode: 'github', pr_number: 31, head_sha: SHA('2'), base_sha: tip }, approver)).land_id;
  const accepted = await run('land', { land_id: land, base_branch: 'main', base_sha: tip, merge_base_sha: tip, head_sha: SHA('2'), changed_paths: ['src/g.ts'], lease_tokens: [] }, device);
  assert.equal(res(accepted).accepted, true);
  await rejects(run('land.complete', { land_id: land, old_base_sha: tip, new_base_sha: SHA('b'), changed: [] }, device), 'conflict', /never armed/);
  await rejects(run('land.arm', { land_id: land, head_sha: SHA('3'), base_sha: tip }, device), 'conflict', /approved/);
  await run('land.arm', { land_id: land, head_sha: SHA('2'), base_sha: tip }, device);
  await rejects(run('land.cancel', { task_id: w.task }), 'conflict', /can't be cancelled/);
  await rejects(run('land.fail', { land_id: land, reason: 'error', detail: 'timeout' }, device), 'conflict', /armed/);
  await rejects(run('land.fail', { land_id: land, reason: 'pr_closed' }, device), 'conflict', /evidence/);
  const failed = await run('land.fail', { land_id: land, reason: 'pr_closed', evidence: { state: 'closed', merged: false, head_sha: SHA('2') } }, device);
  assert.deepEqual((await kinds(failed.seqs)).map((e) => e.kind), ['land.failed']);
});
