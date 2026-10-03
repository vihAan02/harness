// The human CLI and the task lifecycle (0A item 9; D-54), end to end with the real `harness` CLI:
// adding a task with an assignee starts its agent; report_done or `harness task done` stops it and
// commits its work; `harness task abandon` stops it and removes its worktree.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gitIn } from '../packages/daemon/test/fixtures.ts';
import { startStack, steps, type Stack } from './support.ts';

let s: Stack;
before(async () => {
  s = await startStack({ files: { 'src/types.ts': 'export type User = { id: string };\n', 'src/web/Login.tsx': 'export {}\n' }, daemonOptions: { finishGraceMs: 1000, diffIntervalMs: 500 } });
});
after(async () => { await s?.stop(); });

const taskIdIn = (out: string) => out.match(/Created (T-\d+)/)![1]!;
const event = (kind: string, task: string) => s.nextEvent((e) => e.kind === kind && (e.data as { task_id?: string }).task_id === task, 40_000);

test('assign starts the agent; report_done commits its work; done and abandon from the CLI', async () => {
  assert.match(await s.cli('agent', 'add', 'backend'), /Added agent\/backend/);
  assert.match(await s.cli('agent', 'add', 'frontend'), /Added agent\/frontend/);

  // 1. The agent finishes on its own, with report_done (D-54).
  const t1 = taskIdIn(await s.cli('task', 'add', 'Add a token field', '--scope', 'src/types.ts,src/api/', '--assign', 'backend', '--text', steps(
    `Bash {"command":"printf 'export type User = { id: string; token: string };\\\\n' > src/types.ts"}`,
    'mcp__harness__report_done {"summary":"Added User.token"}',
    'TEXT done')));
  const committed = (await event('worktree.committed', t1)).data as { commit: string; branch: string };
  assert.equal(committed.branch, `harness/task/${t1}`);
  assert.equal(gitIn(s.repo, 'log', '-1', '--format=%an|%s', committed.commit), 'agent/backend|Added User.token');
  assert.equal(gitIn(s.repo, 'show', `${committed.commit}:src/types.ts`), 'export type User = { id: string; token: string };');
  await s.until(() => !s.daemon.running.has(t1), 10_000, 'the agent to stop');
  assert.ok(!Object.keys(s.daemon.ports.list()).includes(t1), 'its ports are free for the next task');

  // 2. The human marks a task done while its agent is still busy.
  const next = await s.nextTaskId();
  const t2 = taskIdIn(await s.cli('task', 'add', 'Login page', '--scope', 'src/web/', '--text', steps(
    `Write {"file_path":"${s.worktreeOf(next)}/src/web/Login.tsx","content":"export const Login = 1;\\n"}`, 'Bash {"command":"sleep 30"}', 'TEXT done')));
  assert.match(await s.cli('task', 'assign', t2, 'frontend'), new RegExp(`Assigned ${t2} to agent/frontend`));
  await s.until(() => s.daemon.view(s.project).claims.get(t2)?.observed.has('src/web/Login.tsx') === true, 30_000, 'the frontend agent to start editing');

  const status = await s.cli('status');
  assert.match(status, /agent\/frontend\s+working \(session since \d+s ago\), on T-\d+/);
  assert.match(status, new RegExp(`${t1} "Add a token field" \\[done\\] owner human/human_test, assignee agent/backend`));
  assert.match(status, /summary: "Added User.token"/);
  assert.match(status, new RegExp(`${t2} "Login page" \\[in_progress\\][^\\n]*\\n\\s+scope: src/web/\\n\\s+changing: src/web/Login.tsx`));
  assert.match(status, /Devices: dev_test online/);

  assert.match(await s.cli('task', 'done', t2, '--summary', 'Page stub'), /is done/);
  const c2 = (await event('worktree.committed', t2)).data as { commit: string };
  assert.equal(gitIn(s.repo, 'log', '-1', '--format=%an|%s', c2.commit), 'agent/frontend|Page stub');
  const ended = await s.nextEvent((e) => e.kind === 'session.ended' && (e.data as { task_id: string }).task_id === t2);
  assert.equal((ended.data as { reason: string }).reason, 'stopped');

  // 3. Abandoned: the agent is stopped and its worktree removed (D-54).
  const t3 = taskIdIn(await s.cli('task', 'add', 'Spike', '--scope', 'tmp/', '--assign', 'backend', '--text', steps('Bash {"command":"sleep 30"}', 'TEXT done')));
  await s.until(() => s.daemon.running.has(t3), 30_000, 'the spike agent to start');
  const wt3 = s.daemon.worktreeOf(s.project, t3);
  assert.match(await s.cli('task', 'abandon', t3, '--reason', 'not needed'), /abandoned/);
  await event('worktree.removed', t3);
  assert.ok(!fs.existsSync(wt3));
  assert.ok(!s.daemon.running.has(t3));

  const log = await s.cli('log', '--kind', 'task.');
  assert.deepEqual(log.trim().split('\n').map((l) => l.split(/\s+/)[3]), [
    'task.created', 'task.assigned', 'task.completed', 'task.created', 'task.assigned', 'task.completed', 'task.created', 'task.assigned', 'task.abandoned']);
  assert.match(log, /agent\/backend\s+task\.completed\s+T-\d+ .*by=agent\/backend/);
  assert.match(log, /task\.completed\s+T-\d+ .*summary=Added User\.token/);
});

test('the CLI explains what went wrong', async () => {
  await assert.rejects(s.cli('task', 'assign', 'T-999', 'frontend'), /not_found: no task T-999/);
  await assert.rejects(s.cli('task', 'add', 'x', '--scope', '/etc/', '--text', 'x'), /bad scope entry/);
  await assert.rejects(s.cli('task', 'assign', 'T-1', 'nobody'), /no agent nobody/);
});
