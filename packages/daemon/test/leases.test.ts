// Hard claims on the harnessd side (0B item 5; D-97): the agent's claim and release tools, how
// harness_status and `harness status` show leases, and the LeaseKeeper that renews them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EventMessage } from '@harness/protocol';
import { LeaseKeeper } from '../src/leases.ts';
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

/** A view with tasks T-1 (agent_b, last ran on dev_1) and T-2 (agent_f, last ran on dev_2), and leases granted `sec` seconds ago. */
function keeperView(grants: { id: string; task: string; ttl: number; age: number }[]): ProjectView {
  let n = 0;
  const now = Date.now();
  const e = (kind: string, data: Record<string, unknown>, at = now): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'prj', seq: ++n, at: new Date(at).toISOString(), actor: { principal: 'human_a', on_behalf_of: null, device_id: null }, kind, data });
  const v = new ProjectView('prj');
  for (const ev of [
    e('task.created', { task_id: 'T-1', title: 'a', text: '', scope: [], owner_human_id: 'human_a' }),
    e('task.assigned', { task_id: 'T-1', assignee_agent_id: 'agent_b' }),
    e('task.created', { task_id: 'T-2', title: 'b', text: '', scope: [], owner_human_id: 'human_a' }),
    e('task.assigned', { task_id: 'T-2', assignee_agent_id: 'agent_f' }),
    e('session.started', { session_id: 's0', agent_id: 'agent_b', task_id: 'T-1', device_id: 'dev_2', worktree: '/w1', status: 'starting' }, now - 60_000),
    e('session.started', { session_id: 's1', agent_id: 'agent_b', task_id: 'T-1', device_id: 'dev_1', worktree: '/w1', status: 'starting' }, now - 30_000),
    e('session.started', { session_id: 's2', agent_id: 'agent_f', task_id: 'T-2', device_id: 'dev_2', worktree: '/w2', status: 'starting' }, now - 30_000),
    ...grants.map((g, i) => e('lease.granted', { lease_id: g.id, task_id: g.task, path: `p${i}/`, token: i + 1, expires_at: new Date(now - g.age * 1000 + g.ttl * 1000).toISOString(), by: 'agent_b', force: false }, now - g.age * 1000)),
  ]) v.apply(ev);
  return v;
}

function keeper(v: ProjectView, extra: Partial<ConstructorParameters<typeof LeaseKeeper>[0]> = {}) {
  const sent: [string, Record<string, unknown>, string][] = [];
  const logs: string[] = [];
  const k = new LeaseKeeper({
    view: () => v, log: (m) => logs.push(m), deviceId: 'dev_1', projects: () => ['prj'],
    send: async (_p, name, args, as) => { sent.push([name, args, as]); return { renewed: [], lost: [{ lease_id: 'ls_old', reason: 'expired' }] }; },
    ...extra,
  });
  return { k, sent, logs };
}

test('LeaseKeeper: picks up the tasks this device ran last; renews a lease a third of the way through its TTL', async () => {
  const v = keeperView([{ id: 'ls_fresh', task: 'T-1', ttl: 120, age: 10 }, { id: 'ls_due', task: 'T-1', ttl: 30, age: 11 }, { id: 'ls_peer', task: 'T-2', ttl: 30, age: 29 }]);
  const { k, sent, logs } = keeper(v);
  k.start();
  k.stop(); // drive ticks by hand
  assert.deepEqual([...k.tracked.keys()], ['T-1'], "T-1's latest session ran here; T-2 ran on another device");
  await k.tick();
  assert.deepEqual(sent, [['lease.renew', { lease_ids: ['ls_fresh', 'ls_due'] }, 'agent_b']], 'one is due (11 of 30 s), so all of the task\'s held leases are renewed together');
  assert.match(logs[0]!, /T-1: lease ls_old was lost \(expired\)/);
  assert.deepEqual(k.tokens('prj', 'T-1'), [{ lease_id: 'ls_fresh', token: 1 }, { lease_id: 'ls_due', token: 2 }]);
});

test('LeaseKeeper: nothing due, nothing sent; the fault switch suspends one task; a landed task is dropped', async () => {
  const v = keeperView([{ id: 'ls_a', task: 'T-1', ttl: 120, age: 5 }]);
  const quiet = keeper(v);
  quiet.k.track('prj', 'T-1', 'agent_b');
  await quiet.k.tick();
  assert.deepEqual(quiet.sent, [], '5 of 120 s: not due yet');

  const fixed = keeper(v, { renewMs: 50, faults: { suspendRenewal: (t) => t === 'T-1' } });
  fixed.k.track('prj', 'T-1', 'agent_b');
  await fixed.k.tick();
  assert.deepEqual(fixed.sent, [], 'suspended (T-2)');

  const every = keeper(v, { renewMs: 50 });
  every.k.track('prj', 'T-1', 'agent_b');
  await every.k.tick();
  assert.equal(every.sent.length, 1, 'with a fixed interval, every tick renews');
  v.apply({ v: 1, type: 'event', project_id: 'prj', seq: 99, at: new Date().toISOString(), actor: { principal: 'h', on_behalf_of: null, device_id: null }, kind: 'task.completed', data: { task_id: 'T-1', by: 'agent_b' } });
  v.apply({ v: 1, type: 'event', project_id: 'prj', seq: 100, at: new Date().toISOString(), actor: { principal: 'h', on_behalf_of: null, device_id: null }, kind: 'land.completed', data: { land_id: 'l', task_id: 'T-1', new_base_sha: 'x', changed_paths: [] } });
  await every.k.tick();
  assert.equal(every.sent.length, 1, 'a landed task is no longer renewed');
  assert.deepEqual([...every.k.tracked.keys()], []);
});
