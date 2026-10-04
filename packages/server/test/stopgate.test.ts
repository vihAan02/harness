// stop_gate.report (D-100): harnessd tells the server that an agent's Stop gate reached its cap with notices
// still waiting, and the event log is how the human hears about it.
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
const res = (r: { result: unknown }) => r.result as Record<string, any>;
const rejects = (p: Promise<unknown>, code: string, re?: RegExp) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code && (!re || re.test(e.message)));

async function worker(name: string) {
  const agent = res(await executeCommand(db.pool, human, cmd('agent.create', { name, vendor: 'claude' }))).agent_id as string;
  const task = res(await executeCommand(db.pool, human, cmd('task.create', { title: name, text: name, scope: [], assignee_agent_id: agent }))).task_id as string;
  const session = randomUUID();
  await executeCommand(db.pool, device, cmd('session.report', { session_id: session, status: 'working', task_id: task, worktree: `/w/${task}`, branch: `harness/task/${task}` }, agent));
  return { agent, task, session };
}

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_1', 'human_test', 'laptop'), ('dev_2', 'human_test', 'desktop')");
});
after(async () => { await db?.drop(); });

test('a capped Stop gate is logged for the human, with the task and how many notices are waiting', async () => {
  const a = await worker('agent/sg1');
  await executeCommand(db.pool, device, cmd('stop_gate.report', { session_id: a.session, pending: 2 }, a.agent));
  const logged = (await db.pool.query("SELECT data FROM events WHERE project_id = $1 AND kind = 'stop_gate.capped'", [project])).rows.map((r) => r.data);
  assert.deepEqual(logged, [{ task_id: a.task, agent_id: a.agent, session_id: a.session, pending: 2 }]);
});

test('only the agent\'s own harnessd reports it, for its own session, with a real count', async () => {
  const a = await worker('agent/sg2');
  const b = await worker('agent/sg3');
  await rejects(executeCommand(db.pool, human, cmd('stop_gate.report', { session_id: a.session, pending: 1 }, a.agent)), 'forbidden');
  await rejects(executeCommand(db.pool, device, cmd('stop_gate.report', { session_id: a.session, pending: 1 })), 'bad_request', /as the agent/);
  await rejects(executeCommand(db.pool, device, cmd('stop_gate.report', { session_id: a.session, pending: 1 }, b.agent)), 'forbidden', /another agent/);
  await rejects(executeCommand(db.pool, { ...device, deviceId: 'dev_2' }, cmd('stop_gate.report', { session_id: a.session, pending: 1 }, a.agent)), 'forbidden', /another agent or device/);
  await rejects(executeCommand(db.pool, device, cmd('stop_gate.report', { session_id: randomUUID(), pending: 1 }, a.agent)), 'not_found');
  for (const pending of [0, 1.5, -1, '2', undefined, 10_001]) {
    await rejects(executeCommand(db.pool, device, cmd('stop_gate.report', { session_id: a.session, pending }, a.agent)), 'bad_request', /pending/);
  }
});
