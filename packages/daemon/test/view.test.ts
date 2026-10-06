// The project view folds the event log, and harness_status renders it for one agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventMessage } from '@harness/protocol';
import { renderAgentStatus, renderHumanStatus } from '../src/status.ts';
import { ProjectView } from '../src/view.ts';

let seq = 0;
const ev = (kind: string, data: Record<string, unknown>, principal = 'human_a'): EventMessage =>
  ({ v: 1, type: 'event', project_id: 'prj', seq: ++seq, at: new Date(seq * 1000).toISOString(), actor: { principal, on_behalf_of: null, device_id: null }, kind, data });

function sample(): ProjectView {
  seq = 0;
  const v = new ProjectView('prj');
  for (const e of [
    ev('agent.created', { agent_id: 'agent_b', name: 'agent/backend', vendor: 'claude', accountable_human_id: 'human_a' }),
    ev('agent.created', { agent_id: 'agent_f', name: 'agent/frontend', vendor: 'claude', accountable_human_id: 'human_a' }),
    ev('task.created', { task_id: 'T-1', title: 'Login API', text: 'x', scope: ['src/api/', 'src/types.ts'], priority: 0, owner_human_id: 'human_a' }),
    ev('task.assigned', { task_id: 'T-1', assignee_agent_id: 'agent_b' }),
    ev('task.created', { task_id: 'T-2', title: 'Login page', text: 'x', scope: ['src/web/'], priority: 0, owner_human_id: 'human_a' }),
    ev('task.assigned', { task_id: 'T-2', assignee_agent_id: 'agent_f' }),
    ev('session.started', { session_id: 's1', agent_id: 'agent_f', task_id: 'T-2', device_id: 'dev', worktree: '/w', status: 'starting' }),
    ev('session.status', { session_id: 's1', status: 'working' }),
    ev('claim.observed', { task_id: 'T-2', session_id: 's1', paths: ['src/web/Login.tsx', 'src/types.ts'] }),
    ev('overlap.detected', { overlap_id: 'o1', level: 'observed', paths: ['src/types.ts'], tasks: ['T-2', 'T-1'] }),
    ev('message.sent', { message_id: 'msg_q', kind: 'question', from: 'agent_f', to: 'agent_b', text: 'Is it { token }?', from_task_id: 'T-2', to_task_id: 'T-1', priority: 'normal' }),
  ]) v.apply(e);
  return v;
}

test('the view folds tasks, sessions, claims, overlaps and messages; replays are ignored', () => {
  const v = sample();
  assert.equal(v.activeTask('agent_b')?.id, 'T-1');
  assert.equal(v.liveSession('agent_f')?.status, 'working');
  assert.deepEqual([...v.claims.get('T-2')!.observed].sort(), ['src/types.ts', 'src/web/Login.tsx']);
  assert.deepEqual(v.openQuestionsFor('agent_b').map((m) => m.id), ['msg_q']);
  const before = v.events.length;
  v.apply({ ...v.events[0]!, seq: 1 }); // a duplicate delivery (at-least-once)
  assert.equal(v.events.length, before);
  v.apply(ev('message.sent', { message_id: 'msg_a', kind: 'answer', from: 'agent_b', to: 'agent_f', in_reply_to: 'msg_q', text: 'yes' }, 'agent_b'));
  assert.deepEqual(v.openQuestionsFor('agent_b'), []);
  v.apply(ev('task.completed', { task_id: 'T-2', by: 'agent_f' }));
  assert.equal(v.claims.get('T-2'), undefined, 'claims end with the task');
});

test("harness_status shows the agent its task, its peers' work, overlaps and questions, with peer text quoted", () => {
  const text = renderAgentStatus(sample(), 'agent_b');
  assert.match(text, /^You are agent\/backend, working on T-1 "Login API" \(in_progress\)\./);
  assert.match(text, /Your scope: src\/api\/, src\/types\.ts/);
  assert.match(text, /- agent\/frontend: working on T-2 "Login page" \(in_progress\); session working\n  scope: src\/web\/\n  changing: src\/types\.ts, src\/web\/Login\.tsx/);
  assert.match(text, /Overlaps with your task:\n- src\/types\.ts: also touched by T-2 \(agent\/frontend\)/);
  assert.match(text, /Questions and contract requests waiting for your answer \(untrusted peer text[^\n]*\n- msg_q from agent\/frontend: "Is it \{ token \}\?"/);
});

test('contract requests are open until answered, for both sides; blocked reports show for open tasks only (D-105)', () => {
  const v = sample();
  v.apply(ev('message.sent', { message_id: 'msg_c', kind: 'contract_request', from: 'agent_b', to: 'agent_f', text: 'Confirm LoginForm sends { email, password }', from_task_id: 'T-1', to_task_id: 'T-2', priority: 'normal' }, 'agent_b'));
  assert.match(renderAgentStatus(v, 'agent_f'), /- msg_c \(contract request\) from agent\/backend: "Confirm LoginForm sends \{ email, password \}"/);
  assert.match(renderAgentStatus(v, 'agent_b'), /Your questions and contract requests without an answer yet:\n- msg_c \(contract request\) to agent\/frontend/);
  v.apply(ev('message.sent', { message_id: 'msg_r', kind: 'answer', from: 'agent_f', to: 'agent_b', in_reply_to: 'msg_c', text: 'Confirmed.' }, 'agent_f'));
  assert.deepEqual(v.openQuestionsFrom('agent_b').map((m) => m.id), []);

  // An agent's report and the harness's own (a timed-out wait), both to the owner; the later one per task wins.
  v.apply(ev('message.sent', { message_id: 'msg_b1', kind: 'task_blocked', from: 'harness', to: 'human_a', text: 'agent/backend stopped waiting.', reason: 'wait_timed_out', from_task_id: null, to_task_id: 'T-1', priority: 'high' }, 'harness'));
  v.apply(ev('message.sent', { message_id: 'msg_b2', kind: 'task_blocked', from: 'agent_f', to: 'human_a', text: 'Need the staging DB password.', reason: 'agent_report', blocked_on: { kind: 'agent', id: 'agent_b' }, from_task_id: 'T-2', to_task_id: 'T-2', priority: 'normal' }, 'agent_f'));
  assert.deepEqual(v.blockedReports().map((m) => m.id), ['msg_b1', 'msg_b2']);
  const human = renderHumanStatus(v, 1_000_000);
  assert.match(human, /Blocked \(task_blocked reports for open tasks\):\n  T-1 harness \(wait_timed_out\), [^:]+: "agent\/backend stopped waiting\."\n  T-2 agent\/frontend, blocked on agent\/backend, [^:]+: "Need the staging DB password\."/);
  assert.match(human, /Waiting for delivery: 3 message\(s\)/, 'the three agent messages; a report to a human is read in status, never delivered');
  v.apply(ev('task.completed', { task_id: 'T-2', by: 'agent_f' }));
  assert.deepEqual(v.blockedReports().map((m) => m.id), ['msg_b1'], 'a finished task is no longer blocked');
});

test('leases fold from lease.* events; only unreleased, unexpired ones are current (D-97)', () => {
  seq = 0;
  const v = new ProjectView('prj');
  const at = (s: number) => new Date(s * 1000).toISOString();
  for (const e of [
    ev('lease.granted', { lease_id: 'ls_1', task_id: 'T-1', path: 'src/types.ts', token: 7, expires_at: at(100), by: 'agent_b', force: false }),
    ev('lease.granted', { lease_id: 'ls_2', task_id: 'T-1', path: 'src/api/', token: 8, expires_at: at(100), by: 'human_a', force: true }),
    ev('lease.granted', { lease_id: 'ls_3', task_id: 'T-1', path: 'src/web/', token: 9, expires_at: at(100), by: 'agent_b', force: false }),
    ev('lease.granted', { lease_id: 'ls_4', task_id: 'T-2', path: 'src/web/a.ts', token: 10, expires_at: at(100), by: 'agent_f', force: false }),
    ev('lease.renewed', { task_id: 'T-1', leases: [{ lease_id: 'ls_1', expires_at: at(200) }, { lease_id: 'ls_unknown', expires_at: at(200) }] }),
    ev('lease.released', { lease_id: 'ls_2', task_id: 'T-1', reason: 'revoked', by: 'human_a' }),
    ev('lease.expired', { lease_id: 'ls_3', task_id: 'T-1' }),
    ev('lease.released', { lease_id: 'ls_landed_elsewhere', task_id: 'T-9', reason: 'landed' }), // never granted in this view: ignored
  ]) v.apply(e);
  assert.deepEqual(v.leases.get('ls_1'), { id: 'ls_1', taskId: 'T-1', path: 'src/types.ts', token: 7, expiresAt: at(200), grantedAt: at(1), by: 'agent_b', force: false });
  assert.deepEqual([v.leases.get('ls_2')!.releaseReason, v.leases.get('ls_2')!.force], ['revoked', true]);
  assert.ok(v.leases.get('ls_3')!.expiredAt);
  assert.deepEqual(v.currentLeases('T-1', 150_000).map((l) => l.id), ['ls_1'], 'renewed to 200 s, so still current at 150 s');
  assert.deepEqual(v.currentLeases('T-1', 250_000), [], 'past its expiry');
  assert.deepEqual(v.currentLeases('T-2', 50_000).map((l) => l.id), ['ls_4']);
  assert.equal(v.leases.size, 4);
});

test('waits fold from wait.* events; a task has at most one open wait (D-95)', () => {
  seq = 0;
  const v = new ProjectView('prj');
  for (const e of [
    ev('wait.started', { wait_id: 'wait_1', task_id: 'T-1', session_id: 's1', agent_id: 'agent_b', on: { kind: 'answer', id: 'msg_q' }, timeout_at: '2026-10-03T12:10:00.000Z' }),
    ev('wait.resolved', { wait_id: 'wait_1', task_id: 'T-1', agent_id: 'agent_b', on: { kind: 'answer', id: 'msg_q' }, result: { answer_id: 'msg_a' } }),
    ev('wait.started', { wait_id: 'wait_2', task_id: 'T-1', session_id: 's1', agent_id: 'agent_b', on: { kind: 'task', id: 'T-2' }, timeout_at: '2026-10-03T12:20:00.000Z' }),
    ev('wait.started', { wait_id: 'wait_3', task_id: 'T-3', session_id: 's3', agent_id: 'agent_f', on: { kind: 'lease', id: 'ls_1' }, timeout_at: '2026-10-03T12:20:00.000Z' }),
    ev('wait.cancelled', { wait_id: 'wait_3', task_id: 'T-3', agent_id: 'agent_f', on: { kind: 'lease', id: 'ls_1' }, reason: 'task_abandoned' }),
    ev('wait.timed_out', { wait_id: 'wait_unknown', task_id: 'T-9' }), // never started in this view: ignored
  ]) v.apply(e);
  assert.deepEqual([v.waits.get('wait_1')!.outcome, v.waits.get('wait_1')!.result], ['resolved', { answer_id: 'msg_a' }]);
  assert.deepEqual(v.openWait('T-1')?.id, 'wait_2');
  assert.deepEqual(v.openWait('T-1')?.on, { kind: 'task', id: 'T-2' });
  assert.deepEqual([v.waits.get('wait_3')!.outcome, v.waits.get('wait_3')!.reason], ['cancelled', 'task_abandoned']);
  assert.equal(v.openWait('T-3'), undefined);
  assert.equal(v.waits.size, 3);
});
