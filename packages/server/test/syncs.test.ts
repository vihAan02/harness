// sync.report and task.unblock (D-53): a sync stales the synced reads; a conflict blocks the task until a human unblocks it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
const human = { principal: 'human_test', deviceId: null };
const device = { principal: 'human_test', deviceId: 'dev_1' };
const cmd = (name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (name: string, args: Record<string, unknown>) => executeCommand(db.pool, human, cmd(name, args));
const res = (r: { result: unknown }) => r.result as Record<string, any>;
const SHA = (c: string) => c.repeat(40);
const status = async (task: string) => (await db.pool.query('SELECT status FROM tasks WHERE id = $1', [task])).rows[0].status;
const events = async (seqs: number[]) => (await db.pool.query('SELECT kind, data FROM events WHERE project_id = $1 AND seq = ANY($2) ORDER BY seq', [project, seqs])).rows;

async function worker(name: string) {
  const agent = res(await run('agent.create', { name, vendor: 'claude' })).agent_id as string;
  const task = res(await run('task.create', { title: name, text: name, scope: [], assignee_agent_id: agent })).task_id as string;
  const session = randomUUID();
  await executeCommand(db.pool, device, cmd('session.report', { session_id: session, status: 'working', task_id: task, worktree: `/w/${task}`, branch: `harness/task/${task}` }, agent));
  const as = (name2: string, args: Record<string, unknown>) => executeCommand(db.pool, device, cmd(name2, { session_id: session, ...args }, agent));
  return { agent, task, session, as };
}

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_1', 'human_test', 'laptop')");
});
after(async () => { await db?.drop(); });

test('a sync marks the reader\'s entries for the synced files stale; a re-read freshens them', async () => {
  const a = await worker('agent/s1');
  await a.as('readset.add', { entries: [{ path: 'src/types.ts', hash: SHA('a'), source: 'read_tool', confidence: 'high' }, { path: 'src/keep.ts', hash: SHA('b'), source: 'read_tool', confidence: 'high' }] });
  const r = await a.as('sync.report', { event: 'synced', old_base_sha: SHA('1'), new_base_sha: SHA('2'), changed_paths: ['src/types.ts', 'src/new.ts'] });
  const [ev] = await events(r.seqs);
  assert.equal(ev.kind, 'worktree.synced');
  assert.deepEqual(ev.data.stale_paths, ['src/types.ts']);
  const rows = (await db.pool.query('SELECT path, stale FROM read_entries WHERE task_id = $1 ORDER BY path', [a.task])).rows;
  assert.deepEqual(rows, [{ path: 'src/keep.ts', stale: false }, { path: 'src/types.ts', stale: true }]);
  await a.as('readset.add', { entries: [{ path: 'src/types.ts', hash: SHA('c'), source: 'read_tool', confidence: 'high' }] });
  assert.equal((await db.pool.query("SELECT stale FROM read_entries WHERE task_id = $1 AND path = 'src/types.ts'", [a.task])).rows[0].stale, false);
});

test('a sync that brings in more files than a report can list marks every read of the task stale', async () => {
  const a = await worker('agent/s1b');
  await a.as('readset.add', { entries: [{ path: 'src/one.ts', hash: SHA('a'), source: 'read_tool', confidence: 'high' }, { path: 'src/two.ts', hash: SHA('b'), source: 'read_tool', confidence: 'high' }] });
  const r = await a.as('sync.report', { event: 'synced', old_base_sha: SHA('1'), new_base_sha: SHA('2'), changed_paths: [], all_changed: true });
  const [ev] = await events(r.seqs);
  assert.deepEqual([ev.data.all_changed, ev.data.stale_paths], [true, ['src/one.ts', 'src/two.ts']]);
});

test('a conflicting sync blocks the task and tells its owner; only a human unblocks it', async () => {
  const a = await worker('agent/s2');
  const r = await a.as('sync.report', { event: 'conflict', old_base_sha: SHA('1'), new_base_sha: SHA('2'), conflict_paths: ['src/types.ts'] });
  const ev = await events(r.seqs);
  assert.deepEqual(ev.map((e) => e.kind), ['worktree.sync_conflict', 'task.blocked', 'message.sent']);
  assert.equal(ev[2].data.kind, 'task_blocked');
  assert.equal(ev[2].data.to, 'human_test');
  assert.match(ev[2].data.text, /harness task unblock/);
  assert.equal(await status(a.task), 'blocked');
  // Still the agent's active task: its claims count, and it can't be given another.
  await assert.rejects(run('task.create', { title: 'x', text: 'x', scope: [], assignee_agent_id: a.agent }), /already working on/);
  await assert.rejects(executeCommand(db.pool, device, cmd('task.unblock', { task_id: a.task }, a.agent)), (e) => e instanceof CommandError && e.code === 'forbidden');
  const u = await run('task.unblock', { task_id: a.task });
  assert.deepEqual((await events(u.seqs)).map((e) => e.kind), ['task.unblocked']);
  assert.equal(await status(a.task), 'in_progress');
  await assert.rejects(run('task.unblock', { task_id: a.task }), /not blocked/);
});
