// Polling GitHub (D-114): a move of the base made outside the harness is observed once by the coordinator, whichever
// daemons see it, and readers of the files it changed are told; a published PR's checks and reviews reach everyone's
// view; a PR merged on GitHub without the harness lands once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { startPilotStack, type PilotStack } from '../support.ts';

const POLL = { daemonOptions: { pollMs: 150 } };

async function started(s: PilotStack, name: string) {
  const agent = (await s.a.command('agent.create', { name, vendor: 'claude' })).agent_id!;
  const task = (await s.a.command('task.create', { title: `${name} work`, text: `do ${name}`, scope: [], assignee_agent_id: agent })).task_id!;
  await s.until(() => s.a.daemon.running.has(task), 20_000, `${task}'s session`);
  return { task, worktree: s.a.daemon.worktreeOf(s.project, task) };
}
async function published(s: PilotStack, name: string) {
  const t = await started(s, name);
  fs.writeFileSync(path.join(t.worktree, `${name.replace('/', '-')}.txt`), 'work\n');
  await s.a.command('task.complete', { task_id: t.task });
  await s.until(() => new Approvals(s.a.home).pending().some((r) => r.kind === 'publish' && r.taskId === t.task), 20_000, 'the publish request');
  new Approvals(s.a.home).approve(new Approvals(s.a.home).pending().find((r) => r.taskId === t.task)!.id);
  await s.until(() => s.a.daemon.view(s.project).prs.has(t.task), 20_000, 'the PR');
  return { ...t, pr: s.a.daemon.view(s.project).prs.get(t.task)! };
}

test('a human\'s merge to main outside the harness: observed once, and the reader of a file it changed hears of it', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n', 'docs/x.md': 'v1\n' }, ...POLL });
  try {
    const reader = await started(s, 'agent/reader');
    s.a.adapter.of(reader.task).read(['docs/x.md']);
    await s.until(() => [...s.a.daemon.view(s.project).reads.get(reader.task)?.keys() ?? []].includes('docs/x.md'), 10_000, 'the read');
    const seeded = (await s.db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [s.project])).rows[0]?.tip_sha;
    assert.equal(seeded, await s.fake.baseTip(), 'the first poll seeds the chain');
    const moved = await s.fake.pushToBase({ 'docs/x.md': 'v2\n' }, 'docs: v2');
    await s.until(() => s.a.daemon.view(s.project).baseAdvances.length === 1 && s.b.daemon.view(s.project).baseAdvances.length === 1, 20_000, 'base.advanced on both');
    assert.equal(s.a.daemon.view(s.project).baseAdvances[0]!.newSha, moved);
    assert.deepEqual(s.a.daemon.view(s.project).baseAdvances[0]!.changedPaths, ['docs/x.md']);
    const notice = [...s.a.daemon.view(s.project).messages.values()].find((m) => m.kind === 'dependency_changed' && m.toTask === reader.task);
    assert.ok(notice, 'the reader is told');
    assert.match(notice!.text, /docs\/x\.md has changed since you read it/);
    assert.match(notice!.text, /a merge outside the harness/);
    // Every daemon polls; the move is still applied once.
    await new Promise((r) => setTimeout(r, 600)); // several poll rounds, to show nothing more happens
    assert.equal((await s.db.pool.query("SELECT count(*)::int AS n FROM events WHERE project_id = $1 AND kind = 'base.advanced'", [s.project])).rows[0].n, 1);
    assert.equal((await s.db.pool.query('SELECT tip_sha FROM project_bases WHERE project_id = $1', [s.project])).rows[0].tip_sha, moved);
  } finally { await s.stop(); }
});

test('a published PR\'s checks and reviews reach the view; merged on GitHub without the harness, it lands once', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, ...POLL });
  try {
    const t = await published(s, 'agent/pr');
    s.fake.setChecks(t.pr.headSha, { guard: 'success', 'unit-linux': 'success', 'full-macos': 'failure' });
    s.fake.addReview(t.pr.prNumber, { login: 'vihAan02', state: 'APPROVED', commit_id: t.pr.headSha });
    await s.until(() => s.b.daemon.view(s.project).prs.get(t.task)?.checks['full-macos'] === 'failure', 20_000, 'checks in B\'s view');
    assert.deepEqual(s.b.daemon.view(s.project).prs.get(t.task)!.reviews, [{ login: 'vihAan02', state: 'APPROVED', commit_id: t.pr.headSha }]);
    s.fake.setChecks(t.pr.headSha, { guard: 'success', 'unit-linux': 'success', 'full-macos': 'success' });
    const merge = await s.fake.externalMerge(t.pr.prNumber);
    await s.until(() => s.b.daemon.view(s.project).tasks.get(t.task)?.status === 'landed', 20_000, 'the outside merge to land');
    const land = [...s.b.daemon.view(s.project).lands.values()].find((l) => l.taskId === t.task)!;
    assert.deepEqual([land.mode, land.status, land.newBaseSha], ['external', 'completed', merge]);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal((await s.db.pool.query("SELECT count(*)::int AS n FROM events WHERE project_id = $1 AND kind = 'land.completed'", [s.project])).rows[0].n, 1, 'once');
  } finally { await s.stop(); }
});
