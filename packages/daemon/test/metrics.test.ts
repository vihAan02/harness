// A/B metrics for the harness arm, from a synthetic event log (docs/validation.md §4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventMessage } from '@harness/protocol';
import { computeMetrics, renderMetrics } from '../src/metrics.ts';
import { ProjectView } from '../src/view.ts';

let seq = 0;
const t0 = Date.parse('2026-10-03T10:00:00.000Z');
const ev = (sec: number, kind: string, data: Record<string, unknown>, principal = 'human_a'): EventMessage =>
  ({ v: 1, type: 'event', project_id: 'prj', seq: ++seq, at: new Date(t0 + sec * 1000).toISOString(), actor: { principal, on_behalf_of: null, device_id: null }, kind, data });

function run(): ProjectView {
  seq = 0;
  const v = new ProjectView('prj');
  for (const e of [
    ev(0, 'agent.created', { agent_id: 'agent_b', name: 'agent/backend', vendor: 'claude', accountable_human_id: 'human_a' }),
    ev(0, 'agent.created', { agent_id: 'agent_f', name: 'agent/frontend', vendor: 'claude', accountable_human_id: 'human_a' }),
    ev(1, 'task.created', { task_id: 'T-1', title: 'API', text: 'x', scope: [], priority: 0, owner_human_id: 'human_a' }),
    ev(1, 'task.assigned', { task_id: 'T-1', assignee_agent_id: 'agent_b' }),
    ev(2, 'task.created', { task_id: 'T-2', title: 'Page', text: 'x', scope: [], priority: 0, owner_human_id: 'human_a' }),
    ev(2, 'task.assigned', { task_id: 'T-2', assignee_agent_id: 'agent_f' }),
    ev(3, 'session.started', { session_id: 's1', agent_id: 'agent_b', task_id: 'T-1', device_id: 'd', worktree: '/w1' }),
    ev(3, 'session.started', { session_id: 's2', agent_id: 'agent_f', task_id: 'T-2', device_id: 'd', worktree: '/w2' }),
    ev(10, 'message.sent', { message_id: 'q1', kind: 'question', from: 'agent_b', to: 'agent_f', text: '?' }, 'agent_b'),
    ev(11, 'message.delivered', { message_id: 'q1', kind: 'question', to: 'agent_f', delivery: 'new_turn', delivered_at: new Date(t0 + 11000).toISOString(), latency_ms: 1000, est_tokens: 80 }),
    ev(14, 'message.sent', { message_id: 'a1', kind: 'answer', from: 'agent_f', to: 'agent_b', in_reply_to: 'q1', text: '!' }, 'agent_f'),
    ev(17, 'message.delivered', { message_id: 'a1', kind: 'answer', to: 'agent_b', delivery: 'between_tools', delivered_at: new Date(t0 + 17000).toISOString(), latency_ms: 3000, est_tokens: 70 }),
    ev(18, 'message.sent', { message_id: 'h1', kind: 'question', from: 'human_a', to: 'agent_f', text: 'status?' }),
    ev(19, 'message.sent', { message_id: 'c1', kind: 'claim_conflict', from: 'harness', to: 'agent_b', text: 'x', priority: 'high' }, 'harness'),
    ev(19, 'overlap.detected', { overlap_id: 'o1', level: 'observed', paths: ['src/a.ts'], tasks: ['T-2', 'T-1'] }),
    ev(20, 'usage.reported', { session_id: 's1', input: 100, output: 10, cache_read: 0, cache_creation: 0, cost_usd: 0.01, tool_calls: { Bash: 2, mcp__harness__ask: 1 }, denied_calls: 1 }),
    ev(30, 'usage.reported', { session_id: 's1', input: 300, output: 30, cache_read: 50, cache_creation: 5, cost_usd: 0.03, tool_calls: { Bash: 3, mcp__harness__ask: 1, mcp__harness__report_done: 1 }, denied_calls: 1 }),
    ev(30, 'usage.reported', { session_id: 's2', input: 200, output: 20, cache_read: 0, cache_creation: 0, cost_usd: 0.02, tool_calls: { mcp__harness__answer: 1 }, denied_calls: 0 }),
    ev(31, 'task.completed', { task_id: 'T-1', by: 'agent_b', summary: 'done' }, 'agent_b'),
    ev(33, 'worktree.committed', { task_id: 'T-1', commit: 'a'.repeat(40), path: '/w1' }),
  ]) v.apply(e);
  return v;
}

test('metrics while a task is still running, then once every task is finished', () => {
  const v = run();
  const live = computeMetrics(v);
  assert.equal(live.window.complete, false);
  assert.equal(live.completionMs, null);
  assert.deepEqual(live.tasks.map((t) => [t.id, t.agent, t.durationMs, t.commit?.slice(0, 4) ?? null]), [['T-1', 'agent/backend', 32_000, 'aaaa'], ['T-2', 'agent/frontend', null, null]]);

  v.apply(ev(40, 'task.completed', { task_id: 'T-2', by: 'human_a', summary: 'stub' }));
  v.apply(ev(41, 'worktree.committed', { task_id: 'T-2', commit: 'b'.repeat(40), path: '/w2' }));
  const m = computeMetrics(v);
  assert.equal(m.completionMs, 40_000, 'M1: first assignment (1 s) to the last commit (41 s)');
  assert.deepEqual([m.interventions.total, m.interventions.events.map((e) => e.detail)], [2, ['question to agent/frontend', 'marked T-2 done']]);
  assert.equal(m.deniedToolCalls, 1);
  assert.deepEqual(m.messages, { total: 4, byKind: { question: 2, answer: 1, claim_conflict: 1 }, agentToAgent: 2, humanToAgent: 1, harnessNotices: 1, held: 0 });
  assert.deepEqual(m.tokens, { input: 500, output: 50, cacheRead: 50, cacheCreation: 5, costUsd: 0.05, sessions: 2, models: [], configured: ['vendor default'], costBasis: [] }, 'the latest running total per session, summed');
  assert.equal(m.coordinationTokensEst, 150);
  assert.deepEqual(m.delivery, { count: 2, byPoint: { new_turn: 1, between_tools: 1 }, latencyMs: { median: 2000, max: 3000 }, questionRoundTripsMs: [7000] });
  assert.deepEqual(m.shimCalls, { 'agent/backend': { ask: 1, report_done: 1 }, 'agent/frontend': { answer: 1 } });
  assert.deepEqual(m.overlaps, { observed: 1, prospective: 0 });
  const text = renderMetrics(m);
  assert.match(text, /M1  completion time: 40\.0 s/);
  assert.match(text, /question → answer round trips: 7\.0 s/);
  assert.match(text, /Not computed from the log:\n  M2 /);
});

test('with the land step, M1 runs until tasks land; M3, M9 and the stale-context notices come from the log (0B)', () => {
  const view = new ProjectView('prj');
  let seq = 0;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 3, 12, 0, s)).toISOString();
  const e = (s: number, kind: string, data: Record<string, unknown>, principal = 'human_a'): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'prj', seq: ++seq, at: at(s), actor: { principal, on_behalf_of: null, device_id: null }, kind, data });
  for (const ev of [
    e(0, 'task.created', { task_id: 'T-1', title: 'a', text: '', scope: [], owner_human_id: 'human_a' }),
    e(0, 'task.assigned', { task_id: 'T-1', assignee_agent_id: 'agent_a' }),
    e(1, 'task.created', { task_id: 'T-2', title: 'b', text: '', scope: [], owner_human_id: 'human_a' }),
    e(1, 'task.assigned', { task_id: 'T-2', assignee_agent_id: 'agent_b' }),
    e(5, 'message.sent', { message_id: 'm1', kind: 'dependency_changed', from: 'harness', to: 'agent_a', to_task_id: 'T-1', stage: 'in_progress', text: 'x' }, 'harness'),
    e(6, 'message.delivered', { message_id: 'm1', delivery: 'new_turn', delivered_at: at(6) }),
    e(8, 'task.completed', { task_id: 'T-2', by: 'agent_b' }),
    e(9, 'worktree.committed', { task_id: 'T-2', commit: 'c2' }),
    e(10, 'land.requested', { land_id: 'land_1', task_id: 'T-2', device_id: 'd', run_tests: true }),
    e(11, 'land.failed', { land_id: 'land_1', task_id: 'T-2', reason: 'tests' }),
    e(12, 'land.requested', { land_id: 'land_2', task_id: 'T-2', device_id: 'd', run_tests: true }),
    e(13, 'land.completed', { land_id: 'land_2', task_id: 'T-2', new_base_sha: 'b', changed_paths: ['src/x.ts'] }),
    e(13, 'message.sent', { message_id: 'm2', kind: 'dependency_changed', from: 'harness', to: 'agent_a', to_task_id: 'T-1', stage: 'landed', text: 'y' }, 'harness'),
    e(14, 'worktree.sync_conflict', { task_id: 'T-1', paths: ['src/x.ts'] }),
    e(20, 'message.delivered', { message_id: 'm2', delivery: 'new_turn', delivered_at: at(20) }),
    e(25, 'task.completed', { task_id: 'T-1', by: 'agent_a' }),
    e(26, 'worktree.committed', { task_id: 'T-1', commit: 'c1' }),
  ]) view.apply(ev);
  let m = computeMetrics(view);
  assert.equal(m.completionForm, 'landed');
  assert.equal(m.window.complete, false, 'T-1 is done and committed but not landed yet');
  view.apply(e(30, 'land.requested', { land_id: 'land_3', task_id: 'T-1', device_id: 'd', run_tests: true }));
  view.apply(e(31, 'land.completed', { land_id: 'land_3', task_id: 'T-1', new_base_sha: 'c', changed_paths: [] }));
  m = computeMetrics(view);
  assert.equal(m.completionMs, 31_000, 'from the first assignment to the last land');
  assert.deepEqual(m.lands, { completed: 2, rejected: 0, failed: { tests: 1 }, conflicts: 0, syncConflicts: 1, firstLandTestFailures: 1 }, 'a sync conflict is no M3 conflict');
  assert.deepEqual(m.notices, { inProgress: { sent: 1, delivered: 1 }, landed: { sent: 1, delivered: 1, beforeReaderFinished: 1 }, superseded: 0 });
  assert.match(renderMetrics(m), /M9a failed tests at first integration: 1/);
  assert.match(renderMetrics(m), /M3  conflicts at integration: 0 .*\n    sync conflicts during the run: 1 \(a diagnostic, not M3\)/);
  assert.equal(m.notComputed.M3, undefined, 'M3 and M9 come from the land step now');
});

test('M5c counts human integration actions apart from M5; M5 counts a human\'s lease actions; H-03 sums capture coverage; H-04 counts re-reads after landed notices', () => {
  const view = new ProjectView('prj');
  let seq = 0;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 4, 12, 0, s)).toISOString();
  const e = (s: number, kind: string, data: Record<string, unknown>, principal = 'human_a'): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'prj', seq: ++seq, at: at(s), actor: { principal, on_behalf_of: null, device_id: null }, kind, data });
  const read = (s: number, path: string, hash: string) => e(s, 'readset.added', { task_id: 'T-1', session_id: 's1', agent_id: 'agent_a', entries: [{ path, hash, source: 'read_tool', confidence: 'high' }] }, 'agent_a');
  const notice = (s: number, id: string, stage: string, paths: string[]) => [
    e(s, 'message.sent', { message_id: id, kind: 'dependency_changed', from: 'harness', to: 'agent_a', to_task_id: 'T-1', stage, paths, text: 'x' }, 'harness'),
    e(s, 'message.delivered', { message_id: id, delivery: 'between_tools', delivered_at: at(s) }),
  ];
  for (const ev of [
    e(0, 'task.created', { task_id: 'T-1', title: 'a', text: '', scope: [], owner_human_id: 'human_a' }),
    e(0, 'task.assigned', { task_id: 'T-1', assignee_agent_id: 'agent_a' }),
    e(1, 'session.started', { session_id: 's1', agent_id: 'agent_a', task_id: 'T-1', device_id: 'd', worktree: '/w1' }),
    read(2, 'src/x.ts', 'h1'),
    ...notice(4, 'm1', 'in_progress', ['src/x.ts']), // another agent's uncommitted edit: a re-read can't show in the log
    read(5, 'src/x.ts', 'h1'),
    ...notice(7, 'm2', 'landed', ['src/y.ts']), // never re-read
    // A human's hard claims: two leases in one command are one action; an agent's own claim isn't one.
    e(8, 'lease.granted', { lease_id: 'ls_1', task_id: 'T-1', path: 'a/', token: 1, expires_at: at(200), ttl_s: 120, by: 'human_a', force: false }),
    e(8, 'lease.granted', { lease_id: 'ls_2', task_id: 'T-1', path: 'b/', token: 2, expires_at: at(200), ttl_s: 120, by: 'human_a', force: false }),
    e(8, 'lease.granted', { lease_id: 'ls_3', task_id: 'T-1', path: 'c/', token: 3, expires_at: at(200), ttl_s: 120, by: 'agent_a', force: false }, 'agent_a'),
    e(9, 'claim.observed', { task_id: 'T-1', session_id: 's1', paths: ['src/gen.ts', 'src/gen2.ts'], source: 'diff' }),
    e(9, 'claim.observed', { task_id: 'T-1', session_id: 's1', paths: ['src/x.ts'], source: 'hook' }),
    ...notice(10, 'm3', 'landed', ['src/x.ts']),
    read(11, 'src/x.ts', 'h2'), // re-read within the window: counted
    ...notice(12, 'm4', 'landed', ['src/z.ts']),
    e(10, 'usage.reported', { session_id: 's1', input: 1, output: 1, tool_calls: { Read: 3 }, denied_calls: 1, hook_coverage: { observed: 5, missed: 1, rejected: 2 }, read_coverage: { read_tool: 3, shell_heuristic: 1, unparsed_shell: 2 } }),
    e(11, 'task.blocked', { task_id: 'T-1', reason: 'sync_conflict', paths: ['src/x.ts'] }),
    e(12, 'task.unblocked', { task_id: 'T-1', by: 'human_a' }),
    e(12, 'setup.approved', { task_id: 'T-1', device_id: 'd', command_hash: 'h' }),
    e(13, 'task.completed', { task_id: 'T-1', by: 'agent_a' }, 'agent_a'),
    read(14, 'src/z.ts', 'h3'), // after the task ended: outside m4's window
    e(14, 'land.requested', { land_id: 'l1', task_id: 'T-1', device_id: 'd', requested_by: 'human_a', run_tests: true }),
    e(15, 'land.failed', { land_id: 'l1', task_id: 'T-1', reason: 'cancelled' }),
    e(16, 'land.requested', { land_id: 'l2', task_id: 'T-1', device_id: 'd', requested_by: 'human_a', run_tests: true }),
    e(16, 'land.progress', { land_id: 'l2', task_id: 'T-1', step: 'awaiting_approval' }),
    // A human takes another lease over: the revoke and the grant are one action. Then a human release.
    e(17, 'lease.released', { lease_id: 'ls_9', task_id: 'T-9', reason: 'revoked', by: 'human_a' }),
    e(17, 'lease.granted', { lease_id: 'ls_4', task_id: 'T-1', path: 'd/', token: 4, expires_at: at(200), ttl_s: 120, by: 'human_a', force: true }),
    e(18, 'lease.released', { lease_id: 'ls_1', task_id: 'T-1', reason: 'released', by: 'human_a' }),
    e(18, 'lease.released', { lease_id: 'ls_2', task_id: 'T-1', reason: 'released', by: 'human_a' }),
    e(19, 'land.completed', { land_id: 'l2', task_id: 'T-1', new_base_sha: 'b', changed_paths: ['src/x.ts'] }),
  ]) view.apply(ev);
  const m = computeMetrics(view);
  assert.deepEqual(m.integrationActions, { total: 6, byKind: { 'task.unblocked': 1, approval: 2, 'land.requested': 2, 'land.cancelled': 1 } });
  assert.deepEqual(m.interventions.events.map((x) => x.detail), ['claimed leases for T-1', 'took over leases for T-1', 'released leases of T-1'], 'M5: one per human lease command');
  assert.deepEqual(m.coverage, { hooks: { observed: 5, missed: 1, rejected: 2 }, reads: { read_tool: 3, shell_heuristic: 1, unparsed_shell: 2 }, editsOnlyByDiff: 2 });
  assert.deepEqual(m.reReads, { landed: { notices: 3, reReadAfter: 1 }, inProgress: { notices: 1 } }, 'm3 re-read in its window; m2 never; m4 only after the task ended');
  const text = renderMetrics(m);
  assert.match(text, /M5c human integration actions: 6 \(task\.unblocked 1, approval 2, land\.requested 2, land\.cancelled 1\)/);
  assert.match(text, /M5  human interventions: 3 \(claimed leases for T-1; took over leases for T-1; released leases of T-1\)/);
  assert.match(text, /H-03 capture: hooks saw 5 tool call\(s\), missed 1, never reached 2; edits found only by a worktree diff 2/);
  assert.match(text, /H-04 re-reads: after 1 of 3 delivered landed notice\(s\), the reader read a named file again before its task ended or the next notice on it\n    1 in-progress notice\(s\) not measured/);
});

test('H-04: a later notice naming the same file ends the earlier one\'s window', () => {
  const view = new ProjectView('prj');
  let seq = 0;
  const at = (s: number) => new Date(Date.UTC(2026, 9, 4, 12, 0, s)).toISOString();
  const e = (s: number, kind: string, data: Record<string, unknown>): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'prj', seq: ++seq, at: at(s), actor: { principal: 'harness', on_behalf_of: null, device_id: null }, kind, data });
  for (const ev of [
    e(0, 'task.created', { task_id: 'T-1', title: 'a', text: '', scope: [], owner_human_id: 'human_a' }),
    e(0, 'task.assigned', { task_id: 'T-1', assignee_agent_id: 'agent_a' }),
    e(1, 'message.sent', { message_id: 'n1', kind: 'dependency_changed', from: 'harness', to: 'agent_a', to_task_id: 'T-1', stage: 'landed', paths: ['src/x.ts'], text: 'x' }),
    e(1, 'message.delivered', { message_id: 'n1', delivery: 'new_turn', delivered_at: at(1) }),
    e(5, 'message.sent', { message_id: 'n2', kind: 'dependency_changed', from: 'harness', to: 'agent_a', to_task_id: 'T-1', stage: 'landed', paths: ['src/x.ts'], text: 'x' }),
    e(5, 'message.delivered', { message_id: 'n2', delivery: 'new_turn', delivered_at: at(5) }),
    e(6, 'readset.added', { task_id: 'T-1', session_id: 's1', agent_id: 'agent_a', entries: [{ path: 'src/x.ts', hash: 'h', source: 'read_tool', confidence: 'high' }] }),
  ]) view.apply(ev);
  assert.deepEqual(computeMetrics(view).reReads.landed, { notices: 2, reReadAfter: 1 }, 'the re-read answers the second notice only');
});
