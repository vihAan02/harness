import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
let agentA: string;
let agentB: string;
before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_1', 'human_test', 'laptop')");
  const human = { principal: 'human_test', deviceId: null };
  const mk = async (name: string) => ((await executeCommand(db.pool, human, cmd('agent.create', { name, vendor: 'claude' }))).result as { agent_id: string }).agent_id;
  agentA = await mk('agent/a');
  agentB = await mk('agent/b');
  await db.pool.query("INSERT INTO tasks (id, project_id, title, text, scope, owner_human_id, assignee_agent_id) VALUES ('t1', $1, 't', 't', '{src/}', 'human_test', $2)", [project, agentA]);
});
after(async () => { await db?.drop(); });

const device = { principal: 'human_test', deviceId: 'dev_1' };
function cmd(name: string, args: Record<string, unknown>, asAgent?: string) {
  return { v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args, ...(asAgent ? { as_agent: asAgent } : {}) };
}
const start = (id: string, agent = agentA) =>
  cmd('session.report', { session_id: id, status: 'starting', task_id: 't1', worktree: '/w/t1', branch: 'harness/task/t1' }, agent);
const kindsOf = async (seqs: number[]) =>
  (await db.pool.query('SELECT kind FROM events WHERE project_id = $1 AND seq = ANY($2) ORDER BY seq', [project, seqs])).rows.map((r) => r.kind);
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);

test('a session starts, changes status, reports usage and ends, as events of the agent', async () => {
  const id = randomUUID();
  assert.deepEqual(await kindsOf((await executeCommand(db.pool, device, start(id))).seqs), ['session.started']);
  const working = await executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'working', vendor_version: '2.1.287' }, agentA));
  assert.deepEqual(await kindsOf(working.seqs), ['session.status']);
  const same = await executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'working' }, agentA));
  assert.deepEqual(same.seqs, [], 'no event when nothing changed');
  const usage = { input: 10, output: 2, cache_read: 0, cache_creation: 0, cost_usd: 0.01 };
  const idle = await executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'idle', usage }, agentA));
  assert.deepEqual(await kindsOf(idle.seqs), ['session.status', 'usage.reported']);
  const ended = await executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'ended', reason: 'stopped' }, agentA));
  assert.deepEqual(await kindsOf(ended.seqs), ['session.ended']);
  const row = (await db.pool.query('SELECT status, vendor_version, ended_at IS NOT NULL AS ended FROM agent_sessions WHERE id = $1', [id])).rows[0];
  assert.deepEqual(row, { status: 'ended', vendor_version: '2.1.287', ended: true });
  const actor = (await db.pool.query('SELECT actor_principal, on_behalf_of, device_id FROM events WHERE project_id = $1 AND seq = $2', [project, ended.seqs[0]])).rows[0];
  assert.deepEqual(actor, { actor_principal: agentA, on_behalf_of: 'human_test', device_id: 'dev_1' });
  await rejects(executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'idle' }, agentA)), 'conflict');
});

test('only harnessd reports sessions, only for the assigned agent, and only its own', async () => {
  await rejects(executeCommand(db.pool, { principal: 'human_test', deviceId: null }, start(randomUUID())), 'forbidden');
  await rejects(executeCommand(db.pool, device, { ...start(randomUUID()), as_agent: undefined } as never), 'bad_request');
  await rejects(executeCommand(db.pool, device, start(randomUUID(), agentB)), 'forbidden'); // t1 is agent A's
  const id = randomUUID();
  await executeCommand(db.pool, device, start(id));
  await rejects(executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'idle' }, agentB)), 'forbidden');
  await rejects(executeCommand(db.pool, device, cmd('session.report', { session_id: randomUUID(), status: 'idle' }, agentA)), 'bad_request');
  await rejects(executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'idle', usage: { input: -1 } }, agentA)), 'bad_request');
  await executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'ended' }, agentA)); // one live session per task (D-113)
});

test('a session records its configured model and provider, and usage says which models and prices it counted (D-87)', async () => {
  const id = randomUUID();
  const r = await executeCommand(db.pool, device, cmd('session.report', {
    session_id: id, status: 'starting', task_id: 't1', worktree: '/w/t1', branch: 'harness/task/t1', model: 'deepseek-flash[1m]', provider: 'deepseek',
  }, agentA));
  const ev = (await db.pool.query('SELECT data FROM events WHERE project_id = $1 AND seq = $2', [project, r.seqs[0]])).rows[0].data;
  assert.equal(ev.model, 'deepseek-flash[1m]');
  assert.equal(ev.provider, 'deepseek');
  const row = (await db.pool.query('SELECT model, provider FROM agent_sessions WHERE id = $1', [id])).rows[0];
  assert.deepEqual(row, { model: 'deepseek-flash[1m]', provider: 'deepseek' });
  const usage = { input: 10, output: 2, cache_read: 0, cache_creation: 0, cost_usd: 0.0001, cost_basis: 'config', models: ['deepseek-flash[1m]'] };
  const u = await executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'idle', usage }, agentA));
  const uev = (await db.pool.query("SELECT data FROM events WHERE project_id = $1 AND seq = ANY($2) AND kind = 'usage.reported'", [project, u.seqs])).rows[0].data;
  assert.equal(uev.cost_basis, 'config');
  assert.deepEqual(uev.models, ['deepseek-flash[1m]']);
  await rejects(executeCommand(db.pool, device, cmd('session.report', { session_id: randomUUID(), status: 'starting', task_id: 't1', worktree: '/w/t1', branch: 'b', model: '--evil' }, agentA)), 'bad_request');
  await rejects(executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'idle', usage: { ...usage, cost_basis: 'made-up' } }, agentA)), 'bad_request');
  await executeCommand(db.pool, device, cmd('session.report', { session_id: id, status: 'ended' }, agentA));
});
