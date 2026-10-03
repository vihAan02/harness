// The invalidation engine's in-progress triggers (0B item 2; coordination.md §2): a peer starts editing a
// file you read, or you read a file a peer is editing. Landed notices are tested with the land step.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand } from '../src/commands.ts';
import { noticeText } from '../src/invalidation.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
const human = { principal: 'human_test', deviceId: null };
const device = { principal: 'human_test', deviceId: 'dev_1' };
const cmd = (name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (name: string, args: Record<string, unknown>) => executeCommand(db.pool, human, cmd(name, args));
const res = (r: { result: unknown }) => r.result as Record<string, any>;
const H = (c: string) => c.repeat(40);
const notices = async (task: string) =>
  (await db.pool.query(
    `SELECT id, text, data, superseded_by, delivered_at FROM messages WHERE project_id = $1 AND kind = 'dependency_changed' AND to_task_id = $2 ORDER BY created_at, id`,
    [project, task])).rows;
const kinds = async (seqs: number[]) => (await db.pool.query('SELECT kind, data FROM events WHERE project_id = $1 AND seq = ANY($2) ORDER BY seq', [project, seqs])).rows;

async function worker(name: string) {
  const agent = res(await run('agent.create', { name, vendor: 'claude' })).agent_id as string;
  const task = res(await run('task.create', { title: name, text: name, scope: [], assignee_agent_id: agent })).task_id as string;
  const session = randomUUID();
  await executeCommand(db.pool, device, cmd('session.report', { session_id: session, status: 'working', task_id: task, worktree: `/w/${task}`, branch: `harness/task/${task}` }, agent));
  return {
    agent, task, session, name,
    read: (path: string, hash: string | null) => executeCommand(db.pool, device, cmd('readset.add', { session_id: session, entries: [{ path, hash, source: 'read_tool', confidence: 'high' }] }, agent)),
    edit: (paths: string[]) => executeCommand(db.pool, device, cmd('claim.observe', { session_id: session, paths, source: 'hook' }, agent)),
  };
}

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_1', 'human_test', 'laptop')");
});
after(async () => { await db?.drop(); });

test('trigger 1: a peer starts editing a file you read; you hear it once, as a fact, addressed to your task', async () => {
  const a = await worker('agent/a1');
  const b = await worker('agent/b1');
  await a.read('src/types.ts', H('a'));
  await a.read('src/other.ts', H('c'));
  const r = await b.edit(['src/types.ts', 'src/unrelated.ts']);
  const ev = await kinds(r.seqs);
  const sent = ev.filter((e) => e.kind === 'message.sent' && e.data.kind === 'dependency_changed');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.to, a.agent);
  assert.equal(sent[0].data.to_task_id, a.task);
  assert.equal(sent[0].data.stage, 'in_progress');
  assert.deepEqual(sent[0].data.paths, ['src/types.ts'], 'only files the reader read');
  assert.equal(sent[0].data.priority, 'high');
  assert.equal(sent[0].data.text, `src/types.ts: agent/b1 (task ${b.task}) is changing this file, which you read at hash aaaaaaa. The change hasn't landed yet.`);
  assert.equal((await b.edit(['src/types.ts'])).seqs.length, 0, 'the same claim again: no event');
  await b.edit(['src/types.ts', 'src/again.ts']);
  assert.equal((await notices(a.task)).length, 1, 'the same news is never sent twice');
  // The writer's own reads never notify itself.
  await b.read('src/mine.ts', H('d'));
  await b.edit(['src/mine.ts']);
  assert.equal((await notices(b.task)).length, 0);
});

test('trigger 2: you read a file a peer is already editing', async () => {
  const a = await worker('agent/a2');
  const b = await worker('agent/b2');
  await b.edit(['src/api/login.ts']);
  const r = await a.read('src/api/login.ts', H('e'));
  const sent = (await kinds(r.seqs)).filter((e) => e.kind === 'message.sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].data.stage, 'in_progress');
  assert.equal(sent[0].data.writer_task, b.task);
  assert.equal((await a.read('src/api/login.ts', H('e'))).seqs.length, 0, 're-reading the same content is no news');
});

test('a newer in-progress notice replaces an older undelivered one it fully covers; delivered ones stay', async () => {
  const a = await worker('agent/a3');
  const b = await worker('agent/b3');
  const c = await worker('agent/c3');
  await a.read('src/x.ts', H('1'));
  await b.edit(['src/x.ts']);
  const [first] = await notices(a.task);
  const r = await c.edit(['src/x.ts']);
  const ev = await kinds(r.seqs);
  assert.ok(ev.some((e) => e.kind === 'message.superseded' && e.data.message_id === first.id));
  const all = await notices(a.task);
  assert.equal(all.length, 2);
  assert.equal(all[0].superseded_by, all[1].id);
  // An older notice with a path the newer one doesn't cover is kept.
  const d = await worker('agent/d3');
  await a.read('src/y.ts', H('2'));
  await d.edit(['src/y.ts']); // notice for y only
  const e = await worker('agent/e3');
  await e.edit(['src/x.ts']); // covers x only: doesn't supersede the y notice
  const live = (await notices(a.task)).filter((m) => !m.superseded_by);
  assert.deepEqual(live.map((m) => m.data.paths), [['src/y.ts'], ['src/x.ts']]);
});

test('readers are active tasks only; finished or abandoned tasks hear nothing in progress', async () => {
  const a = await worker('agent/a4');
  const b = await worker('agent/b4');
  await a.read('src/z.ts', H('3'));
  await run('task.abandon', { task_id: a.task, reason: 'test' });
  await b.edit(['src/z.ts']);
  assert.equal((await notices(a.task)).length, 0);
});

test('an agent works on one task at a time', async () => {
  const a = await worker('agent/a5');
  await assert.rejects(run('task.create', { title: 'second', text: 'x', scope: [], assignee_agent_id: a.agent }), /already working on/);
  const open = res(await run('task.create', { title: 'later', text: 'x', scope: [] })).task_id;
  await assert.rejects(run('task.assign', { task_id: open, assignee_agent_id: a.agent }), /already working on/);
  await run('task.complete', { task_id: a.task });
  await run('task.assign', { task_id: open, assignee_agent_id: a.agent });
});

test('notice text: the landed form carries the exact S3 sentence for each path', () => {
  const t = noticeText('landed', [{ path: 'src/types.ts', readHash: H('a'), newHash: H('b') }, { path: 'src/gone.ts', readHash: null, newHash: null }], { task: 'T-2', agent: 'agent_x', agentName: 'agent/backend' });
  assert.match(t, /^Dependency changed: src\/types\.ts has changed since you read it\. \(You read aaaaaaa; it's now bbbbbbb\.\)$/m);
  assert.match(t, /^Dependency changed: src\/gone\.ts has changed since you read it\. \(You read unknown; it's now deleted\.\)$/m);
  assert.match(t, /Landed by agent\/backend \(task T-2\)\.$/);
});

test('a first read and a first edit of the same file, at the same moment, never miss each other', async () => {
  // Each runs in its own transaction: without the per-project invalidation lock, each could check for the
  // other before the other committed, and the in-progress notice would be lost for good.
  const a = await worker('agent/race-a');
  const b = await worker('agent/race-b');
  const files = Array.from({ length: 40 }, (_, i) => `src/race/${i}.ts`);
  await Promise.all(files.map((f) => Promise.all([a.read(f, H('7')), b.edit([f])])));
  const told = new Set((await notices(a.task)).flatMap((n) => n.data.paths as string[]));
  assert.deepEqual(files.filter((f) => !told.has(f)), [], 'every file the reader read is covered by a notice');
});

test('the same news is never sent twice: a writer whose claim clears and comes back, or a reader re-reading mid-edit', async () => {
  const a = await worker('agent/dd-a');
  const b = await worker('agent/dd-b');
  await a.read('src/dd.ts', H('1'));
  await b.edit(['src/dd.ts']);
  assert.equal((await notices(a.task)).length, 1);
  // The writer's diff no longer shows the file (it reverted it), then it edits it again: a new claim, the same news.
  await executeCommand(db.pool, device, cmd('claim.observe', { session_id: b.session, paths: [], source: 'diff' }, b.agent));
  const again = await b.edit(['src/dd.ts']);
  assert.ok((await kinds(again.seqs)).some((e) => e.kind === 'claim.observed'), 'the claim really was added again');
  assert.ok(!(await kinds(again.seqs)).some((e) => e.kind === 'message.sent'));
  // The reader reads newer content while the writer is still at it: still nothing new.
  const reread = await a.read('src/dd.ts', H('2'));
  assert.ok((await kinds(reread.seqs)).some((e) => e.kind === 'readset.added'));
  assert.ok(!(await kinds(reread.seqs)).some((e) => e.kind === 'message.sent'));
  assert.equal((await notices(a.task)).length, 1);
});
