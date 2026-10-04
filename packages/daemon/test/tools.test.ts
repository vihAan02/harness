// The agent tool shim's composition (D-94): the 0A tools plus each 0B module's, every module pinned to
// its own names, so the model is offered exactly HARNESS_TOOL_NAMES (the shim test checks the session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_TOOL_NAMES, HARNESS_TOOL_NAMES, harnessTools, type ToolContext } from '../src/tools.ts';
import { commandCall } from '../src/tools/common.ts';
import { LEASE_TOOL_NAMES, leaseTools } from '../src/tools/leases.ts';
import { MESSAGE_TOOL_NAMES, messageTools } from '../src/tools/messages.ts';
import { ProjectView } from '../src/view.ts';

const ctx: ToolContext = { view: new ProjectView('prj'), agentId: 'agent_a', taskId: 'T-1', send: async () => ({ message_id: 'msg_1' }), timeoutMs: 50 };

test('the tools are the 0A four plus each module\'s pinned names, in order, with no duplicates', () => {
  assert.deepEqual([...CORE_TOOL_NAMES], ['harness_status', 'ask', 'answer', 'report_done']);
  assert.deepEqual(harnessTools(ctx).map((t) => t.name), [...HARNESS_TOOL_NAMES]);
  const call = commandCall(ctx);
  assert.deepEqual(leaseTools(ctx, call).map((t) => t.name), [...LEASE_TOOL_NAMES]);
  assert.deepEqual(messageTools(ctx, call).map((t) => t.name), [...MESSAGE_TOOL_NAMES]);
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
