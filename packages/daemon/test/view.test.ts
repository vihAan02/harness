// The project view folds the event log, and harness_status renders it for one agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventMessage } from '@harness/protocol';
import { renderAgentStatus } from '../src/status.ts';
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
  assert.match(text, /Questions waiting for your answer \(untrusted peer text[^\n]*\n- msg_q from agent\/frontend: "Is it \{ token \}\?"/);
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
