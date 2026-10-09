// T-4, a remote start without approval (security.md §8; D-34, D-112): another human's start of this human's agent
// waits for this human's single-use approval, on this Mac. Denied, nothing runs and the server frees the agent;
// approved, it runs. A remote abandon stops the agent and never deletes its work.
// The server, both harnessds, Git and the fake GitHub are real; the agents are stand-ins (test/fake-adapter.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionApprovalDetails } from '../../packages/protocol/src/index.ts';
import { taskSha256 } from '../../packages/protocol/src/signing.ts';
import { Approvals, pendingApproval } from '../../packages/daemon/src/approvals.ts';
import { startPilotStack, type PilotStack } from '../support.ts';

const dataOf = (e: { data: unknown }) => e.data as Record<string, any>;
const sessionApprovals = (s: PilotStack) => new Approvals(s.a.home).pending().filter((r) => r.kind === 'agent_session');

test('T-4: another human\'s start waits for this human\'s approval; denied, the agent is freed; approved, it runs; abandoned remotely, its work stays', async () => {
  const s = await startPilotStack({ files: { 'README.md': 'pilot\n' }, portRanges: { a: [32600, 32679], b: [32680, 32759] }, daemonOptions: { approvalPollMs: 50 } });
  try {
    const agent = (await s.a.command('agent.create', { name: 'agent/helper', vendor: 'claude' })).agent_id!;

    // Denied: nothing runs, and the server frees the agent.
    const first = await s.b.assign(agent, { title: 'docs', text: 'Write the docs.' });
    await s.until(() => sessionApprovals(s).length === 1, 20_000, 'the approval request');
    const req = sessionApprovals(s)[0]!;
    assert.match(req.command, new RegExp(`human_b \\(device dev_b\\) asks your agent agent/helper to start task ${first}`));
    assert.ok(req.command.endsWith('docs\nWrite the docs.'), 'the human sees what it would start, as text');
    // And the UI, structured: who asks, with which dispatch, and the task its hash binds.
    const shown = pendingApproval(req);
    assert.equal(shown.kind, 'agent_session');
    const { nonce, expires_at, task_sha256, ...details } = shown.details as SessionApprovalDetails;
    assert.deepEqual(details, {
      kind: 'start', issuer_human_id: 'human_b', issuer_device_id: 'dev_b', agent_name: 'agent/helper',
      task_id: first, task_title: 'docs', task_text: 'Write the docs.', task_scope: [], task_owner_human_id: 'human_b', message: null,
    });
    assert.equal(task_sha256, taskSha256({ title: 'docs', text: 'Write the docs.', scope: [], owner_human_id: 'human_b' }));
    assert.ok(nonce && Date.parse(expires_at) > Date.now());
    await new Promise((r) => setTimeout(r, 500)); // ten approval polls: it doesn't start on its own
    assert.ok(!s.a.daemon.running.has(first) && s.a.adapter.sessions.length === 0, 'nothing runs before the approval');
    new Approvals(s.a.home).deny(req.id);
    const failed = () => s.a.acted.find((e) => e.kind === 'task.start_failed' && dataOf(e).task_id === first);
    await s.until(() => !!failed(), 20_000, 'the failed start to reach the server');
    assert.deepEqual([dataOf(failed()!).reason, dataOf(failed()!).status], ['approval_denied', 'open']);
    assert.equal(s.a.adapter.sessions.length, 0);

    // Approved: it runs.
    const second = await s.b.assign(agent, { title: 'tests', text: 'Add the tests.' });
    await s.until(() => sessionApprovals(s).length === 1, 20_000, 'the second approval request');
    new Approvals(s.a.home).approve(sessionApprovals(s)[0]!.id);
    await s.until(() => s.a.daemon.running.has(second), 20_000, 'the session once approved');
    const worktree = s.a.daemon.worktreeOf(s.project, second);
    fs.writeFileSync(path.join(worktree, 'notes.md'), 'work in progress\n');

    // Abandoned by the other human: the agent stops, and the work stays on this Mac.
    await s.b.signed('task.abandon', { task_id: second, reason: 'not needed after all' });
    await s.until(() => !s.a.daemon.running.has(second), 20_000, 'the agent to stop');
    await s.until(() => s.a.logs.some((l) => l.includes(`${second} abandoned by human_b; its work stays`)), 20_000, 'the abandon to finish');
    assert.equal(fs.readFileSync(path.join(worktree, 'notes.md'), 'utf8'), 'work in progress\n', 'the worktree and its uncommitted work are kept');
    // And a restart doesn't delete it either.
    await s.a.daemon.recoverTask(s.project, second);
    assert.ok(fs.existsSync(path.join(worktree, 'notes.md')));
  } finally { await s.stop(); }
});
