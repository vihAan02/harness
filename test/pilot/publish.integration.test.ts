// Publishing a finished task in a GitHub project (D-114): the task starts from the fetched remote base; when it's done,
// harnessd commits as the accountable human, scans the push, waits for the human's local approval of that exact head
// and text, pushes with a lease, and opens the PR once. Against the fake GitHub, with the stand-in adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { Journal } from '../../packages/daemon/src/journal.ts';
import { fetchBase } from '../../packages/daemon/src/remote.ts';
import { startPilotStack, type PilotStack } from '../support.ts';

/** A task for human A's agent; returns its id and worktree once its session runs. */
async function started(s: PilotStack, name: string, scope: string[] = []) {
  const agent = (await s.a.command('agent.create', { name, vendor: 'claude' })).agent_id!;
  const task = await s.a.assign(agent, { title: `${name} work`, text: `do ${name}`, scope });
  await s.until(() => s.a.daemon.running.has(task), 20_000, `${task}'s session`);
  return { task, worktree: s.a.daemon.worktreeOf(s.project, task) };
}
const pendingPublish = (s: PilotStack, task: string) => new Approvals(s.a.home).pending().find((r) => r.kind === 'publish' && r.taskId === task);
const journal = (s: PilotStack, task: string) => new Journal(s.a.home, s.a.daemon.link!.epoch!).read(s.project, task).map((r) => r.state);

test('a finished task is published once: fetched base, the human\'s commit, the gate, local approval, a leased push, one PR', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n', 'notes/.keep': '' } });
  try {
    const base = await s.fake.baseTip();
    const { task, worktree } = await started(s, 'agent/pub', ['notes/']);
    // The worktree started from the base as the remote has it (D-114), and harnessd's base ref is there too.
    assert.equal((await s.fake.git(['rev-parse', 'HEAD'], { cwd: worktree })), base);
    fs.writeFileSync(path.join(worktree, 'notes/a.md'), '# Notes\n');
    await s.a.signed('task.complete', { task_id: task, summary: 'Added the notes page.' });
    await s.until(() => pendingPublish(s, task) !== undefined, 20_000, 'the publish approval request');
    const req = pendingPublish(s, task)!;
    const branch = `harness/${s.project}/${s.a.daemon.link!.epoch!.slice(0, 8)}/${task}`;
    assert.match(req.command, new RegExp(`publish ${task} to vihAan02/harness as ${branch.replace(/\//g, '\\/')}`));
    assert.match(req.command, /notes\/a\.md/);
    assert.equal(s.fake.prs().length, 0, 'nothing is pushed or opened before the human approves');
    // What the approval's hash binds is all shown: the full head, the base, and the PR's whole text (#105's review).
    assert.match(req.command, new RegExp(` @ [0-9a-f]{40} \\(on main @ ${base}\\)`));
    const [shownTitle, , ...shownBody] = req.command.split('--- the PR, exactly as it will be opened ---\n')[1]!.split('\n');
    new Approvals(s.a.home).approve(req.id);
    await s.until(() => s.a.daemon.view(s.project).prs.has(task), 20_000, 'pr.published');
    const prs = s.fake.prs();
    assert.equal(prs.length, 1);
    assert.equal(prs[0]!.head, branch);
    assert.equal(prs[0]!.title, `${task}: agent/pub work`);
    for (const h of ['## What changed, and why', '## Tests run', '## Real-model cost', '## Review']) assert.ok(prs[0]!.body!.includes(h), h);
    assert.deepEqual([shownTitle, shownBody.join('\n')], [prs[0]!.title, prs[0]!.body], 'the human saw exactly the PR that opened');
    assert.match(prs[0]!.body!, /> Added the notes page\./);
    // GitHub attributes the commit to the accountable human; the agent is named in the trailer (D-114).
    const commit = await s.fake.git(['log', '-1', '--format=%ae|%ce|%B', `refs/heads/${branch}`]);
    assert.match(commit, /^human_a@users\.noreply\.github\.com\|human_a@users\.noreply\.github\.com\|Added the notes page\./);
    assert.match(commit, /Harness-Task: T-\d+\nHarness-Agent: agent_/);
    const pr = s.a.daemon.view(s.project).prs.get(task)!;
    assert.equal(pr.headSha, await s.fake.tip(branch));
    assert.equal(pr.baseSha, base);
    assert.deepEqual(journal(s, task).filter((x) => ['committed', 'pushing', 'pushed', 'pr'].includes(x)), ['committed', 'pushing', 'pushed', 'pr']);
    // Again (as recovery would): no second push, no second PR.
    await s.a.daemon.publishTask(s.project, task);
    assert.equal(s.fake.prs().length, 1);
    assert.equal(s.fake.log.filter((l) => l.method === 'POST' && l.path.endsWith('/pulls')).length, 1);
  } finally { await s.stop(); }
});

test('the gate: a workflow file is never pushed, and the human hears why; a task that changed nothing publishes nothing', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' } });
  try {
    const evil = await started(s, 'agent/ci');
    fs.mkdirSync(path.join(evil.worktree, '.github/workflows'), { recursive: true });
    fs.writeFileSync(path.join(evil.worktree, '.github/workflows/x.yml'), 'on: pull_request\njobs: {}\n');
    await s.a.signed('task.complete', { task_id: evil.task });
    await s.until(() => s.a.daemon.view(s.project).publishBlocked.has(evil.task), 20_000, 'publish.blocked');
    assert.deepEqual(s.a.daemon.view(s.project).publishBlocked.get(evil.task)!.reasons.map((r) => [r.rule, r.path]), [['ci_workflow', '.github/workflows/x.yml']]);
    assert.equal(pendingPublish(s, evil.task), undefined, 'a blocked publish asks for no approval');
    const idle = await started(s, 'agent/idle');
    await s.a.signed('task.complete', { task_id: idle.task });
    await s.until(() => journal(s, idle.task).includes('no_change'), 20_000, 'no_change');
    assert.equal(s.fake.prs().length, 0);
    assert.equal(pendingPublish(s, idle.task), undefined);
    // It lands as it is, so the waits on it end (D-106): one land, completed, with no change.
    await s.until(() => s.b.daemon.view(s.project).tasks.get(idle.task)?.status === 'landed', 20_000, 'the empty land');
    const lands = [...s.b.daemon.view(s.project).lands.values()].filter((l) => l.taskId === idle.task);
    assert.deepEqual(lands.map((l) => [l.status, l.changedPaths]), [['completed', []]]);
  } finally { await s.stop(); }
});

test('fetches of the base are one at a time per repository: concurrent fetches while the base moves all succeed', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' } });
  try {
    const fetches: Promise<string>[] = [];
    for (let i = 0; i < 6; i++) {
      fetches.push(fetchBase(s.a.repo, s.fake.gitUrl, 'main', s.project), fetchBase(s.a.repo, s.fake.gitUrl, 'main', s.project));
      await s.fake.pushToBase({ [`f${i}.txt`]: `${i}\n` }, `move ${i}`);
    }
    fetches.push(fetchBase(s.a.repo, s.fake.gitUrl, 'main', s.project));
    const tips = await Promise.all(fetches); // Git's ref lock would fail one of two overlapping fetches
    assert.equal(tips.at(-1), await s.fake.baseTip());
  } finally { await s.stop(); }
});

test('a denied publish: nothing is pushed and no PR opens, the task stays done and isn\'t shown publishing, and it isn\'t asked again', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, daemonOptions: { approvalPollMs: 50 } });
  try {
    const t = await started(s, 'agent/denied');
    fs.writeFileSync(path.join(t.worktree, 'notes.md'), 'notes\n');
    await s.a.signed('task.complete', { task_id: t.task });
    await s.until(() => pendingPublish(s, t.task) !== undefined, 20_000, 'the publish approval request');
    new Approvals(s.a.home).deny(pendingPublish(s, t.task)!.id);
    await s.until(() => journal(s, t.task).includes('publish_denied'), 20_000, 'the denial');
    assert.equal(s.fake.prs().length, 0);
    assert.equal(s.fake.log.filter((l) => l.server === 'git' && l.method === 'POST' && l.path.endsWith('git-receive-pack')).length, 0, 'nothing pushed');
    assert.equal(s.a.daemon.snapshot(s.project).tasks.find((x) => x.id === t.task)!.state, 'done');
    // A restart reconciles the task: the denial stands, so it isn't asked again.
    await s.a.restart();
    await new Promise((r) => setTimeout(r, 500)); // ten approval polls: no new request
    assert.equal(pendingPublish(s, t.task), undefined);
  } finally { await s.stop(); }
});
