// wait_for end to end (0B item 4; D-95, D-101): a real Claude Code session calls the tool, ends its turn, and
// harnessd pushes the outcome when the server settles the wait. The server, harnessd, the CLI and Git are
// real; the model is the scripted mock.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, steps, type Stack } from './support.ts';

let s: Stack;
before(async () => { s = await startStack({ files: { 'src/api/login.ts': 'export {}\n', 'src/web/Login.tsx': 'export {}\n' } }); });
after(async () => { await s?.stop(); });
afterEach(async () => {
  // harnessd runs at most two agents (D-38): each test's agents make way for the next test's.
  for (const t of [...s.daemon.running.keys()]) {
    await s.command('task.abandon', { task_id: t, reason: 'test done' }).catch(() => {});
    await s.nextEvent((e) => e.kind === 'worktree.removed' && dataOf(e).task_id === t, 30_000).catch(() => {});
  }
});

const dataOf = (e: { data: unknown }) => e.data as Record<string, any>;
/** Everything the model was sent in the latest request that carries `marker`. */
const seenBy = (marker: string) => JSON.stringify(s.mock.log.filter((e) => e.kind === 'main' && JSON.stringify(e.summary).includes(marker)).at(-1)?.summary ?? []);

test('an agent waits for an answer: when it comes, harnessd pushes the outcome to the agent', async () => {
  const backend = (await s.command('agent.create', { name: 'agent/answerer', vendor: 'claude' })).agent_id!;
  const frontend = (await s.command('agent.create', { name: 'agent/waiter', vendor: 'claude' })).agent_id!;
  // The answerer is slow on purpose: if its answer came before the waiter called wait_for, the wait would
  // resolve inside wait.start, the tool's result would say so, and there would rightly be no pushed outcome.
  const tApi = await s.assignTask(backend, 'Login API', ['src/api/'], `#SLOW 3000\n${steps(
    'TEXT ready',
    'mcp__harness__answer {"question_id":"{{find:ID: (msg_[0-9a-f]+)}}","text":"email and password"}',
    'TEXT answered',
  )}`);
  await s.turnEnds(tApi);
  const tWeb = await s.assignTask(frontend, 'Login page', ['src/web/'], steps(
    'mcp__harness__ask {"to":"agent/answerer","text":"Which fields does POST /login take?"}',
    'mcp__harness__wait_for {"kind":"answer","id":"{{find:question_id: (msg_[0-9a-f]+)}}","timeout_s":120}',
    'TEXT waiting for the answer',
    'TEXT got it',
  ));
  const started = await s.nextEvent((e) => e.kind === 'wait.started' && dataOf(e).task_id === tWeb, 60_000);
  const resolved = await s.nextEvent((e) => e.kind === 'wait.resolved' && dataOf(e).wait_id === dataOf(started).wait_id, 60_000);
  assert.deepEqual(dataOf(started).on.kind, 'answer');
  assert.equal(typeof dataOf(resolved).result.answer_id, 'string');
  await s.until(() => seenBy(`TASK: ${tWeb}`).includes('KIND: wait_outcome'), 60_000, 'the outcome to reach the waiting agent');
  const seen = seenBy('KIND: wait_outcome');
  assert.match(seen, new RegExp(`Your wait for the answer to ${dataOf(started).on.id} is over: the answer arrived \\(${dataOf(resolved).result.answer_id}\\)`));
  assert.match(seen, /SOURCE: harness {3}TRUST: system-notice/);
  const results = s.toolResults(`TASK: ${tWeb}`);
  assert.match(results[1]!, /^Waiting \(wait_id wait_[0-9a-f]+\)\. End your turn now\./, 'the wait started before the answer came');
  // A new turn if the agent had ended its turn by then; at Stop if the answer came first (D-100). Never between tools: there were none left.
  const delivery = s.observed.find((x) => x.o.kind === 'delivery' && x.o.messageId === `wait:${dataOf(started).wait_id}`)!.o as { landed: string };
  assert.ok(['new_turn', 'stop_hook'].includes(delivery.landed), delivery.landed);
});

test('a wait already over is answered by the tool itself; one that times out is pushed, and the human is told', async () => {
  const agent = (await s.command('agent.create', { name: 'agent/patient', vendor: 'claude' })).agent_id!;
  const gone = (await s.command('task.create', { title: 'Old idea', text: 'x', scope: [] })).task_id!;
  await s.command('task.abandon', { task_id: gone, reason: 'not needed' });
  const never = (await s.command('task.create', { title: 'Nobody works on this', text: 'x', scope: [] })).task_id!;
  const t = await s.assignTask(agent, 'Patient work', [], steps(
    `mcp__harness__wait_for {"kind":"task","id":"${gone}"}`,
    `mcp__harness__wait_for {"kind":"task","id":"${never}","timeout_s":10}`,
    'TEXT waiting',
    'TEXT carrying on',
  ));
  const started = await s.nextEvent((e) => e.kind === 'wait.started' && dataOf(e).task_id === t && dataOf(e).on.id === never, 60_000);
  await s.nextEvent((e) => e.kind === 'wait.timed_out' && dataOf(e).wait_id === dataOf(started).wait_id, 30_000);
  const blocked = await s.nextEvent((e) => e.kind === 'message.sent' && dataOf(e).kind === 'task_blocked' && dataOf(e).to_task_id === t, 10_000);
  assert.ok(blocked, 'the task\'s human is told');
  await s.until(() => seenBy(`TASK: ${t}`).includes('timed out after 10 seconds'), 60_000, 'the timeout to reach the agent');
  const [already, waiting] = s.toolResults(`TASK: ${t}`);
  assert.equal(already, 'It has already happened: the task is abandoned. Carry on.');
  assert.match(waiting!, /^Waiting \(wait_id wait_[0-9a-f]+\)\. End your turn now\. .* after 10 seconds/);
  const seen = seenBy(`TASK: ${t}`);
  assert.match(seen, new RegExp(`Your wait for task ${never} to land timed out after 10 seconds without it happening, and your human has been told\\.`));
  assert.equal(seen.split('KIND: wait_outcome').length - 1, 1, 'one outcome notice: none for the wait the tool already answered');
});
