// Hard claims on the harnessd side (0B item 5; D-97): the agent's claim and release tools, and how
// harness_status and `harness status` show leases. (The LeaseKeeper's renewal is B6.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventMessage } from '@harness/protocol';
import { renderAgentStatus, renderHumanStatus } from '../src/status.ts';
import { commandCall, type ToolContext } from '../src/tools/common.ts';
import { LEASE_TOOL_NAMES, leaseTools } from '../src/tools/leases.ts';
import { ProjectView } from '../src/view.ts';

let seq = 0;
const ev = (kind: string, data: Record<string, unknown>): EventMessage =>
  ({ v: 1, type: 'event', project_id: 'prj', seq: ++seq, at: new Date(Date.UTC(2026, 9, 4, 12, 0, seq)).toISOString(), actor: { principal: 'human_a', on_behalf_of: null, device_id: null }, kind, data });

function view(): ProjectView {
  seq = 0;
  const v = new ProjectView('prj');
  for (const e of [
    ev('agent.created', { agent_id: 'agent_b', name: 'agent/backend', vendor: 'claude', accountable_human_id: 'human_a' }),
    ev('agent.created', { agent_id: 'agent_f', name: 'agent/frontend', vendor: 'claude', accountable_human_id: 'human_a' }),
    ev('task.created', { task_id: 'T-1', title: 'API', text: 'x', scope: ['src/api/'], owner_human_id: 'human_a' }),
    ev('task.assigned', { task_id: 'T-1', assignee_agent_id: 'agent_b' }),
    ev('task.created', { task_id: 'T-2', title: 'Page', text: 'x', scope: ['src/web/'], owner_human_id: 'human_a' }),
    ev('task.assigned', { task_id: 'T-2', assignee_agent_id: 'agent_f' }),
    ev('lease.granted', { lease_id: 'ls_1', task_id: 'T-1', path: 'src/types.ts', token: 3, expires_at: '2026-10-04T12:10:00.000Z', by: 'agent_b', force: false }),
    ev('lease.granted', { lease_id: 'ls_2', task_id: 'T-1', path: 'src/api/', token: 4, expires_at: '2026-10-04T12:10:00.000Z', by: 'agent_b', force: false }),
    ev('lease.released', { lease_id: 'ls_2', task_id: 'T-1', reason: 'released', by: 'agent_b' }),
    ev('lease.granted', { lease_id: 'ls_3', task_id: 'T-2', path: 'src/web/', token: 5, expires_at: '2026-10-04T12:01:00.000Z', by: 'human_a', force: true }),
  ]) v.apply(e);
  return v;
}

test('the claim tool asks for a lease for its own task; its result names what was granted, or who holds what', async () => {
  const sent: [string, Record<string, unknown>][] = [];
  let reply: unknown = { granted: [{ lease_id: 'ls_9', path: 'src/types.ts', token: 7, expires_at: '2026-10-04T12:03:04.000Z' }], conflicts: [] };
  const ctx: ToolContext = { view: view(), agentId: 'agent_b', taskId: 'T-1', send: async (name, args) => { sent.push([name, args]); return reply; } };
  const tools = leaseTools(ctx, commandCall(ctx));
  assert.deepEqual(tools.map((t) => t.name), [...LEASE_TOOL_NAMES]);
  const [claim, release] = tools;
  assert.equal(claim!.params.ttl_s!.type, 'number');
  const r = await claim!.run({ paths: ['src/types.ts'], ttl_s: 60 });
  assert.deepEqual(sent.pop(), ['lease.acquire', { task_id: 'T-1', paths: ['src/types.ts'], ttl_s: 60 }]);
  assert.match(r.text, /^Granted:\n- src\/types\.ts: lease ls_9, token 7, renewed by the harness \(expires 12:03:04 UTC unless renewed\)$/);
  reply = { granted: [], conflicts: [{ path: 'src/types.ts', lease_id: 'ls_1', task_id: 'T-2', expires_at: '2026-10-04T12:05:00.000Z' }] };
  assert.equal((await claim!.run({ paths: ['src/types.ts'] })).text, 'Not granted: src/types.ts overlaps lease ls_1 of T-2 until 12:05:00 UTC.', 'the holder\'s lease id, so the agent can wait for it (D-95)');
  assert.deepEqual(sent.pop(), ['lease.acquire', { task_id: 'T-1', paths: ['src/types.ts'] }], 'no ttl_s unless given');
  reply = { released: ['ls_9'] };
  assert.equal((await release!.run({ lease_ids: ['ls_9'] })).text, 'Released ls_9.');
  assert.deepEqual(sent.pop(), ['lease.release', { lease_ids: ['ls_9'] }]);
});

test('harness_status and `harness status` show current hard claims, not released or expired ones', () => {
  const v = view();
  const now = Date.parse('2026-10-04T12:05:00.000Z'); // ls_3 expired at 12:01
  const agent = renderAgentStatus(v, 'agent_b', now);
  assert.match(agent, /Your hard claims: src\/types\.ts \(ls_1, token 3, until 12:10:00 UTC\)/);
  assert.doesNotMatch(agent, /src\/api\/ \(ls_2/, 'released');
  assert.doesNotMatch(agent, /hard claims: src\/web\//, 'expired');
  const human = renderHumanStatus(v, now);
  assert.match(human, /T-1 "API" \[in_progress\][^\n]*\n      scope: src\/api\/\n      changing: none\n      hard claims: src\/types\.ts \(ls_1, token 3, until 12:10:00 UTC\)/);
  const peer = renderAgentStatus(v, 'agent_f', Date.parse('2026-10-04T12:00:30.000Z'));
  assert.match(peer, /- agent\/backend: working on T-1[^\n]*\n  scope: src\/api\/\n  changing: none\n  hard claims: src\/types\.ts \(ls_1, token 3, until 12:10:00 UTC\)/);
  // A finished task keeps its leases until it lands; its holder still shows, with the lease id to wait on.
  v.apply(ev('task.completed', { task_id: 'T-1', by: 'agent_b' }));
  assert.match(renderAgentStatus(v, 'agent_f', Date.parse('2026-10-04T12:00:30.000Z')), /Hard claims of finished tasks waiting to land:\n- T-1 \(agent\/backend\): src\/types\.ts \(ls_1, token 3, until 12:10:00 UTC\)/);
  assert.match(peer, /Your hard claims: src\/web\/ \(ls_3, token 5, until 12:01:00 UTC\)/);
});
