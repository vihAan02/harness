// A stopped task resumed by its human (D-113): harnessd restarts while the agent works and waits, so the task is left
// stopped with its work in its worktree; nothing starts on its own. The human's signed resume starts a new session
// there, whose first message is the handoff: the task, what's changed (new files too), what the old session was
// waiting for, and the human's message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startPilotStack } from '../support.ts';

test('a stopped task resumes with a handoff: the work so far, new files included, the wait it had, and its human\'s message', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, portRanges: { a: [30600, 30649], b: [30650, 30699] } });
  try {
    const agent = (await s.a.command('agent.create', { name: 'agent/resumed', vendor: 'claude' })).agent_id!;
    const other = (await s.a.command('task.create', { title: 'api', text: 'The API.', scope: [] })).task_id!;
    const task = await s.a.assign(agent, { title: 'page', text: 'Build the page.' });
    await s.until(() => s.a.daemon.running.has(task), 20_000, 'the session');
    const worktree = s.a.daemon.worktreeOf(s.project, task);
    fs.writeFileSync(path.join(worktree, 'README.md'), 'pilot, edited\n');
    fs.writeFileSync(path.join(worktree, 'draft.md'), 'half a page\n');
    // The agent waits for the other task to land, as wait_for would.
    const session = [...s.a.daemon.view(s.project).sessions.values()].find((x) => x.taskId === task && x.status !== 'ended')!.id;
    const wait = (await s.a.daemon.link!.command(s.project, 'wait.start', { session_id: session, on: { kind: 'task', id: other } }, agent)).result as { wait_id: string };

    await s.a.restart(); // harnessd stops, then starts again on the same home
    await s.until(() => s.a.logs.some((l) => l.includes(`${task}: its session was interrupted`)), 20_000, 'the recovery');
    await new Promise((r) => setTimeout(r, 500)); // a resume is the human's call: nothing starts on its own
    assert.ok(!s.a.daemon.running.has(task));
    assert.equal(fs.readFileSync(path.join(worktree, 'draft.md'), 'utf8'), 'half a page\n', 'the work stays');

    const sessions = s.a.adapter.sessions.length;
    await s.a.signed('task.resume', { task_id: task, text: 'Carry on, and keep the draft.' });
    await s.until(() => s.a.daemon.running.has(task) && s.a.adapter.sessions.length === sessions + 1, 20_000, 'the resumed session');
    const handoff = s.a.adapter.sessions.at(-1)!.injected[0]!.text;
    assert.match(handoff, /\[Resumed\] Your earlier session on this task was interrupted/);
    assert.match(handoff, /Changed so far \(git status\):\n M README\.md\n\?\? draft\.md/);
    assert.ok(handoff.includes(`waiting for task ${other} to land (${wait.wait_id})`), handoff);
    assert.ok(handoff.includes('Your human\'s message:\nCarry on, and keep the draft.'));
  } finally { await s.stop(); }
});
