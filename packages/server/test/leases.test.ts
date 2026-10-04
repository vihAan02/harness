// Hard claims (0B item 5; contract D-97): acquire first come first served, a human's force, renewal from
// the device that ran the task, release, abandon, lazy expiry, and how the land step's fencing check
// treats what these commands leave behind.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import type { HandlerContext } from '../src/handler.ts';
import { lockLeases } from '../src/leases.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
type Caller = { principal: string; deviceId: string | null };
const human: Caller = { principal: 'human_test', deviceId: null };
const device: Caller = { principal: 'human_test', deviceId: 'dev_1' };
const otherDevice: Caller = { principal: 'human_test', deviceId: 'dev_2' };
const cmd = (name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (name: string, args: Record<string, unknown>, caller: Caller = human, asAgent?: string) => executeCommand(db.pool, caller, cmd(name, args, asAgent));
const res = (r: { result: unknown }) => r.result as Record<string, any>;
const rejects = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code && (!re || re.test(e.message)));
const events = async (seqs: number[]) => (await db.pool.query('SELECT kind, data FROM events WHERE project_id = $1 AND seq = ANY($2) ORDER BY seq', [project, seqs])).rows as { kind: string; data: Record<string, any> }[];
const SHA = (c: string) => c.repeat(40);

/** An agent with a task in progress, running on dev_1. */
async function worker(name: string) {
  const agent = res(await run('agent.create', { name, vendor: 'claude' })).agent_id as string;
  const task = res(await run('task.create', { title: name, text: name, scope: [], assignee_agent_id: agent })).task_id as string;
  await run('session.report', { session_id: randomUUID(), status: 'working', task_id: task, worktree: `/w/${task}`, branch: `harness/task/${task}` }, device, agent);
  return {
    agent, task,
    acquire: (paths: string[], extra: Record<string, unknown> = {}) => run('lease.acquire', { task_id: task, paths, ...extra }, device, agent),
    renew: (ids: string[], caller: Caller = device) => run('lease.renew', { lease_ids: ids }, caller, agent),
    release: (ids: string[]) => run('lease.release', { lease_ids: ids }, device, agent),
  };
}
const expire = (ids: string[]) => db.pool.query("UPDATE leases SET expires_at = now() - interval '1 second' WHERE id = ANY($1)", [ids]);

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_1', 'human_test', 'laptop'), ('dev_2', 'human_test', 'other')");
});
after(async () => { await db?.drop(); });

test('acquire: one lease and one fencing token per path; first come, first served, all or nothing', async () => {
  const a = await worker('agent/acq-a');
  const b = await worker('agent/acq-b');
  const got = await a.acquire(['src/api/', 'src/types.ts'], { ttl_s: 60 });
  const g = res(got).granted as { lease_id: string; path: string; token: number; expires_at: string }[];
  assert.deepEqual(g.map((x) => x.path), ['src/api/', 'src/types.ts']);
  assert.ok(g[1]!.token > g[0]!.token, 'tokens only go up');
  const granted = await events(got.seqs);
  assert.deepEqual(granted.map((e) => [e.kind, e.data.path, e.data.by, e.data.force]), [
    ['lease.granted', 'src/api/', a.agent, false], ['lease.granted', 'src/types.ts', a.agent, false],
  ]);
  const ttl = Date.parse(g[0]!.expires_at) - Date.now();
  assert.ok(ttl > 50_000 && ttl <= 61_000, `expires in about 60 s, on the server's clock: ${ttl}`);

  // B overlaps one path (a file under A's folder): nothing is granted, and B is told why.
  const refused = await b.acquire(['src/api/login.ts', 'src/web/']);
  assert.deepEqual(res(refused).granted, []);
  assert.deepEqual(res(refused).conflicts.map((c: any) => [c.path, c.lease_id, c.task_id]), [['src/api/login.ts', g[0]!.lease_id, a.task]]);
  const told = await events(refused.seqs);
  assert.deepEqual(told.map((e) => [e.kind, e.data.kind, e.data.to, e.data.to_task_id]), [['message.sent', 'claim_conflict', b.agent, b.task]]);
  assert.match(told[0]!.data.text, /^src\/api\/login\.ts: agent\/acq-a \(task T-\d+\) holds a hard claim until \d\d:\d\d:\d\d UTC\. Your claim was not granted\.$/);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM leases WHERE task_id = $1', [b.task])).rows[0].n, 0, 'nothing granted, not even src/web/');

  // A human asking for B is refused the same way, but only the human hears about it.
  const forHuman = await run('lease.acquire', { task_id: b.task, paths: ['src/types.ts'] });
  assert.deepEqual([res(forHuman).granted.length, res(forHuman).conflicts.length, forHuman.seqs.length], [0, 1, 0]);

  // A task's own leases never conflict.
  assert.equal(res(await a.acquire(['src/api/x.ts'])).granted.length, 1);
});

test('acquire is checked: the task\'s own agent or a human, a task in progress, at most 50 paths, ttl 10 to 3600', async () => {
  const a = await worker('agent/val-a');
  const b = await worker('agent/val-b');
  await rejects(run('lease.acquire', { task_id: a.task, paths: ['src/'] }, device, b.agent), 'forbidden', /not your task/);
  await rejects(a.acquire(['src/'], { force: true }), 'forbidden', /only a human/);
  await rejects(a.acquire([]), 'bad_request');
  await rejects(a.acquire(Array.from({ length: 51 }, (_, i) => `f${i}.ts`)), 'bad_request');
  await rejects(a.acquire(['../etc/']), 'bad_request');
  await rejects(a.acquire(['src/'], { ttl_s: 9 }), 'bad_request');
  await rejects(a.acquire(['src/'], { ttl_s: 3601 }), 'bad_request');
  await rejects(a.acquire(['src/'], { ttl_s: 1.5 }), 'bad_request');
  await run('task.complete', { task_id: a.task });
  await rejects(run('lease.acquire', { task_id: a.task, paths: ['src/'] }), 'conflict', /only a task in progress or blocked/);
});

test('force: a human takes a lease over with newer tokens; the old holder is told and its land is rejected', async () => {
  const a = await worker('agent/force-a');
  const b = await worker('agent/force-b');
  const old = res(await a.acquire(['lib/'])).granted[0] as { lease_id: string; token: number };
  const forced = await run('lease.acquire', { task_id: b.task, paths: ['lib/util.ts'], force: true });
  const fresh = res(forced).granted[0] as { lease_id: string; token: number };
  assert.ok(fresh.token > old.token);
  const ev = await events(forced.seqs);
  assert.deepEqual(ev.map((e) => e.kind), ['lease.released', 'message.sent', 'lease.granted']);
  assert.deepEqual([ev[0]!.data.lease_id, ev[0]!.data.reason, ev[0]!.data.by], [old.lease_id, 'revoked', 'human_test']);
  assert.deepEqual([ev[1]!.data.kind, ev[1]!.data.to, ev[1]!.data.to_task_id], ['claim_conflict', a.agent, a.task]);
  assert.match(ev[1]!.data.text, /^lib\/: your hard claim was taken over by human_test for task T-\d+\./);
  assert.deepEqual([ev[2]!.data.force, ev[2]!.data.by], [true, 'human_test']);

  // A's work on lib/util.ts can't land now: its lease was revoked, and B holds the newer token.
  await run('task.complete', { task_id: a.task });
  const land = res(await run('land.request', { task_id: a.task })).land_id as string;
  const r = await run('land', { land_id: land, base_branch: 'main', base_sha: SHA('1'), merge_base_sha: SHA('1'), head_sha: SHA('2'), changed_paths: ['lib/util.ts'], lease_tokens: [old] }, device);
  assert.equal(res(r).accepted, false);
  assert.deepEqual(res(r).problems.map((p: any) => p.reason), ['leased_by_other']);
});

test('force is refused while a task holding an overlapping lease is being landed', async () => {
  const a = await worker('agent/fl-a');
  const b = await worker('agent/fl-b');
  await a.acquire(['pkg/']);
  await run('task.complete', { task_id: a.task });
  await run('land.request', { task_id: a.task });
  await rejects(run('lease.acquire', { task_id: b.task, paths: ['pkg/'], force: true }), 'conflict', /being landed; cancel that land first/);
  await run('land.cancel', { task_id: a.task });
  assert.equal(res(await run('lease.acquire', { task_id: b.task, paths: ['pkg/'], force: true })).granted.length, 1);
});

test('renew: only from the device that ran the task, as its agent; lost leases say why, and expiry is logged once', async () => {
  const a = await worker('agent/ren-a');
  const b = await worker('agent/ren-b');
  const [l1, l2, l3, l4] = res(await a.acquire(['r1/', 'r2/', 'r3/', 'r4/'], { ttl_s: 30 })).granted as { lease_id: string; expires_at: string }[];
  await rejects(a.renew([l1!.lease_id], otherDevice), 'forbidden', /ran on another device/);
  await rejects(b.renew([l1!.lease_id]), 'forbidden', /another agent's task/);
  await rejects(run('lease.renew', { lease_ids: [l1!.lease_id] }), 'forbidden', /only harnessd/);
  await rejects(a.renew(['ls_0000000000000000']), 'not_found');

  await a.release([l3!.lease_id]);
  await run('lease.acquire', { task_id: b.task, paths: ['r4/'], force: true });
  await expire([l2!.lease_id]); // the next lease command is the first to see it
  const r = await a.renew([l1!.lease_id, l2!.lease_id, l3!.lease_id, l4!.lease_id]);
  assert.deepEqual(res(r).renewed.map((x: any) => x.lease_id), [l1!.lease_id]);
  assert.ok(Date.parse(res(r).renewed[0].expires_at) > Date.parse(l1!.expires_at), 'pushed out by its own ttl');
  assert.deepEqual(res(r).lost, [
    { lease_id: l2!.lease_id, reason: 'expired' }, { lease_id: l3!.lease_id, reason: 'released' }, { lease_id: l4!.lease_id, reason: 'revoked' },
  ]);
  assert.deepEqual((await events(r.seqs)).map((e) => [e.kind, e.data.task_id]), [['lease.expired', a.task], ['lease.renewed', a.task]]);
  const again = await a.renew([l2!.lease_id]);
  assert.deepEqual([res(again).lost, again.seqs.length], [[{ lease_id: l2!.lease_id, reason: 'expired' }], 0], 'logged once; never revived');
});

test('release: the task\'s agent its own leases, a human any; abandoning a task releases the rest', async () => {
  const a = await worker('agent/rel-a');
  const b = await worker('agent/rel-b');
  const [x, y, z] = res(await a.acquire(['x/', 'y/', 'z/'])).granted as { lease_id: string }[];
  await rejects(b.release([x!.lease_id]), 'forbidden');
  const mine = await a.release([x!.lease_id]);
  assert.deepEqual(res(mine).released, [x!.lease_id]);
  assert.deepEqual((await events(mine.seqs)).map((e) => [e.kind, e.data.reason, e.data.by]), [['lease.released', 'released', a.agent]]);
  assert.deepEqual(res(await a.release([x!.lease_id])).released, [], 'already released: nothing to do');
  assert.deepEqual(res(await run('lease.release', { lease_ids: [y!.lease_id] })).released, [y!.lease_id]);
  const abandoned = await run('task.abandon', { task_id: a.task, reason: 'replanned' });
  assert.deepEqual((await events(abandoned.seqs)).filter((e) => e.kind === 'lease.released').map((e) => [e.data.lease_id, e.data.reason]), [[z!.lease_id, 'abandoned']]);
  assert.equal(res(await b.acquire(['z/'])).granted.length, 1, 'the path is free again');
});

test('the lease lock is per project and held until the transaction ends (D-97)', async () => {
  const a = await db.pool.connect();
  const b = await db.pool.connect();
  const tryLock = async (projectId: string) =>
    (await b.query("SELECT pg_try_advisory_xact_lock(hashtext('harness.leases:' || $1)) AS ok", [projectId])).rows[0].ok as boolean;
  try {
    await a.query('BEGIN');
    await lockLeases({ tx: a, projectId: project } as unknown as HandlerContext);
    await b.query('BEGIN');
    assert.equal(await tryLock(project), false, 'held by the first transaction');
    assert.equal(await tryLock(`${project}_other`), true, 'another project is not blocked');
    await b.query('ROLLBACK');
    await a.query('COMMIT');
    await b.query('BEGIN');
    assert.equal(await tryLock(project), true, 'released at commit');
    await b.query('ROLLBACK');
  } finally {
    a.release();
    b.release();
  }
});

test('concurrent acquires of the same path: exactly one is granted', async () => {
  const a = await worker('agent/race-a');
  const b = await worker('agent/race-b');
  const [ra, rb] = await Promise.all([a.acquire(['race/']), b.acquire(['race/'])]);
  assert.deepEqual([res(ra).granted.length + res(rb).granted.length, res(ra).conflicts.length + res(rb).conflicts.length], [1, 1]);
});
