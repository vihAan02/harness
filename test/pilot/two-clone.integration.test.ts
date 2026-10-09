// Two clones, one GitHub (D-114, D-115; acceptance 3): each Mac has only its own clone, and Git is the only way code
// moves between them. A changes a file B's agent read, publishes it, and integrates it through a PR; B's harnessd fetches
// the base itself, merges the confirmed squash into its agent's branch at the safe boundary, and only then tells the
// agent, with the diff. Then the other way round. With the stand-in adapter, against the fake GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { Journal } from '../../packages/daemon/src/journal.ts';
import { startPilotStack, type PilotStack, type PilotSide } from '../support.ts';

const FAST = { pollMs: 150 };
/**
 * A worktree file's text, or '' while a sync is rewriting it: Git replaces a file a merge changes (unlink, then create),
 * so a read can land in between and find nothing. Waiting for the change is waiting until a read finds it.
 */
const textOf = (file: string) => {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw e; }
};

async function started(s: PilotStack, side: PilotSide, name: string) {
  const agent = (await side.command('agent.create', { name, vendor: 'claude' })).agent_id!;
  const task = await side.assign(agent, { title: `${name} work`, text: `do ${name}`, scope: [] });
  await s.until(() => side.daemon.running.has(task), 20_000, `${task}'s session`);
  return { task, worktree: side.daemon.worktreeOf(s.project, task) };
}
/** The writer finishes with `files` and publishes (approved on its own Mac); resolves with the PR. */
async function publishThrough(s: PilotStack, side: PilotSide, task: string, files: Record<string, string>) {
  const wt = side.daemon.worktreeOf(s.project, task);
  for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(wt, f), c);
  side.adapter.of(task).edited(Object.keys(files));
  await side.signed('task.complete', { task_id: task });
  await s.until(() => new Approvals(side.home).pending().some((r) => r.kind === 'publish' && r.taskId === task), 20_000, 'the publish request');
  new Approvals(side.home).approve(new Approvals(side.home).pending().find((r) => r.taskId === task)!.id);
  await s.until(() => side.daemon.view(s.project).prs.has(task), 20_000, 'the PR');
  return side.daemon.view(s.project).prs.get(task)!;
}
/** The human approves the PR's exact head on `base` (`harness integrate`); resolves with the land's id. */
const integrate = async (s: PilotStack, side: PilotSide, task: string, head: string, base: string) =>
  (await side.command('land.request', { task_id: task, mode: 'github', pr_number: side.daemon.view(s.project).prs.get(task)!.prNumber, head_sha: head, base_sha: base })).land_id!;
/** Publishes and integrates; resolves with the merge. */
async function landThrough(s: PilotStack, side: PilotSide, task: string, files: Record<string, string>) {
  const pr = await publishThrough(s, side, task, files);
  await integrate(s, side, task, pr.headSha, pr.baseSha);
  await s.until(() => side.daemon.view(s.project).tasks.get(task)?.status === 'landed', 20_000, `${task} to land`);
  return [...side.daemon.view(s.project).lands.values()].find((l) => l.taskId === task && l.status === 'completed')!.newBaseSha!;
}

test('A lands a change B read; B fetches the confirmed merge, syncs, and is told with the diff. Then B to A.', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n', 'shared.ts': 'export const v = 1;\n', 'other.ts': 'export const w = 1;\n' }, daemonOptions: FAST });
  try {
    // B's agent reads shared.ts; A's agent reads other.ts. Each clone has only its own commits.
    const reader = await started(s, s.b, 'agent/reader-b');
    s.b.adapter.of(reader.task).read(['shared.ts']);
    const readerA = await started(s, s.a, 'agent/reader-a');
    s.a.adapter.of(readerA.task).read(['other.ts']);
    await s.until(() => s.b.daemon.view(s.project).reads.get(reader.task)?.has('shared.ts') === true && s.a.daemon.view(s.project).reads.get(readerA.task)?.has('other.ts') === true, 10_000, 'the reads');

    const writer = await started(s, s.a, 'agent/writer-a');
    const merge = await landThrough(s, s.a, writer.task, { 'shared.ts': 'export const v = 2; // changed by A\n' });
    // B's clone never had A's commits; harnessd fetched them, verified the merge is on the base, and merged it.
    await s.until(() => textOf(path.join(reader.worktree, 'shared.ts')).includes('changed by A'), 20_000, 'B\'s branch to have A\'s change');
    await s.until(() => s.b.adapter.of(reader.task).injected.some((i) => /Your branch now includes this change/.test(i.text)), 20_000, 'the landed notice, after the sync');
    const delivered = s.b.adapter.of(reader.task).injected.find((i) => /Your branch now includes this change/.test(i.text))!;
    assert.match(delivered.text, new RegExp(`merged ${merge.slice(0, 12)}`));
    assert.match(delivered.text, /DIFF shared\.ts/);
    // Told once: the dependency notice was held until the sync, then delivered with it as one message.
    assert.equal(s.b.adapter.of(reader.task).injected.filter((i) => /shared\.ts has changed since you read it/.test(i.text)).length, 1);
    assert.equal(await s.fake.git(['merge-base', '--is-ancestor', merge, 'HEAD'], { cwd: reader.worktree }).then(() => true, () => false), true);

    // The other way: B lands a change A's agent read.
    const writerB = await started(s, s.b, 'agent/writer-b');
    const mergeB = await landThrough(s, s.b, writerB.task, { 'other.ts': 'export const w = 2; // changed by B\n' });
    await s.until(() => textOf(path.join(readerA.worktree, 'other.ts')).includes('changed by B'), 20_000, 'A\'s branch to have B\'s change');
    await s.until(() => s.a.adapter.of(readerA.task).injected.some((i) => new RegExp(`merged ${mergeB.slice(0, 12)}`).test(i.text)), 20_000, 'A told after its sync');
    // One land event per merge, and the chain moved twice, by the harness, with no outside-move notices.
    assert.equal((await s.db.pool.query("SELECT count(*)::int AS n FROM events WHERE project_id = $1 AND kind = 'land.completed'", [s.project])).rows[0].n, 2);
    assert.equal((await s.db.pool.query("SELECT count(*)::int AS n FROM events WHERE project_id = $1 AND kind = 'base.advanced'", [s.project])).rows[0].n, 0);
    assert.equal((await s.db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [s.project])).rows[0].tip_sha, mergeB);
  } finally { await s.stop(); }
});

test('the base moved after the approval: harnessd brings the PR up to date, nothing merges, and the new head lands once approved', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n', 'a.txt': 'a\n' }, daemonOptions: FAST });
  try {
    const t = await started(s, s.a, 'agent/behind');
    const pr = await publishThrough(s, s.a, t.task, { 'a.txt': 'a, by the task\n' });
    const moved = await s.fake.pushToBase({ 'other.txt': 'o\n' }, 'a human merges something');
    const first = await integrate(s, s.a, t.task, pr.headSha, pr.baseSha);
    await s.until(() => s.a.daemon.view(s.project).lands.get(first)?.status === 'failed', 20_000, 'base_moved');
    assert.equal(s.a.daemon.view(s.project).lands.get(first)!.reason, 'base_moved');
    // The PR's branch now contains the moved base and the task's work; the merge is the human's, as GitHub sees it.
    const branch = s.a.daemon.remoteBranch(s.project, t.task);
    const head = (await s.fake.tip(branch))!;
    assert.notEqual(head, pr.headSha);
    for (const c of [moved, pr.headSha]) assert.equal(await s.fake.git(['merge-base', '--is-ancestor', c, head]).then(() => true, () => false), true);
    assert.match(await s.fake.git(['log', '-1', '--format=%ae|%ce', head]), /^human_a@users\.noreply\.github\.com\|human_a@users\.noreply\.github\.com$/);
    assert.ok(new Journal(s.a.home, s.a.daemon.link!.epoch!).read(s.project, t.task).some((r) => r.state === 'pushed' && r.refresh === true && r.head === head));
    assert.equal(s.fake.log.filter((l) => l.method === 'PUT' && l.path.endsWith('/merge')).length, 0, 'nothing merged');
    // The poller reports the new head; the human approves it on the moved base, and it lands.
    await s.until(() => s.b.daemon.view(s.project).prs.get(t.task)?.headSha === head, 20_000, 'the new head in B\'s view');
    const second = await integrate(s, s.a, t.task, head, moved);
    await s.until(() => s.a.daemon.view(s.project).lands.get(second)?.status === 'completed', 20_000, 'the land');
    const merge = s.a.daemon.view(s.project).lands.get(second)!.newBaseSha!;
    assert.equal(await s.fake.git(['rev-parse', `${merge}^1`]), moved);
    assert.equal(await s.fake.git(['rev-parse', `${merge}^{tree}`]), await s.fake.git(['rev-parse', `${head}^{tree}`]));
  } finally { await s.stop(); }
});

test('the base moved and conflicts with the task: nothing is pushed or merged, and the land fails as a conflict', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n', 'a.txt': 'a\n' }, daemonOptions: FAST });
  try {
    const t = await started(s, s.a, 'agent/clash');
    const pr = await publishThrough(s, s.a, t.task, { 'a.txt': 'a, by the task\n' });
    await s.fake.pushToBase({ 'a.txt': 'a, by a human\n' }, 'a human changes the same line');
    const land = await integrate(s, s.a, t.task, pr.headSha, pr.baseSha);
    await s.until(() => s.a.daemon.view(s.project).lands.get(land)?.status === 'failed', 20_000, 'the conflict');
    assert.equal(s.a.daemon.view(s.project).lands.get(land)!.reason, 'conflict');
    assert.equal(await s.fake.tip(s.a.daemon.remoteBranch(s.project, t.task)), pr.headSha, 'the PR is untouched');
    assert.equal(s.fake.log.filter((l) => l.method === 'PUT' && l.path.endsWith('/merge')).length, 0);
    // The aborted merge left the worktree as the task finished it.
    assert.equal(await s.fake.git(['status', '--porcelain'], { cwd: t.worktree }), '');
    assert.equal(fs.readFileSync(path.join(t.worktree, 'a.txt'), 'utf8'), 'a, by the task\n');
  } finally { await s.stop(); }
});
