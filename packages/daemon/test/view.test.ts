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
