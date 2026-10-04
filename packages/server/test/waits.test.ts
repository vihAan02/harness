// wait_for on the server (0B item 4; D-27, D-95): wait.start, and the sweep that resolves, times out or
// cancels every open wait, exactly once.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import { sweepWaits } from '../src/waits.ts';
import { freshSchema, seedProject } from './helpers.ts';

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
});

test('waiting for a task to finish, and for a lease to free up (released or expired)', async () => {
  const a = await worker('agent/wa2');
  const b = await worker('agent/wb2');
  const w = await a.wait({ kind: 'task', id: b.task });
  assert.equal(w.outcome, 'waiting');
  await run('task.complete', { task_id: b.task });
  await sweepWaits(db.pool);
  assert.deepEqual((await events(['wait.resolved'])).find((e) => e.data.wait_id === w.wait_id)!.data.result, { status: 'done' });

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
  for (const t of targets) await run('task.complete', { task_id: t });
  const [x, y] = await Promise.all([sweepWaits(db.pool), sweepWaits(db.pool)]);
  assert.ok(x + y >= waits.length);
  for (const id of waits) assert.deepEqual(await ofWait(id), ['wait.started', 'wait.resolved']);
});
