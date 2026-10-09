// D-115's squash check on the merging device: the merged commit counts only if its parent is the approved base and its
// tree is the approved head's. GitHub (the fake, told to) merges something else: the land fails as verification_failed,
// with an alert, the task is never landed, and its branch and worktree stay for the human. The commit is on the base
// all the same, so the move is reported as one the harness didn't make, and readers hear of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Approvals } from '../../packages/daemon/src/approvals.ts';
import { startPilotStack, type PilotStack } from '../support.ts';

const rows = async (s: PilotStack, kind: string) =>
  (await s.db.pool.query('SELECT data FROM events WHERE project_id = $1 AND kind = $2 ORDER BY seq', [s.project, kind])).rows.map((r) => r.data as Record<string, any>);

test('a merge that isn\'t the approved head on the approved base never lands: the land fails, with an alert, and nothing is cleaned up', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, daemonOptions: { pollMs: 150 } });
  try {
    const agent = (await s.a.command('agent.create', { name: 'agent/verified', vendor: 'claude' })).agent_id!;
    const task = await s.a.assign(agent, { title: 'notes', text: 'Add notes.', scope: [] });
    await s.until(() => s.a.daemon.running.has(task), 20_000, 'the session');
    const worktree = s.a.daemon.worktreeOf(s.project, task);
    fs.writeFileSync(path.join(worktree, 'notes.md'), 'notes\n');
    await s.a.signed('task.complete', { task_id: task });
    await s.until(() => new Approvals(s.a.home).pending().some((r) => r.kind === 'publish' && r.taskId === task), 20_000, 'the publish request');
    new Approvals(s.a.home).approve(new Approvals(s.a.home).pending().find((r) => r.taskId === task)!.id);
    await s.until(() => s.a.daemon.view(s.project).prs.has(task), 20_000, 'the PR');
    const pr = s.a.daemon.view(s.project).prs.get(task)!;

    s.fake.tamperNextSquash = true;
    await s.a.integrate(task, { pr_number: pr.prNumber, head_sha: pr.headSha, base_sha: pr.baseSha });
    await s.until(() => s.a.daemon.view(s.project).lands.get([...s.a.daemon.view(s.project).lands.keys()].at(-1)!)?.status === 'failed', 30_000, 'the land to fail');
    const merged = s.fake.prs().find((p) => p.number === pr.prNumber)!;
    assert.ok(merged.merged, 'GitHub did merge something');
    const [failed] = await rows(s, 'land.failed');
    assert.equal(failed!.reason, 'verification_failed');
    const [alert] = await rows(s, 'security.alert');
    assert.deepEqual([alert!.what, alert!.merge_sha, alert!.task_id], ['merge_not_approved', merged.mergeCommitSha, task]);
    assert.equal((await rows(s, 'land.completed')).length, 0, 'never landed');
    assert.equal((await s.db.pool.query('SELECT status FROM tasks WHERE id = $1', [task])).rows[0].status, 'done');
    assert.ok(s.a.logs.some((l) => l.startsWith('SECURITY: the merge')));
    assert.ok(fs.existsSync(path.join(worktree, 'notes.md')), 'the worktree stays');
    // On the base whatever it holds: the pollers report the move, and the chain follows it.
    await s.until(() => s.b.daemon.view(s.project).events.some((e) => e.kind === 'base.advanced' && (e.data as { new_sha?: string }).new_sha === merged.mergeCommitSha), 20_000, 'the move to be reported');
  } finally { await s.stop(); }
});
