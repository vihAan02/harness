// The agent tool shim's composition (D-94): the 0A tools plus each 0B module's, every module pinned to
// its own names, so the model is offered exactly HARNESS_TOOL_NAMES (the shim test checks the session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_TOOL_NAMES, HARNESS_TOOL_NAMES, harnessTools, type ToolContext } from '../src/tools.ts';
import { commandCall } from '../src/tools/common.ts';
import { LEASE_TOOL_NAMES, leaseTools } from '../src/tools/leases.ts';
import { MESSAGE_TOOL_NAMES, messageTools } from '../src/tools/messages.ts';
import { WAIT_TOOL_NAMES, waitOutcomeText, waitTools } from '../src/tools/waits.ts';
import { ProjectView } from '../src/view.ts';

const ctx: ToolContext = { view: new ProjectView('prj'), agentId: 'agent_a', taskId: 'T-1', send: async () => ({ message_id: 'msg_1' }), timeoutMs: 50 };

test('the tools are the 0A four plus each module\'s pinned names, in order, with no duplicates', () => {
  assert.deepEqual([...CORE_TOOL_NAMES], ['harness_status', 'ask', 'answer', 'report_done']);
  assert.deepEqual(harnessTools(ctx).map((t) => t.name), [...HARNESS_TOOL_NAMES]);
  const call = commandCall(ctx);
  assert.deepEqual(leaseTools(ctx, call).map((t) => t.name), [...LEASE_TOOL_NAMES]);
  assert.deepEqual(messageTools(ctx, call).map((t) => t.name), [...MESSAGE_TOOL_NAMES]);
  assert.deepEqual(waitTools(ctx, call).map((t) => t.name), [...WAIT_TOOL_NAMES]);
  assert.equal(new Set(HARNESS_TOOL_NAMES).size, HARNESS_TOOL_NAMES.length);
});

test('a tool call that the server doesn\'t answer in time says it is queued; a failure is an error result, never a throw', async () => {
  const slow = commandCall({ ...ctx, send: () => new Promise(() => {}) });
  assert.deepEqual(await slow('task.complete', {}, () => 'ok'), {
    text: 'The coordination server did not answer in time. The request is queued and will be sent when it reconnects; don\'t send it again.', isError: true,
  });
  const failing = commandCall({ ...ctx, send: async () => { throw new Error('boom'); } });
  assert.deepEqual(await failing('task.complete', {}, () => 'ok'), { text: 'harness error: boom', isError: true });
  const ok = commandCall(ctx);
  assert.deepEqual(await ok('message.send', {}, (r) => `sent ${(r as { message_id: string }).message_id}`), { text: 'sent msg_1' });
});

test('wait_for starts a wait for this session and says whether to end the turn (D-95, D-101)', async () => {
  const sent: [string, Record<string, unknown>][] = [];
  const reply = (r: unknown) => async (name: string, args: Record<string, unknown>) => { sent.push([name, args]); return r; };
  const tool = (send: ToolContext['send'], over: Partial<ToolContext> = {}) => waitTools({ ...ctx, sessionId: 'sess-1', send, ...over }, commandCall({ ...ctx, send })).find((t) => t.name === 'wait_for')!;
  const waiting = await tool(reply({ wait_id: 'wait_1', outcome: 'waiting' })).run({ kind: 'answer', id: 'msg_q', timeout_s: 30 });
  assert.deepEqual(sent.at(-1), ['wait.start', { session_id: 'sess-1', on: { kind: 'answer', id: 'msg_q' }, timeout_s: 30 }]);
  assert.equal(waiting.text, 'Waiting (wait_id wait_1). End your turn now. The harness starts your next turn when it happens, or after 30 seconds if it doesn\'t.');
  const done = await tool(reply({ wait_id: 'wait_2', outcome: 'resolved', result: { status: 'landed' } })).run({ kind: 'task', id: 'T-2' });
  assert.deepEqual(sent.at(-1), ['wait.start', { session_id: 'sess-1', on: { kind: 'task', id: 'T-2' } }], 'no timeout: the server\'s default');
  assert.equal(done.text, 'It has already happened: the task is landed. Carry on.');
  assert.deepEqual(await tool(reply(null)).run({ kind: 'file', id: 'x' }), { text: 'kind must be one of: answer, task, lease', isError: true });
  assert.deepEqual(await tool(reply(null), { sessionId: undefined }).run({ kind: 'task', id: 'T-2' }), { text: 'harness error: this session can\'t wait', isError: true });
  assert.equal(sent.length, 2, 'a refused call sends nothing');
});

test('a settled wait\'s outcome, in words', () => {
  const w = { startedAt: '2026-10-04T10:00:00.000Z', timeoutAt: '2026-10-04T10:02:00.000Z' };
  assert.equal(waitOutcomeText({ ...w, on: { kind: 'answer', id: 'msg_q' }, outcome: 'resolved', result: { answer_id: 'msg_a' } }),
    'Your wait for the answer to msg_q is over: the answer arrived (msg_a); it reaches you as a harness message.');
  assert.equal(waitOutcomeText({ ...w, on: { kind: 'lease', id: 'lease_1' }, outcome: 'resolved', result: { lease: 'expired' } }),
    'Your wait for lease lease_1 to free up is over: the lease expired.');
  assert.equal(waitOutcomeText({ ...w, on: { kind: 'task', id: 'T-3' }, outcome: 'timed_out' }),
    'Your wait for task T-3 to finish timed out after 120 seconds without it happening, and your human has been told. You can carry on without it, or wait again.');
});

test('request_contract and report_blocked send the 0B kinds; report_blocked goes to the owner and names what blocks it (D-105)', async () => {
  const sent: [string, Record<string, unknown>][] = [];
  const view = new ProjectView('prj');
  view.apply({ v: 1, type: 'event', project_id: 'prj', seq: 1, at: new Date(0).toISOString(), actor: { principal: 'human_a', on_behalf_of: null, device_id: null },
    kind: 'task.created', data: { task_id: 'T-1', title: 'A', text: 'x', scope: [], priority: 0, owner_human_id: 'human_a' } });
  const send: ToolContext['send'] = async (name, args) => { sent.push([name, args]); return { message_id: 'msg_0123456789abcdef' }; };
  const tools = messageTools({ ...ctx, view, send }, commandCall({ ...ctx, send }));
  const tool = (name: string) => tools.find((t) => t.name === name)!;

  const req = await tool('request_contract').run({ to: 'agent/backend', contract: 'The response of POST /login', about_paths: ['src/types.ts'] });
  assert.deepEqual(sent.at(-1), ['message.send', { kind: 'contract_request', to: 'agent/backend', text: 'The response of POST /login', about_paths: ['src/types.ts'] }]);
  assert.equal(req.text, 'Sent. request_id: msg_0123456789abcdef. The reply will arrive as a harness message.');

  const blocked = await tool('report_blocked').run({ reason: 'I need the API shape first.', on: 'agent/backend' });
  assert.deepEqual(sent.at(-1), ['message.send', { kind: 'task_blocked', text: 'I need the API shape first.', blocked_on: { kind: 'agent', id: 'agent/backend' } }]);
  assert.equal(blocked.text, 'Reported to human/human_a: T-1 is blocked. It stays in progress.');
  await tool('report_blocked').run({ reason: 'Waiting on T-3 to land.', on: 'T-3' });
  assert.deepEqual(sent.at(-1)![1].blocked_on, { kind: 'task', id: 'T-3' });
  await tool('report_blocked').run({ reason: 'No answer.', on: 'msg_0123456789abcdef' });
  assert.deepEqual(sent.at(-1)![1].blocked_on, { kind: 'question', id: 'msg_0123456789abcdef' });
  await tool('report_blocked').run({ reason: 'I need a decision on the schema.' });
  assert.deepEqual(sent.at(-1), ['message.send', { kind: 'task_blocked', text: 'I need a decision on the schema.' }], 'on is optional');
  const n = sent.length;
  assert.equal((await tool('report_blocked').run({ reason: 'x', on: '../etc/passwd' })).isError, true);
  assert.equal(sent.length, n, 'an unreadable `on` sends nothing');
});
