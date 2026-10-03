// readset.add (0B item 1; D-22, D-88): read entries per task and path, as hashes, from harnessd only.
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
const H1 = 'a'.repeat(40);
const H2 = 'b'.repeat(40);
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);

async function worker(name: string) {
  const agent = res(await run('agent.create', { name, vendor: 'claude' })).agent_id as string;
  const task = res(await run('task.create', { title: name, text: name, scope: ['src/'], assignee_agent_id: agent })).task_id as string;
  const session = randomUUID();
  await executeCommand(db.pool, device, cmd('session.report', { session_id: session, status: 'working', task_id: task, worktree: `/w/${task}`, branch: `harness/task/${task}` }, agent));
  const add = (entries: unknown[], as = agent, dev = device) => executeCommand(db.pool, dev, cmd('readset.add', { session_id: session, entries }, as));
  return { agent, task, session, add };
}
const entries = async (task: string) =>
  (await db.pool.query('SELECT path, content_hash, source, confidence, range_start, range_lines, stale FROM read_entries WHERE task_id = $1 ORDER BY path', [task])).rows;

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_1', 'human_test', 'laptop')");
});
after(async () => { await db?.drop(); });

test('reads are recorded per task and path; repeats are silent; new content or a stronger capture updates the entry', async () => {
  const a = await worker('agent/reader');
  const first = await a.add([
    { path: 'src/types.ts', hash: H1, source: 'read_tool', confidence: 'high', range: { start: 1, lines: 40 } },
    { path: 'src/api.ts', hash: null, source: 'shell_heuristic', confidence: 'low' },
  ]);
  const ev = (await db.pool.query('SELECT kind, data FROM events WHERE project_id = $1 AND seq = ANY($2)', [project, first.seqs])).rows;
  assert.deepEqual(ev.map((e) => e.kind), ['readset.added']);
  assert.deepEqual(ev[0].data.entries.map((e: any) => e.path), ['src/api.ts', 'src/types.ts']);
  assert.deepEqual(await entries(a.task), [
    { path: 'src/api.ts', content_hash: null, source: 'shell_heuristic', confidence: 'low', range_start: null, range_lines: null, stale: false },
    { path: 'src/types.ts', content_hash: H1, source: 'read_tool', confidence: 'high', range_start: 1, range_lines: 40, stale: false },
  ]);
  const again = await a.add([{ path: 'src/types.ts', hash: H1, source: 'search_hit', confidence: 'medium' }]);
  assert.deepEqual(again.seqs, [], 'same content, weaker capture: nothing to log');
  assert.equal((await entries(a.task))[1].confidence, 'high', 'the stronger capture stays');
  const changed = await a.add([{ path: 'src/types.ts', hash: H2, source: 'search_hit', confidence: 'medium' }]);
  assert.equal(changed.seqs.length, 1, 'new content is a new read');
  assert.deepEqual((await entries(a.task))[1], { path: 'src/types.ts', content_hash: H2, source: 'search_hit', confidence: 'medium', range_start: null, range_lines: null, stale: false });
  // A stale entry re-read with the same content is fresh again, and logged (the agent has now seen it).
  await db.pool.query("UPDATE read_entries SET stale = true WHERE task_id = $1 AND path = 'src/types.ts'", [a.task]);
  assert.equal((await a.add([{ path: 'src/types.ts', hash: H2, source: 'read_tool', confidence: 'high' }])).seqs.length, 1);
  assert.deepEqual((await entries(a.task))[1].stale, false);
});

test('only harnessd, as the session\'s own agent, may report reads; inputs are validated', async () => {
  const a = await worker('agent/one');
  const b = await worker('agent/two');
  const ok = { path: 'src/x.ts', hash: H1, source: 'read_tool', confidence: 'high' };
  await rejects(executeCommand(db.pool, human, cmd('readset.add', { session_id: a.session, entries: [ok] }, a.agent)), 'forbidden');
  await rejects(a.add([ok], b.agent), 'forbidden');
  for (const bad of [
    { ...ok, path: '/etc/passwd' }, { ...ok, path: 'src/../x' }, { ...ok, path: 'a\nb' }, { ...ok, path: 'src/' },
    { ...ok, hash: 'abc' }, { ...ok, hash: 'not hex'.padEnd(40, 'z') }, { ...ok, source: 'guess' }, { ...ok, confidence: 'certain' },
    { ...ok, range: { start: 0, lines: 1 } },
  ]) await rejects(a.add([bad]), 'bad_request');
  await rejects(a.add([]), 'bad_request');
  await rejects(a.add(Array.from({ length: 201 }, (_, i) => ({ ...ok, path: `f${i}.ts` }))), 'bad_request');
});

test('reads end with the task: a finished task records nothing more', async () => {
  const a = await worker('agent/done');
  await run('task.complete', { task_id: a.task });
  const r = await a.add([{ path: 'src/x.ts', hash: H1, source: 'read_tool', confidence: 'high' }]);
  assert.deepEqual(r.seqs, []);
  assert.deepEqual(await entries(a.task), []);
});
