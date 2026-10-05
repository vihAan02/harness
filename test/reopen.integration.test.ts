// Sending a done task back to its agent (D-107), end to end: the agent finishes, its human reopens the task
// with a message, and harnessd starts a new session in the same worktree, on the same branch, whose first
// message is the task and the human's message. The agent's second pass lands with its first.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { gitIn } from '../packages/daemon/test/fixtures.ts';
import { startStack, steps, type Stack } from './support.ts';

let s: Stack;
before(async () => { s = await startStack({ portRange: [32000, 32099], files: { 'src/api/login.ts': 'export {}\n' } }); });
after(async () => { await s?.stop(); });

const dataOf = (e: { data: unknown }) => e.data as Record<string, any>;

test('a reopened task: a new session in its worktree with its human\'s message, then done and landed with both passes (D-107)', async () => {
  const agent = (await s.command('agent.create', { name: 'agent/backend', vendor: 'claude' })).agent_id!;
  const t = await s.nextTaskId();
  const wt = s.worktreeOf(t);
  // The first pass writes one file; its human marks it done (as a land's failed tests would then send it back).
  // (The scripted model replays the whole opening message, so the first pass has no final text step: the
  // reopened session runs it again, harmlessly, then the human's steps.)
  assert.equal(await s.assignTask(agent, 'Login response', ['src/api/'], steps(`Write {"file_path":"${wt}/src/api/first.ts","content":"export const first = 1;\\n"}`)), t);
  await s.turnEnds(t);
  await s.command('task.complete', { task_id: t, summary: 'first pass' });
  const first = await s.nextEvent((e) => e.kind === 'worktree.committed' && dataOf(e).task_id === t);
  const sessions = () => s.observed.filter((x) => x.run.taskId === t && x.o.kind === 'turn.ended').map((x) => x.run.sessionId);
  const firstSession = sessions()[0];

  // An unknown task: the CLI says so.
  await assert.rejects(s.cli('task', 'reopen', 'T-999', '--text', 'x'), /no task T-999/);

  const message = steps(`Write {"file_path":"${wt}/src/api/second.ts","content":"export const second = 2;\\n"}`, 'mcp__harness__report_done {"summary":"fixed what the land found"}', 'TEXT second pass');
  assert.match(await s.cli('task', 'reopen', t, '--text', `The land failed: the client still reads .token.\n${message}`), new RegExp(`${t} is reopened`));
  const reopened = await s.nextEvent((e) => e.kind === 'task.reopened' && dataOf(e).task_id === t);
  assert.equal(dataOf(reopened).assignee_agent_id, agent);
  const done = await s.nextEvent((e) => e.kind === 'task.completed' && dataOf(e).task_id === t && e.seq > reopened.seq, 60_000);
  assert.equal(dataOf(done).by, agent, 'the agent reported it done itself this time');
  const second = await s.nextEvent((e) => e.kind === 'worktree.committed' && dataOf(e).task_id === t && e.seq > done.seq, 60_000);
  assert.notEqual(dataOf(second).commit, dataOf(first).commit);

  // The same worktree, the same branch, a new session; its first message was the task and the human's message.
  assert.ok(fs.existsSync(path.join(wt, 'src/api/first.ts')) && fs.existsSync(path.join(wt, 'src/api/second.ts')));
  assert.equal(gitIn(s.repo, 'merge-base', '--is-ancestor', dataOf(first).commit, dataOf(second).commit), '', 'the second commit builds on the first');
  const secondSession = s.observed.filter((x) => x.run.taskId === t).map((x) => x.run.sessionId).find((id) => id !== firstSession);
  assert.ok(secondSession, 'a new session');
  const opening = JSON.stringify(s.mock.log.filter((e) => e.kind === 'main' && JSON.stringify(e.summary).includes('[Reopened]'))[0]?.summary ?? []);
  assert.match(opening, /TASK: T-\d+ {3}TITLE: Login response/);
  assert.match(opening, /\[Reopened\] You reported this task done, and your human has sent it back to you\./);
  assert.match(opening, /The land failed: the client still reads \.token\./);

  // It lands with both passes; M5 counts the reopen as a human intervention.
  await s.cli('land', t, '--no-tests');
  await s.nextEvent((e) => e.kind === 'land.completed' && dataOf(e).task_id === t, 60_000);
  assert.deepEqual(gitIn(s.repo, 'ls-tree', '--name-only', 'main', 'src/api/').split('\n').sort(), ['src/api/first.ts', 'src/api/login.ts', 'src/api/second.ts']);
  assert.match(await s.cli('metrics'), new RegExp(`M5 +human interventions: 2 \\(marked ${t} done; reopened ${t}\\)`));
  await assert.rejects(s.cli('task', 'reopen', t, '--text', 'again'), /landed; only a done task/, 'a landed task stays closed');
});
