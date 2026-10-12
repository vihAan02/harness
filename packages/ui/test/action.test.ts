// One human click (D-117; protocol.md §12): sent once, pending until a snapshot confirms it, and a retry keeps its
// command_id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectSnapshot } from '@harness/protocol';
import { Action } from '../web/action.ts';
import { ApiError } from '../web/api.ts';

const snap = (head: number) => ({ head_seq: head }) as unknown as ProjectSnapshot;

test('one send at a time: a second send while busy is a no-op', async () => {
  let calls = 0;
  let resolveRun!: (v: unknown) => void;
  const action = new Action((commandId) => {
    calls++;
    assert.ok(commandId.length > 0, 'the run gets a command id');
    return new Promise((r) => { resolveRun = r; });
  });
  const first = action.send();
  const second = action.send();
  assert.equal(action.status, 'sending');
  assert.equal(action.busy(), true);
  assert.equal(calls, 1, 'the second send never reached the run');
  resolveRun({ seqs: [5], result: {} });
  await first;
  await second;
  assert.equal(action.status, 'sent');
  assert.equal(action.busy(), true);
  assert.equal(action.label(), 'Sent; waiting for harnessd to confirm');
});

test('a sent action is confirmed once head_seq reaches the largest seq', async () => {
  const action = new Action(() => Promise.resolve({ seqs: [3, 7, 5] }));
  await action.send();
  assert.equal(action.status, 'sent');
  assert.equal(action.observe(snap(6)), false);
  assert.equal(action.status, 'sent');
  assert.equal(action.observe(snap(7)), true);
  assert.equal(action.status, 'confirmed');
  assert.equal(action.busy(), false);
  assert.equal(action.label(), 'Done');
  assert.equal(action.observe(snap(9)), false, 'a confirmed action does not change again');
  assert.equal(action.observe(null), false);
});

test('an answer with no seqs array is confirmed at once', async () => {
  for (const answer of [{}, { result: { ok: true } }, { seqs: [] }]) {
    const action = new Action(() => Promise.resolve(answer));
    await action.send();
    assert.equal(action.status, 'confirmed', JSON.stringify(answer));
    assert.equal(action.label(), 'Done');
    assert.equal(action.busy(), false);
  }
});

test('a retry keeps the same command_id', async () => {
  const ids: string[] = [];
  let n = 0;
  const action = new Action((commandId) => {
    ids.push(commandId);
    return n++ === 0 ? Promise.reject(new Error('boom')) : Promise.resolve({ seqs: [2] });
  });
  await action.send();
  assert.equal(action.status, 'failed');
  assert.match(action.label(), /boom/);
  assert.match(action.label(), /retry/);
  const first = action.commandId;
  await action.send();
  assert.equal(action.status, 'sent');
  assert.equal(ids[0], ids[1], 'the retry reused the command id');
  assert.equal(action.commandId, first);
});

test('a conflict is its own state', async () => {
  const action = new Action(() => Promise.reject(new ApiError(409, 'conflict', 'not what was shown')));
  await action.send();
  assert.equal(action.status, 'conflict');
  assert.equal(action.label(), 'This changed since you looked: check it again');
  assert.equal(action.busy(), false);
});

test('send from idle twice only runs once while settled', async () => {
  let calls = 0;
  const action = new Action(() => { calls++; return Promise.resolve({ seqs: [1] }); });
  await action.send();
  await action.send();
  assert.equal(calls, 1, 'a sent action does not send again');
  assert.equal(action.status, 'sent');
});
