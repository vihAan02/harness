// The UI's read model (D-117): each task's derived state, from the view plus what only this harnessd knows, and a
// snapshot that survives JSON unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventMessage } from '@harness/protocol';
import { deriveTaskState, snapshotOf, type SnapshotLocal } from '../src/snapshot.ts';
import { ProjectView } from '../src/view.ts';

const DAY = Date.parse('2026-10-08T00:00:00Z');
let seq = 0;
const ev = (kind: string, data: Record<string, unknown>, device: string | null = null): EventMessage =>
  ({ v: 1, type: 'event', project_id: 'prj', seq: ++seq, at: new Date(DAY + seq * 1000).toISOString(), actor: { principal: 'human_a', on_behalf_of: null, device_id: device }, kind, data });

const local = (over: Partial<SnapshotLocal> = {}): SnapshotLocal => ({
  deviceId: 'dev_a', principal: 'human_a', integrationMode: 'github', connection: 'connected', approvals: [], publishing: new Set(),
  budget: { dailyBudgetUsd: 0.25, sessionCapUsd: 0.1 }, now: DAY + 3_600_000, ...over,
});

/** One task per state; each built by the events that put a task there. */
function board(): ProjectView {
  seq = 0;
  const v = new ProjectView('prj');
  const task = (id: string, assign = true) => {
    v.apply(ev('task.created', { task_id: id, title: id, text: `do ${id}`, scope: [], priority: 0, owner_human_id: 'human_a' }));
    if (assign) v.apply(ev('task.assigned', { task_id: id, assignee_agent_id: `agent_${id}` }));
  };
  const session = (id: string, task: string, status = 'running') => v.apply(ev('session.started', { session_id: id, agent_id: `agent_${task}`, task_id: task, device_id: 'dev_a', worktree: '/w', status }));
  const done = (id: string) => v.apply(ev('task.completed', { task_id: id }));
  const pr = (task: string, n: number) => v.apply(ev('pr.published', { task_id: task, pr_number: n, url: `https://github.com/o/r/pull/${n}`, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), remote_ref: 'x', device_id: 'dev_a' }));
  v.apply(ev('agent.created', { agent_id: 'agent_run', name: 'agent/run', vendor: 'claude', accountable_human_id: 'human_a' }));
  task('open', false);
  task('starting'); session('s-starting', 'starting', 'starting');
  task('run'); session('s-run', 'run');
  v.apply(ev('usage.reported', { session_id: 's-run', input: 1000, output: 200, cost_usd: 0.03 }));
  task('waiting'); // assigned, no session: a local approval decides
  task('stopped'); session('s-stopped', 'stopped'); v.apply(ev('session.ended', { session_id: 's-stopped', reason: 'harnessd_restarted' }));
  v.apply(ev('usage.reported', { session_id: 's-stopped', cost_usd: 0.02 }));
  task('blocked'); v.apply(ev('task.blocked', { task_id: 'blocked' }));
  task('fetch'); session('s-fetch', 'fetch'); v.apply(ev('worktree.sync_fetch_failed', { task_id: 'fetch', session_id: 's-fetch', reason: 'git fetch: timed out' }));
  task('refetched'); session('s-refetched', 'refetched'); v.apply(ev('worktree.sync_fetch_failed', { task_id: 'refetched', session_id: 's-refetched', reason: 'x' }));
  v.apply(ev('worktree.synced', { task_id: 'refetched', session_id: 's-refetched', old_base_sha: 'b'.repeat(40), new_base_sha: 'c'.repeat(40), changed_paths: [], stale_paths: [] }));
  task('done'); done('done');
  task('approve'); done('approve');
  task('pushing'); done('pushing');
  task('gated'); done('gated'); v.apply(ev('publish.blocked', { task_id: 'gated', reasons: [{ rule: 'ci_workflow', path: '.github/workflows/x.yml' }] }));
  task('pr'); done('pr'); pr('pr', 1);
  v.apply(ev('land.requested', { land_id: 'l-f', task_id: 'pr', device_id: 'dev_a', mode: 'github', pr_number: 1, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) }));
  v.apply(ev('land.failed', { land_id: 'l-f', task_id: 'pr', reason: 'base_moved', detail: 'main moved' }));
  task('merging'); done('merging'); pr('merging', 2);
  v.apply(ev('land.requested', { land_id: 'l-m', task_id: 'merging', device_id: 'dev_a', mode: 'github', pr_number: 2, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) }));
  v.apply(ev('land.progress', { land_id: 'l-m', task_id: 'merging', step: 'merge_requested' }));
  task('unknown'); done('unknown'); pr('unknown', 3);
  v.apply(ev('land.requested', { land_id: 'l-u', task_id: 'unknown', device_id: 'dev_a', mode: 'github', pr_number: 3, head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40) }));
  v.apply(ev('land.progress', { land_id: 'l-u', task_id: 'unknown', step: 'outcome_unknown' }));
  task('landed'); done('landed'); pr('landed', 4);
  v.apply(ev('land.completed', { land_id: 'l-x', task_id: 'landed', new_base_sha: 'd'.repeat(40), changed_paths: ['a.ts'], external: true, pr_number: 4 }));
  task('gone'); v.apply(ev('task.abandoned', { task_id: 'gone' }));
  return v;
}

test('every task\'s derived state, and why', () => {
  const v = board();
  const l = local({ approvals: [{ taskId: 'waiting', kind: 'setup' }, { taskId: 'approve', kind: 'publish' }], publishing: new Set(['pushing']) });
  const states = Object.fromEntries([...v.tasks.values()].map((t) => [t.id, deriveTaskState(v, t, l)]));
  assert.deepEqual(Object.fromEntries(Object.entries(states).map(([k, s]) => [k, s.state])), {
    open: 'open', starting: 'starting', run: 'running', waiting: 'awaiting_approval', stopped: 'stopped', blocked: 'blocked', fetch: 'fetch_pending',
    refetched: 'running', done: 'done', approve: 'publish_pending_approval', pushing: 'publishing', gated: 'publish_blocked', pr: 'pr_open',
    merging: 'integrating', unknown: 'outcome_unknown', landed: 'landed', gone: 'abandoned',
  });
  assert.equal(states.stopped!.detail, 'harnessd_restarted');
  assert.equal(states.fetch!.detail, 'git fetch: timed out');
  assert.equal(states.gated!.detail, 'ci_workflow');
  assert.equal(states.pr!.detail, 'the last integration failed: base_moved');
  assert.equal(states.merging!.detail, 'merge_requested');
  // Without its approval the assigned task is still starting, as far as this device knows.
  assert.equal(deriveTaskState(v, v.tasks.get('waiting')!, local()).state, 'starting');
});

test('the snapshot: JSON-safe, this device\'s spend today, sessions, PRs and lands per task, the latest 200 messages', () => {
  const v = board();
  for (let i = 0; i < 205; i++) v.apply(ev('message.sent', { message_id: `m${i}`, kind: 'note', from: 'human_a', to: null, text: `<b>${i}</b>`, priority: 'normal' }));
  // Another device's session doesn't count toward this device's spend.
  v.apply(ev('session.started', { session_id: 's-other', agent_id: 'agent_run', task_id: 'run', device_id: 'dev_b', worktree: '/w', status: 'running' }));
  v.apply(ev('usage.reported', { session_id: 's-other', cost_usd: 5 }));
  const snap = snapshotOf(v, local());
  assert.deepEqual(JSON.parse(JSON.stringify(snap)), snap);
  assert.equal(snap.v, 1);
  assert.equal(snap.head_seq, v.head);
  assert.deepEqual(snap.budget, { day: '2026-10-08', spent_usd: 0.05, daily_budget_usd: 0.25, session_cap_usd: 0.1 });
  assert.equal(snap.messages.length, 200);
  assert.equal(snap.messages[0]!.id, 'm5');
  assert.equal(snap.messages.at(-1)!.text, '<b>204</b>', 'untrusted text is carried as it is, for the UI to show as text');
  const run = snap.tasks.find((t) => t.id === 'run')!;
  assert.equal(run.session!.id, 's-other', 'the latest session');
  assert.equal(run.cost_usd, 5.03);
  const pr = snap.tasks.find((t) => t.id === 'pr')!;
  assert.equal(pr.pr!.number, 1);
  assert.equal(pr.land!.reason, 'base_moved');
  assert.equal(snap.tasks.find((t) => t.id === 'landed')!.land!.mode, 'external');
  assert.deepEqual(snap.tasks.find((t) => t.id === 'gated')!.publish_blocked, [{ rule: 'ci_workflow', path: '.github/workflows/x.yml' }]);
  const agent = snap.agents.find((a) => a.id === 'agent_run')!;
  assert.deepEqual([agent.device_id, agent.online, agent.live_session_id], ['dev_b', null, 's-other'], 'the device of its latest session; presence unknown until a heartbeat event');
});
