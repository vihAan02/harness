// wait_for on the server (0B item 4; D-27, D-95): wait.start, and the sweep that resolves, times out or
// cancels every open wait, exactly once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import { sweepWaits } from '../src/waits.ts';
import { freshSchema, holdLeaseLock, seedProject, untilPast } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
const human = { principal: 'human_test', deviceId: null };
const device = { principal: 'human_test', deviceId: 'dev_1' };
const cmd = (name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (name: string, args: Record<string, unknown>) => executeCommand(db.pool, human, cmd(name, args));
const res = (r: { result: unknown }) => r.result as Record<string, any>;
const rejects = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code && (!re || re.test(e.message)));
const events = async (kinds: string[]) => (await db.pool.query(
  'SELECT kind, data FROM events WHERE project_id = $1 AND kind = ANY($2) ORDER BY seq', [project, kinds])).rows as { kind: string; data: Record<string, any> }[];
const ofWait = async (id: string) => (await events(['wait.started', 'wait.resolved', 'wait.timed_out', 'wait.cancelled'])).filter((e) => e.data.wait_id === id).map((e) => e.kind);

async function worker(name: string) {
  const agent = res(await run('agent.create', { name, vendor: 'claude' })).agent_id as string;
  const task = res(await run('task.create', { title: name, text: name, scope: [], assignee_agent_id: agent })).task_id as string;
  const session = randomUUID();
  await executeCommand(db.pool, device, cmd('session.report', { session_id: session, status: 'working', task_id: task, worktree: `/w/${task}`, branch: `harness/task/${task}` }, agent));
  const as = (name2: string, args: Record<string, unknown>) => executeCommand(db.pool, device, cmd(name2, args, agent));
  const wait = async (on: { kind: string; id: string }, timeout_s?: number) => res(await as('wait.start', { session_id: session, on, ...(timeout_s ? { timeout_s } : {}) }));
  return { agent, task, session, as, wait };
}

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_1', 'human_test', 'laptop')");
});
after(async () => { await db?.drop(); });

test('waiting for an answer: resolved by the sweep once it arrives, or at once if it already has', async () => {
  const a = await worker('agent/wa1');
  const b = await worker('agent/wb1');
  const q = res(await a.as('message.send', { kind: 'question', to: 'agent/wb1', text: 'which shape?' })).message_id as string;
  const w = await a.wait({ kind: 'answer', id: q }, 120);
  assert.deepEqual([w.outcome, typeof w.wait_id], ['waiting', 'string']);
  assert.equal(await sweepWaits(db.pool), 0, 'nothing to settle yet');
  const ans = res(await b.as('message.send', { kind: 'answer', in_reply_to: q, text: '{ token }' })).message_id as string;
  assert.equal(await sweepWaits(db.pool), 1);
  const [resolved] = (await events(['wait.resolved'])).filter((e) => e.data.wait_id === w.wait_id);
  assert.deepEqual(resolved!.data, { wait_id: w.wait_id, task_id: a.task, agent_id: a.agent, on: { kind: 'answer', id: q }, result: { answer_id: ans } });
  // Already answered: the wait starts and resolves in the same command.
  const again = await a.wait({ kind: 'answer', id: q });
  assert.deepEqual([again.outcome, again.result], ['resolved', { answer_id: ans }]);
  assert.deepEqual(await ofWait(again.wait_id), ['wait.started', 'wait.resolved']);
  // A contract request is answered, and waited for, the same way (D-105).
  const c = res(await a.as('message.send', { kind: 'contract_request', to: 'agent/wb1', text: 'Define { token }.' })).message_id as string;
  const wc = await a.wait({ kind: 'answer', id: c }, 120);
  const ca = res(await b.as('message.send', { kind: 'answer', in_reply_to: c, text: 'token: string' })).message_id as string;
  assert.equal(await sweepWaits(db.pool), 1);
  assert.deepEqual((await events(['wait.resolved'])).find((e) => e.data.wait_id === wc.wait_id)!.data.result, { answer_id: ca });
});

test('waiting for a task to land, and for a lease to free up (released or expired)', async () => {
  const a = await worker('agent/wa2');
  const b = await worker('agent/wb2');
  const w = await a.wait({ kind: 'task', id: b.task });
  assert.equal(w.outcome, 'waiting');
  await run('task.complete', { task_id: b.task });
  assert.equal(await sweepWaits(db.pool), 0, 'done isn\'t landed: its work isn\'t anywhere the waiter can have it yet (D-106)');
  await db.pool.query("UPDATE tasks SET status = 'landed' WHERE id = $1", [b.task]); // the land step's end state
  await sweepWaits(db.pool);
  assert.deepEqual((await events(['wait.resolved'])).find((e) => e.data.wait_id === w.wait_id)!.data.result, { status: 'landed' });

  // Leases are granted by stream B's commands (D-97); a row is enough to wait on.
  const lease = async (expiresIn: string) => {
    const id = `ls_${randomUUID().slice(0, 8)}`;
    await db.pool.query("INSERT INTO leases (id, project_id, task_id, path, token, expires_at) VALUES ($1, $2, $3, 'src/x.ts', 1, now() + $4::interval)", [id, project, b.task, expiresIn]);
    return id;
  };
  const l1 = await lease('10 minutes');
  const w1 = await a.wait({ kind: 'lease', id: l1 });
  assert.equal(w1.outcome, 'waiting');
  await db.pool.query('UPDATE leases SET released_at = now() WHERE id = $1', [l1]);
  await sweepWaits(db.pool);
  assert.deepEqual((await events(['wait.resolved'])).find((e) => e.data.wait_id === w1.wait_id)!.data.result, { lease: 'released' });
  const l2 = await lease('-1 second');
  assert.deepEqual((await a.wait({ kind: 'lease', id: l2 })).result, { lease: 'expired' });
  // A lease logged as expired stays expired, whatever its expiry says now (D-97).
  const l3 = await lease('10 minutes');
  await db.pool.query('UPDATE leases SET expired_logged_at = now() WHERE id = $1', [l3]);
  assert.deepEqual((await a.wait({ kind: 'lease', id: l3 })).result, { lease: 'expired' });
});

test('a wait that times out ends as timed_out, once, and tells the task\'s owner with task_blocked', async () => {
  const a = await worker('agent/wa3');
  const b = await worker('agent/wb3');
  const w = await a.wait({ kind: 'task', id: b.task }, 10);
  await db.pool.query("UPDATE waits SET timeout_at = now() - interval '1 second' WHERE id = $1", [w.wait_id]);
  assert.equal(await sweepWaits(db.pool), 1);
  assert.equal(await sweepWaits(db.pool), 0, 'one outcome per wait');
  assert.deepEqual(await ofWait(w.wait_id), ['wait.started', 'wait.timed_out']);
  const note = (await events(['message.sent'])).find((e) => e.data.wait_id === w.wait_id)!.data;
  assert.deepEqual([note.kind, note.to, note.to_task_id, note.reason, note.priority], ['task_blocked', 'human_test', a.task, 'wait_timed_out', 'high']);
  assert.match(note.text, new RegExp(`${a.task}'s agent stopped waiting for task ${b.task}`));
  // A late event doesn't revive it.
  await run('task.complete', { task_id: b.task });
  assert.equal(await sweepWaits(db.pool), 0);
});

test('a wait is cancelled when its own task ends first', async () => {
  const a = await worker('agent/wa4');
  const b = await worker('agent/wb4');
  const w = await a.wait({ kind: 'task', id: b.task });
  await run('task.abandon', { task_id: a.task, reason: 'changed plans' });
  await sweepWaits(db.pool);
  const [c] = (await events(['wait.cancelled'])).filter((e) => e.data.wait_id === w.wait_id);
  assert.equal(c!.data.reason, 'task_abandoned');
});

test('wait.start checks what it waits on, and allows one open wait per task', async () => {
  const a = await worker('agent/wa5');
  const b = await worker('agent/wb5');
  const theirs = res(await b.as('message.send', { kind: 'question', to: 'agent/wa5', text: 'q?' })).message_id as string;
  await rejects(a.wait({ kind: 'answer', id: theirs }), 'forbidden', /wasn't asked by you/);
  await rejects(a.wait({ kind: 'answer', id: 'msg_nope' }), 'not_found');
  await rejects(a.wait({ kind: 'task', id: a.task }), 'bad_request', /itself/);
  await rejects(a.wait({ kind: 'task', id: 'T-999' }), 'not_found');
  await rejects(a.wait({ kind: 'lease', id: 'ls_nope' }), 'not_found');
  await rejects(a.wait({ kind: 'deadline', id: 'x' }), 'bad_request', /on.kind/);
  await rejects(a.wait({ kind: 'task', id: '../x' }), 'bad_request', /on.id/);
  for (const t of [9, 3601, 1.5]) await rejects(a.wait({ kind: 'task', id: b.task }, t), 'bad_request', /timeout_s/);
  await a.wait({ kind: 'task', id: b.task });
  await rejects(a.wait({ kind: 'answer', id: theirs }), 'forbidden'); // checked before the open-wait rule
  const c = await worker('agent/wc5');
  await rejects(a.wait({ kind: 'task', id: c.task }), 'conflict', /already waiting/);
  // Only the session's own agent, through harnessd.
  await rejects(executeCommand(db.pool, device, cmd('wait.start', { session_id: a.session, on: { kind: 'task', id: c.task } }, b.agent)), 'forbidden');
  await rejects(run('wait.start', { session_id: a.session, on: { kind: 'task', id: c.task } }), 'forbidden');
});

test('two sweeps at once settle each wait exactly once', async () => {
  const waits: string[] = [];
  const targets = [];
  for (let i = 0; i < 6; i++) {
    const a = await worker(`agent/ws${i}`);
    const b = await worker(`agent/wt${i}`);
    waits.push((await a.wait({ kind: 'task', id: b.task })).wait_id);
    targets.push(b.task);
  }
  for (const t of targets) await db.pool.query("UPDATE tasks SET status = 'landed' WHERE id = $1", [t]); // a task wait ends at the land (D-106)
  const [x, y] = await Promise.all([sweepWaits(db.pool), sweepWaits(db.pool)]);
  assert.ok(x + y >= waits.length);
  for (const id of waits) assert.deepEqual(await ofWait(id), ['wait.started', 'wait.resolved']);
});

// A lease's expiry is judged as the lease commands judge it: under the lease lock, on the clock read there (D-97).
const leaseRow = async (task: string, expiresIn: string) => {
  const id = `ls_${randomUUID().slice(0, 8)}`;
  await db.pool.query("INSERT INTO leases (id, project_id, task_id, path, token, expires_at) VALUES ($1, $2, $3, 'src/y.ts', 1, clock_timestamp() + $4::interval)", [id, project, task, expiresIn]);
  return { id, expiresAt: (await db.pool.query('SELECT expires_at FROM leases WHERE id = $1', [id])).rows[0].expires_at as Date };
};

test('a lease renewed while its expiry passed is not reported expired: wait.start and the sweep wait for the lease lock (D-97)', async () => {
  const a = await worker('agent/wa6');
  const b = await worker('agent/wb6');
  const l = await leaseRow(b.task, '300 milliseconds');
  // b's renewal holds the lease lock and has pushed the expiry out, uncommitted, when the old expiry passes.
  let lock = await holdLeaseLock(db.pool, project);
  let done = false;
  let starting: Promise<Record<string, any>> | undefined;
  let queued: Date | null = null;
  try {
    await lock.tx.query("UPDATE leases SET expires_at = clock_timestamp() + interval '2 minutes' WHERE id = $1", [l.id]);
    await untilPast(db.pool, l.expiresAt);
    starting = a.wait({ kind: 'lease', id: l.id }).finally(() => { done = true; });
    queued = await lock.queued(() => done);
  } finally {
    await lock.release();
  }
  const w = await starting!;
  assert.deepEqual([w.outcome, w.result], ['waiting', undefined], 'the renewal committed before the wait looked');
  assert.ok(queued, 'wait.start took the lease lock');

  // The same at the sweep.
  await db.pool.query("UPDATE leases SET expires_at = clock_timestamp() + interval '300 milliseconds' WHERE id = $1", [l.id]);
  const old = (await db.pool.query('SELECT expires_at FROM leases WHERE id = $1', [l.id])).rows[0].expires_at as Date;
  lock = await holdLeaseLock(db.pool, project);
  let swept = false;
  let sweeping: Promise<number> | undefined;
  try {
    await lock.tx.query("UPDATE leases SET expires_at = clock_timestamp() + interval '2 minutes' WHERE id = $1", [l.id]);
    await untilPast(db.pool, old);
    sweeping = sweepWaits(db.pool).finally(() => { swept = true; });
    queued = await lock.queued(() => swept);
  } finally {
    await lock.release();
  }
  await sweeping;
  assert.deepEqual(await ofWait(w.wait_id), ['wait.started'], 'still waiting: the lease was renewed');
  assert.ok(queued, 'the sweep took the lease lock');

  // Once it really has run out, the sweep says so.
  await db.pool.query("UPDATE leases SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [l.id]);
  await sweepWaits(db.pool);
  assert.deepEqual((await events(['wait.resolved'])).find((e) => e.data.wait_id === w.wait_id)!.data.result, { lease: 'expired' });
});

test('a lease that runs out while wait.start waits for the lease lock is expired, not judged at the transaction\'s start (D-97)', async () => {
  const a = await worker('agent/wa7');
  const b = await worker('agent/wb7');
  const l = await leaseRow(b.task, '10 minutes');
  const lock = await holdLeaseLock(db.pool, project);
  let done = false;
  const starting = a.wait({ kind: 'lease', id: l.id }).finally(() => { done = true; });
  try {
    const began = await lock.queued(() => done);
    assert.ok(began, 'wait.start waits for the lease lock');
    // The lease runs out after wait.start's transaction began, and before it gets the lock.
    await db.pool.query("UPDATE leases SET expires_at = $2::timestamptz + interval '20 milliseconds' WHERE id = $1", [l.id, began]);
    await untilPast(db.pool, (await db.pool.query('SELECT expires_at FROM leases WHERE id = $1', [l.id])).rows[0].expires_at);
  } finally {
    await lock.release();
  }
  const w = await starting;
  assert.deepEqual([w.outcome, w.result], ['resolved', { lease: 'expired' }]);
});
