import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { executeCommand, CommandError } from '../src/commands.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
let project: string;
let agentA: string;
let agentB: string;
let taskA: string;
let taskB: string;
const human = { principal: 'human_test', deviceId: null };
const cmd = (name: string, args: Record<string, unknown>, asAgent?: string) =>
  ({ v: 1 as const, type: 'command' as const, command_id: randomUUID(), project_id: project, name, args, ...(asAgent ? { as_agent: asAgent } : {}) });
const run = (name: string, args: Record<string, unknown>, asAgent?: string) => executeCommand(db.pool, human, cmd(name, args, asAgent));
const rejects = (p: Promise<unknown>, code: string) => assert.rejects(p, (e) => e instanceof CommandError && e.code === code);
const id = (r: { result: unknown }, k: string) => (r.result as Record<string, string>)[k]!;

before(async () => {
  db = await freshSchema();
  project = await seedProject(db.pool);
  agentA = id(await run('agent.create', { name: 'agent/a', vendor: 'claude' }), 'agent_id');
  agentB = id(await run('agent.create', { name: 'agent/b', vendor: 'claude' }), 'agent_id');
  taskA = id(await run('task.create', { title: 'A', text: 'A', scope: ['src/api/'], assignee_agent_id: agentA }), 'task_id');
  taskB = id(await run('task.create', { title: 'B', text: 'B', scope: ['src/web/'], assignee_agent_id: agentB }), 'task_id');
});
after(async () => { await db?.drop(); });

test('a question by agent name, and its answer, are typed messages between the two tasks', async () => {
  const q = await run('message.send', { kind: 'question', to: 'agent/b', text: 'Is POST /login returning { token }?', about_paths: ['src/types.ts'] }, agentA);
  const qid = id(q, 'message_id');
  const ev = (await db.pool.query('SELECT kind, actor_principal, data FROM events WHERE project_id = $1 AND seq = $2', [project, q.seqs[0]])).rows[0];
  assert.equal(ev.kind, 'message.sent');
  assert.equal(ev.actor_principal, agentA);
  assert.deepEqual(ev.data, {
    message_id: qid, kind: 'question', from: agentA, to: agentB, text: 'Is POST /login returning { token }?', about_paths: ['src/types.ts'],
    priority: 'normal', from_task_id: taskA, to_task_id: taskB,
  });
  await rejects(run('message.send', { kind: 'answer', in_reply_to: qid, text: 'yes' }, agentA), 'forbidden'); // not asked of A
  const a = await run('message.send', { kind: 'answer', in_reply_to: qid, text: 'Yes, { token, user }.' }, agentB);
  const row = (await db.pool.query('SELECT kind, from_principal, to_principal, in_reply_to FROM messages WHERE id = $1', [id(a, 'message_id')])).rows[0];
  assert.deepEqual(row, { kind: 'answer', from_principal: agentB, to_principal: agentA, in_reply_to: qid });
  await rejects(run('message.send', { kind: 'answer', in_reply_to: qid, text: 'again' }, agentB), 'conflict');
});

test('only typed kinds, capped text, and real recipients (D-24, Q-05)', async () => {
  await rejects(run('message.send', { kind: 'chat', to: 'agent/b', text: 'hi' }, agentA), 'bad_request');
  await rejects(run('message.send', { kind: 'claim_conflict', to: 'agent/b', text: 'hi' }, agentA), 'bad_request');
  await rejects(run('message.send', { kind: 'question', to: 'agent/b', text: 'x'.repeat(501) }, agentA), 'bad_request');
  await rejects(run('message.send', { kind: 'question', to: 'agent/nobody', text: 'hi' }, agentA), 'not_found');
  await rejects(run('message.send', { kind: 'question', to: 'agent/a', text: 'hi' }, agentA), 'bad_request');
  await rejects(run('message.send', { kind: 'answer', in_reply_to: 'msg_nope', text: 'hi' }, agentA), 'not_found');
});
