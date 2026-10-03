import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import { overlaps } from '../src/claims.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
const human = { principal: 'human_test', deviceId: null };
const device = { principal: 'human_test', deviceId: 'dev_1' };
const cmd = (name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (name: string, args: Record<string, unknown>) => executeCommand(db.pool, human, cmd(name, args));
const res = (r: { result: unknown }) => r.result as Record<string, any>;
const events = async (seqs: number[]) =>
  (await db.pool.query('SELECT kind, data FROM events WHERE project_id = $1 AND seq = ANY($2) ORDER BY seq', [project, seqs])).rows as { kind: string; data: any }[];

/** An agent with an assigned task and a running session on dev_1. */
async function worker(name: string, scope: string[]) {
  const agent = res(await run('agent.create', { name, vendor: 'claude' })).agent_id as string;
  const created = await run('task.create', { title: name, text: name, scope, assignee_agent_id: agent });
  const task = res(created).task_id as string;
  const session = randomUUID();
  await executeCommand(db.pool, device, cmd('session.report', { session_id: session, status: 'working', task_id: task, worktree: `/w/${task}`, branch: `harness/task/${task}` }, agent));
  const observe = async (paths: string[], source: 'hook' | 'diff' = 'hook') =>
    executeCommand(db.pool, device, cmd('claim.observe', { session_id: session, paths, source }, agent));
  return { agent, task, session, observe, created };
}

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_1', 'human_test', 'laptop')");
});
after(async () => { await db?.drop(); });

test('the overlap rule: prefixes cover what is under them; files cover themselves (coordination §1)', () => {
  assert.ok(overlaps('src/', 'src/a.ts'));
  assert.ok(overlaps('src/a.ts', 'src/'));
  assert.ok(overlaps('src/', 'src/api/'));
  assert.ok(overlaps('src/a.ts', 'src/a.ts'));
  assert.ok(!overlaps('src/a.ts', 'src/a.tsx'));
  assert.ok(!overlaps('src/api/', 'src/apiv2/'));
  assert.ok(!overlaps('src/web/', 'src/api/x.ts'));
});

test('scopes become prospective claims; overlapping scopes are reported to the human only', async () => {
  const a = await worker('agent/scope-a', ['lib/', 'lib2/x.ts']);
  assert.deepEqual((await events(a.created.seqs)).map((e) => e.kind), ['task.created', 'task.assigned', 'claim.prospective']);
  const b = await worker('agent/scope-b', ['lib/util/', 'other/']);
  assert.deepEqual(res(b.created).overlaps, [{ task_id: a.task, paths: ['lib/util/'] }]);
  const evs = await events(b.created.seqs);
  assert.deepEqual(evs.filter((e) => e.kind === 'overlap.detected').map((e) => [e.data.level, e.data.paths, e.data.tasks]), [['prospective', ['lib/util/'], [b.task, a.task]]]);
  assert.equal(evs.filter((e) => e.kind === 'message.sent').length, 0, 'agents are not nagged about scope overlaps');
});

test('an edit inside another task\'s territory warns both agents once, with a high-priority claim_conflict', async () => {
  const api = await worker('agent/api', ['src/api/', 'src/types.ts']);
  const web = await worker('agent/web', ['src/web/']);
  const first = await web.observe(['src/web/Login.tsx']);
  assert.deepEqual((await events(first.seqs)).map((e) => e.kind), ['claim.observed']);

  const hit = await web.observe(['src/types.ts', 'src/web/Login.tsx']);
  assert.deepEqual(res(hit), { added: ['src/types.ts'], cleared: [] });
  const evs = await events(hit.seqs);
  assert.deepEqual(evs.map((e) => e.kind), ['claim.observed', 'overlap.detected', 'message.sent', 'message.sent']);
  assert.deepEqual([evs[1]!.data.level, evs[1]!.data.paths, evs[1]!.data.tasks, evs[1]!.data.claim_kinds], ['observed', ['src/types.ts'], [web.task, api.task], ['prospective']]);
  const [toWeb, toApi] = [evs[2]!.data, evs[3]!.data];
  assert.deepEqual([toWeb.kind, toWeb.from, toWeb.to, toWeb.priority, toWeb.other_task], ['claim_conflict', 'harness', web.agent, 'high', api.task]);
  assert.equal(toWeb.text, `src/types.ts: this file is in the scope of agent/api (task ${api.task}).`);
  assert.deepEqual([toApi.to, toApi.other_task, toApi.text], [api.agent, web.task, `src/types.ts: agent/web (task ${web.task}) is also changing this file.`]);

  // Observed × observed: the API agent edits the same file. Already warned for this pair and path: no repeat.
  const again = await api.observe(['src/types.ts']);
  assert.deepEqual((await events(again.seqs)).map((e) => e.kind), ['claim.observed']);
});

test('a diff report is the full set: files that no longer differ stop being claimed (D-70)', async () => {
  const w = await worker('agent/diff', ['pkg/']);
  await w.observe(['pkg/a.ts', 'pkg/b.ts'], 'hook');
  const d = await w.observe(['pkg/b.ts', 'pkg/bg.ts'], 'diff');
  assert.deepEqual(res(d), { added: ['pkg/bg.ts'], cleared: ['pkg/a.ts'] });
  assert.deepEqual((await events(d.seqs)).map((e) => [e.kind, e.data.paths]), [['claim.observed', ['pkg/bg.ts']], ['claim.cleared', ['pkg/a.ts']]]);
  const quiet = await w.observe(['pkg/b.ts', 'pkg/bg.ts'], 'diff');
  assert.deepEqual(quiet.seqs, [], 'nothing changed, nothing logged');
});

test('claims end with the task, and a finished task warns no one', async () => {
  const x = await worker('agent/x', ['shared/']);
  await x.observe(['shared/x.ts']);
  const done = await executeCommand(db.pool, human, cmd('task.complete', { task_id: x.task }));
  assert.deepEqual((await events(done.seqs)).map((e) => [e.kind, e.data.claim_kind]), [['task.completed', undefined], ['claim.cleared', 'prospective'], ['claim.cleared', 'observed']]);
  const y = await worker('agent/y', ['other2/']);
  const hit = await y.observe(['shared/x.ts']);
  assert.deepEqual((await events(hit.seqs)).map((e) => e.kind), ['claim.observed']);
  const late = await x.observe(['shared/late.ts']);
  assert.deepEqual(late.seqs, [], 'reports for a finished task are ignored');
});

test('claim.observe only from the session\'s own agent and device, with normalized paths', async () => {
  const z = await worker('agent/z', ['z/']);
  const other = res(await run('agent.create', { name: 'agent/other', vendor: 'claude' })).agent_id;
  const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);
  await rejects(executeCommand(db.pool, device, cmd('claim.observe', { session_id: z.session, paths: ['z/a'], source: 'hook' }, other)), 'forbidden');
  await rejects(executeCommand(db.pool, human, cmd('claim.observe', { session_id: z.session, paths: ['z/a'], source: 'hook' }, z.agent)), 'forbidden');
  for (const bad of ['/etc/passwd', '../x', 'z/../../x', 'z/']) await rejects(z.observe([bad]), 'bad_request');
});
