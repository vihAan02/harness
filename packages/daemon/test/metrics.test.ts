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
