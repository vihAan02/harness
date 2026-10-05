import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
let agentA: string;
let agentB: string;
const human = { principal: 'human_test', deviceId: null };
const cmd = (name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (name: string, args: Record<string, unknown>, asAgent?: string) => executeCommand(db.pool, human, cmd(name, args, asAgent));
const rejects = (p: Promise<unknown>, code: string, re?: RegExp) =>
  assert.rejects(p, (e) => e instanceof CommandError && e.code === code && (!re || re.test(e.message)));
const kinds = async (seqs: number[]) =>
  (await db.pool.query('SELECT kind, data FROM events WHERE project_id = $1 AND seq = ANY($2) ORDER BY seq', [project, seqs])).rows;

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  agentA = ((await run('agent.create', { name: 'agent/a', vendor: 'claude' })).result as { agent_id: string }).agent_id;
  agentB = ((await run('agent.create', { name: 'agent/b', vendor: 'claude' })).result as { agent_id: string }).agent_id;
});
after(async () => { await db?.drop(); });

test('task.create: readable ids, normalized scope, and assignment in one step', async () => {
  const out = await run('task.create', { title: 'Login API', text: 'Build POST /login.', scope: ['src/api/**', 'src/types.ts', 'src/api/'], assignee_agent_id: agentA });
  const id = (out.result as { task_id: string }).task_id;
  assert.match(id, /^T-\d+$/);
  const evs = await kinds(out.seqs);
  assert.deepEqual(evs.map((e) => e.kind), ['task.created', 'task.assigned', 'claim.prospective']);
  assert.deepEqual(evs[0].data.scope, ['src/api/', 'src/types.ts']);
  const row = (await db.pool.query('SELECT status, assignee_agent_id, owner_human_id FROM tasks WHERE id = $1', [id])).rows[0];
  assert.deepEqual(row, { status: 'in_progress', assignee_agent_id: agentA, owner_human_id: 'human_test' });
});

test('task.create rejects scopes that are not plain relative paths, and agents may not create tasks', async () => {
  for (const scope of [['/etc/'], ['../up/'], ['src/*.ts'], ['src//x'], ['./src/']]) {
    await rejects(run('task.create', { title: 't', text: 't', scope }), 'bad_request', /scope entry/);
  }
  await rejects(run('task.create', { title: 't', text: 't', scope: [] }, agentA), 'forbidden', /human-led/);
});

test('assign, complete and abandon follow the lifecycle (D-54)', async () => {
  const id = ((await run('task.create', { title: 'UI', text: 'Login page', scope: ['src/web/'] })).result as { task_id: string }).task_id;
  await rejects(run('task.assign', { task_id: id, assignee_agent_id: agentB }, agentA), 'forbidden');
  assert.deepEqual((await kinds((await run('task.assign', { task_id: id, assignee_agent_id: agentB })).seqs)).map((e) => e.kind), ['task.assigned']);
  await rejects(run('task.assign', { task_id: id, assignee_agent_id: agentA }), 'conflict');
  await rejects(run('task.complete', { task_id: id }, agentA), 'forbidden', /isn't assigned/);
  const done = await run('task.complete', { task_id: id, summary: 'Built the page' }, agentB);
  const [ev] = await kinds(done.seqs);
  assert.deepEqual(ev.data, { task_id: id, summary: 'Built the page', by: agentB });
  await rejects(run('task.complete', { task_id: id }), 'conflict');
  const other = ((await run('task.create', { title: 'x', text: 'x', scope: [] })).result as { task_id: string }).task_id;
  await rejects(run('task.abandon', { task_id: other, reason: 'no' }, agentA), 'forbidden');
  await run('task.abandon', { task_id: other, reason: 'not needed' });
  assert.equal((await db.pool.query('SELECT status FROM tasks WHERE id = $1', [other])).rows[0].status, 'abandoned');
});

test('task.reopen sends a done task back to its agent with a message: only done and unlanded, no land in flight, its agent free, humans only (D-107)', async () => {
  const agent = ((await run('agent.create', { name: 'agent/r', vendor: 'claude' })).result as { agent_id: string }).agent_id;
  const id = ((await run('task.create', { title: 'API', text: 'Change the login response.', scope: ['src/api/'], assignee_agent_id: agent })).result as { task_id: string }).task_id;
  await rejects(run('task.reopen', { task_id: id, text: 'x' }), 'conflict', /in_progress; only a done task/);
  await run('task.complete', { task_id: id }, agent);
  await rejects(run('task.reopen', { task_id: id, text: 'x' }, agent), 'forbidden');
  await rejects(run('task.reopen', { task_id: id }), 'bad_request', /text/);
  // A land in flight must be cancelled first.
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_r', 'human_test', 'laptop') ON CONFLICT DO NOTHING");
  await db.pool.query("INSERT INTO lands (id, project_id, task_id, device_id, requested_by, status, run_tests) VALUES ('land_r', $1, $2, 'dev_r', 'human_test', 'requested', true)", [project, id]);
  await rejects(run('task.reopen', { task_id: id, text: 'x' }), 'conflict', /being landed/);
  await db.pool.query("UPDATE lands SET status = 'failed', reason = 'tests' WHERE id = 'land_r'");
  // Its agent is busy with another task meanwhile.
  const busy = ((await run('task.create', { title: 'B', text: 'b', scope: [], assignee_agent_id: agent })).result as { task_id: string }).task_id;
  await rejects(run('task.reopen', { task_id: id, text: 'x' }), 'conflict', /already working on/);
  await run('task.abandon', { task_id: busy, reason: 'out of the way' });
  const r = await run('task.reopen', { task_id: id, text: 'The land failed: tsc says src/client/api.ts reads .token.' });
  const evs = await kinds(r.seqs);
  assert.deepEqual(evs.map((e) => e.kind), ['task.reopened', 'claim.prospective'], 'its scope is claimed again');
  assert.deepEqual(evs[0].data, { task_id: id, assignee_agent_id: agent, text: 'The land failed: tsc says src/client/api.ts reads .token.', by: 'human_test' });
  assert.deepEqual((await db.pool.query('SELECT status, completed_at FROM tasks WHERE id = $1', [id])).rows[0], { status: 'in_progress', completed_at: null });
  await rejects(run('task.reopen', { task_id: id, text: 'x' }), 'conflict', /in_progress/);
  // Landed and abandoned tasks stay closed.
  await run('task.complete', { task_id: id }, agent);
  await db.pool.query("UPDATE tasks SET status = 'landed' WHERE id = $1", [id]);
  await rejects(run('task.reopen', { task_id: id, text: 'x' }), 'conflict', /landed/);
});
