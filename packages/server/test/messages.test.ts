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

test('a contract request goes to an agent and is answered like a question, once (D-105)', async () => {
  const c = await run('message.send', { kind: 'contract_request', to: 'agent/b', text: 'Define the response of POST /login.', about_paths: ['src/types.ts'] }, agentA);
  const cid = id(c, 'message_id');
  const row = (await db.pool.query('SELECT kind, from_principal, to_principal, from_task_id, to_task_id, priority FROM messages WHERE id = $1', [cid])).rows[0];
  assert.deepEqual(row, { kind: 'contract_request', from_principal: agentA, to_principal: agentB, from_task_id: taskA, to_task_id: taskB, priority: 'normal' });
  await rejects(run('message.send', { kind: 'contract_request', to: 'agent/a', text: 'me' }, agentA), 'bad_request');
  await rejects(run('message.send', { kind: 'answer', in_reply_to: cid, text: 'no' }, agentA), 'forbidden');
  const a = await run('message.send', { kind: 'answer', in_reply_to: cid, text: '{ token: string }' }, agentB);
  assert.equal((await db.pool.query('SELECT to_principal FROM messages WHERE id = $1', [id(a, 'message_id')])).rows[0].to_principal, agentA);
  await rejects(run('message.send', { kind: 'answer', in_reply_to: cid, text: 'again' }, agentB), 'conflict');
});

test('task_blocked from an agent goes to its task\'s owner, says what blocks it, and counts only as sent (D-105)', async () => {
  const sentBefore = (await db.pool.query('SELECT messages_sent, messages_received FROM budgets WHERE task_id = $1', [taskB])).rows[0] ?? { messages_sent: 0, messages_received: 0 };
  const r = await run('message.send', { kind: 'task_blocked', text: 'I need the token format decided.', blocked_on: { kind: 'agent', id: 'agent/a' } }, agentB);
  const ev = (await db.pool.query('SELECT data FROM events WHERE project_id = $1 AND seq = $2', [project, r.seqs[0]])).rows[0].data;
  assert.deepEqual(ev, {
    message_id: id(r, 'message_id'), kind: 'task_blocked', from: agentB, to: 'human_test', text: 'I need the token format decided.',
    reason: 'agent_report', blocked_on: { kind: 'agent', id: agentA }, priority: 'normal', from_task_id: taskB, to_task_id: taskB,
  });
  const after = (await db.pool.query('SELECT messages_sent, messages_received FROM budgets WHERE task_id = $1', [taskB])).rows[0];
  assert.deepEqual(after, { messages_sent: sentBefore.messages_sent + 1, messages_received: sentBefore.messages_received }, 'the task it is about is the sender\'s own');
  // On a task, or a question or contract request; checked against the project.
  const q = id(await run('message.send', { kind: 'question', to: 'agent/a', text: 'Token format?' }, agentB), 'message_id');
  await run('message.send', { kind: 'task_blocked', text: 'Waiting for the answer.', blocked_on: { kind: 'question', id: q } }, agentB);
  await run('message.send', { kind: 'task_blocked', text: 'Waiting for A.', blocked_on: { kind: 'task', id: taskA } }, agentB);
  await rejects(run('message.send', { kind: 'task_blocked', text: 'x', blocked_on: { kind: 'task', id: 'T-999' } }, agentB), 'not_found');
  await rejects(run('message.send', { kind: 'task_blocked', text: 'x', blocked_on: { kind: 'file', id: 'x' } }, agentB), 'bad_request');
  await rejects(run('message.send', { kind: 'task_blocked', text: 'x', blocked_on: { kind: 'agent', id: 'agent/nobody' } }, agentB), 'not_found');
  // The server picks the recipient, and only an agent working on a task reports it blocked.
  await rejects(run('message.send', { kind: 'task_blocked', to: 'agent/a', text: 'x' }, agentB), 'bad_request');
  await rejects(run('message.send', { kind: 'task_blocked', text: 'x' }), 'bad_request');
});

test('budgets: the 11th peer message from a task is held and reported, never counted (Q-05)', async () => {
  const c = id(await run('agent.create', { name: 'agent/c', vendor: 'claude' }), 'agent_id');
  const d = id(await run('agent.create', { name: 'agent/d', vendor: 'claude' }), 'agent_id');
  const tC = id(await run('task.create', { title: 'C', text: 'C', scope: [], assignee_agent_id: c }), 'task_id');
  const tD = id(await run('task.create', { title: 'D', text: 'D', scope: [], assignee_agent_id: d }), 'task_id');
  for (let i = 0; i < 10; i++) await run('message.send', { kind: 'question', to: 'agent/d', text: `q${i}` }, c);
  const over = await run('message.send', { kind: 'question', to: 'agent/d', text: 'one too many' }, c);
  assert.deepEqual((over.result as Record<string, unknown>).held, true);
  const evs = (await db.pool.query('SELECT kind, data FROM events WHERE project_id = $1 AND seq = ANY($2) ORDER BY seq', [project, over.seqs])).rows;
  assert.deepEqual(evs.map((e) => [e.kind, e.data.held ?? e.data.direction]), [['message.sent', true], ['budget.exceeded', 'sent'], ['budget.exceeded', 'received']]);
  const b = (await db.pool.query('SELECT task_id, messages_sent, messages_received FROM budgets WHERE task_id = ANY($1) ORDER BY task_id', [[tC, tD]])).rows;
  assert.deepEqual(b, [{ task_id: tC, messages_sent: 10, messages_received: 0 }, { task_id: tD, messages_sent: 0, messages_received: 10 }]);
});

test('message.ack: only harnessd, only for the recipient, once; records where it landed and its latency (D-26)', async () => {
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_ack', 'human_test', 'laptop') ON CONFLICT DO NOTHING");
  const device: { principal: string; deviceId: string | null } = { principal: 'human_test', deviceId: 'dev_ack' };
  const qid = id(await run('message.send', { kind: 'question', to: 'agent/b', text: 'ack me' }, agentA), 'message_id');
  const ack = (as: string, extra: Record<string, unknown> = {}, caller = device) =>
    executeCommand(db.pool, caller, cmd('message.ack', { message_id: qid, delivered_at: new Date().toISOString(), delivery: 'between_tools', est_tokens: 42, ...extra }, as));
  await rejects(ack(agentA), 'forbidden'); // not the recipient
  await rejects(ack(agentB, {}, human), 'forbidden'); // not harnessd
  await rejects(ack(agentB, { delivery: 'whenever' }), 'bad_request');
  const ok = await ack(agentB);
  const ev = (await db.pool.query('SELECT kind, data FROM events WHERE project_id = $1 AND seq = $2', [project, ok.seqs[0]])).rows[0];
  assert.equal(ev.kind, 'message.delivered');
  assert.deepEqual([ev.data.message_id, ev.data.delivery, ev.data.to_task_id, ev.data.est_tokens], [qid, 'between_tools', taskB, 42]);
  assert.ok(ev.data.latency_ms >= 0);
  assert.deepEqual((await ack(agentB)).seqs, [], 'a repeated ack changes nothing');
  const row = (await db.pool.query('SELECT delivery, delivered_at IS NOT NULL AS done FROM messages WHERE id = $1', [qid])).rows[0];
  assert.deepEqual(row, { delivery: 'between_tools', done: true });
});
