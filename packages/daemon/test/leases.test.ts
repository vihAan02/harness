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

/** One event on a fresh sequence: tasks T-1 (agent_b, last ran on dev_1) and T-2 (agent_f, on dev_2) come from `keeperView`. */
let kseq = 0;
const kev = (kind: string, data: Record<string, unknown>, at = Date.now()): EventMessage =>
  ({ v: 1, type: 'event', project_id: 'prj', seq: ++kseq, at: new Date(at).toISOString(), actor: { principal: 'human_a', on_behalf_of: null, device_id: null }, kind, data });
const grant = (id: string, task: string, ttl: number, at = Date.now(), token = 1) =>
  kev('lease.granted', { lease_id: id, task_id: task, path: `${id}/`, token, expires_at: new Date(at + ttl * 1000).toISOString(), ttl_s: ttl, by: 'agent_b', force: false }, at);

function keeperView(): ProjectView {
  kseq = 0;
  const now = Date.now();
  const v = new ProjectView('prj');
  for (const e of [
    kev('task.created', { task_id: 'T-1', title: 'a', text: '', scope: [], owner_human_id: 'human_a' }),
    kev('task.assigned', { task_id: 'T-1', assignee_agent_id: 'agent_b' }),
    kev('task.created', { task_id: 'T-2', title: 'b', text: '', scope: [], owner_human_id: 'human_a' }),
    kev('task.assigned', { task_id: 'T-2', assignee_agent_id: 'agent_f' }),
    kev('session.started', { session_id: 's0', agent_id: 'agent_b', task_id: 'T-1', device_id: 'dev_2', worktree: '/w1', status: 'starting' }, now - 60_000),
    kev('session.started', { session_id: 's1', agent_id: 'agent_b', task_id: 'T-1', device_id: 'dev_1', worktree: '/w1', status: 'starting' }, now - 30_000),
    kev('session.started', { session_id: 's2', agent_id: 'agent_f', task_id: 'T-2', device_id: 'dev_2', worktree: '/w2', status: 'starting' }, now - 30_000),
  ]) v.apply(e);
  return v;
}

/** A keeper on a clock the test moves; `reply` decides what each lease.renew answers. */
function keeper(v: ProjectView, extra: Partial<ConstructorParameters<typeof LeaseKeeper>[0]> = {}) {
  const clock = { t: Date.now() };
  const sent: string[][] = [];
  const logs: string[] = [];
  let reply: (ids: string[]) => unknown = (ids) => ({ renewed: ids.map((lease_id) => ({ lease_id, expires_at: '' })), lost: [] });
  const k = new LeaseKeeper({
    view: () => v, log: (m) => logs.push(m), deviceId: 'dev_1', projects: () => ['prj'], now: () => clock.t,
    send: async (_p, name, args, as) => {
      assert.deepEqual([name, as], ['lease.renew', 'agent_b']);
      const ids = args.lease_ids as string[];
      sent.push(ids);
      return reply(ids);
    },
    ...extra,
  });
  return { k, sent, logs, clock, setReply: (r: typeof reply) => { reply = r; } };
}
const sec = 1000;

test('LeaseKeeper after a restart: picks up the tasks this device ran last, renews each lease once, then every ttl/3', async () => {
  const v = keeperView();
  // Granted an hour ago with a 120 s TTL and renewed since: replaying the log mustn't make it look due forever.
  v.apply(grant('ls_a', 'T-1', 120, Date.now() - 3600 * sec));
  v.apply(kev('lease.renewed', { task_id: 'T-1', leases: [{ lease_id: 'ls_a', expires_at: new Date(Date.now() + 100 * sec).toISOString() }] }));
  v.apply(grant('ls_peer', 'T-2', 30));
  const { k, sent, clock } = keeper(v);
  k.start();
  k.stop(); // drive the ticks by hand
  assert.deepEqual([...k.tracked.keys()], ['T-1'], "T-1's latest session ran here; T-2 ran on another device");
  await k.tick();
  assert.deepEqual(sent, [['ls_a']], 'once, at once');
  for (let i = 0; i < 5; i++) { clock.t += sec; await k.tick(); }
  assert.equal(sent.length, 1, 'not again 5 s later');
  clock.t += 35 * sec; // 40 s after the renewal arrived: a third of 120 s
  await k.tick();
  assert.equal(sent.length, 2, 'next renewal a third of the TTL after the last one arrived');
});

test('LeaseKeeper: a lease granted while it runs is first due a third of its TTL after this device received it', async () => {
  const v = keeperView();
  const { k, sent, clock } = keeper(v);
  k.track('prj', 'T-1', 'agent_b');
  v.apply(grant('ls_new', 'T-1', 30));
  await k.tick();
  clock.t += 9 * sec;
  await k.tick();
  assert.deepEqual(sent, [], 'not before 10 s');
  clock.t += 1 * sec;
  await k.tick();
  assert.deepEqual(sent, [['ls_new']]);
});

test('LeaseKeeper: renews in batches of 200; backs off after a failure; logs and drops lost leases', async () => {
  const v = keeperView();
  const { k, sent, logs, clock, setReply } = keeper(v);
  k.track('prj', 'T-1', 'agent_b');
  for (let i = 0; i < 250; i++) v.apply(grant(`ls_${i}`, 'T-1', 30, Date.now(), i + 1));
  await k.tick(); // received
  clock.t += 10 * sec;
  await k.tick();
  assert.deepEqual(sent.map((b) => b.length), [200, 50]);

  setReply(() => { throw new Error('server unreachable'); });
  sent.length = 0;
  clock.t += 10 * sec;
  await k.tick();
  assert.equal(sent.length, 2, 'both batches tried, both failed');
  assert.match(logs.at(-1)!, /renewing 50 lease\(s\) failed \(server unreachable\); retrying in 1 s/);
  clock.t += 500;
  await k.tick();
  assert.equal(sent.length, 2, 'not before the backoff');
  clock.t += 500;
  await k.tick();
  assert.equal(sent.length, 4, 'retried after 1 s');
  clock.t += 1 * sec;
  await k.tick();
  assert.equal(sent.length, 4, 'the second failure waits 2 s');
  clock.t += 1 * sec;
  setReply((ids) => ({ renewed: [], lost: ids.map((lease_id) => ({ lease_id, reason: 'expired' })) }));
  await k.tick();
  assert.equal(sent.length, 6);
  assert.match(logs.at(-1)!, /T-1: lease ls_\d+ was lost \(expired\); it isn't renewed again/);
});

test('LeaseKeeper: the fault switch suspends one task; a landed task is dropped; tokens include expired leases', async () => {
  const v = keeperView();
  v.apply(grant('ls_a', 'T-1', 30));
  v.apply(grant('ls_b', 'T-1', 30, Date.now(), 2));
  v.apply(kev('lease.expired', { lease_id: 'ls_b', task_id: 'T-1' }));
  const asleep = keeper(v, { renewMs: 50, faults: { suspendRenewal: (t) => t === 'T-1' } });
  asleep.k.track('prj', 'T-1', 'agent_b');
  await asleep.k.tick();
  assert.deepEqual(asleep.sent, [], 'suspended (T-2)');

  const every = keeper(v, { renewMs: 50 });
  every.k.track('prj', 'T-1', 'agent_b');
  await every.k.tick();
  assert.deepEqual(every.sent, [['ls_a']], 'with a fixed interval, every tick renews; an expired lease is never sent');
  assert.deepEqual(every.k.tokens('prj', 'T-1'), [{ lease_id: 'ls_a', token: 1 }, { lease_id: 'ls_b', token: 2 }], 'the server decides if an expired lease still counts');
  v.apply(kev('task.completed', { task_id: 'T-1', by: 'agent_b' }));
  v.apply(kev('land.completed', { land_id: 'l', task_id: 'T-1', new_base_sha: 'x', changed_paths: [] }));
  await every.k.tick();
  assert.equal(every.sent.length, 1, 'a landed task is no longer renewed');
  assert.deepEqual([...every.k.tracked.keys()], []);
});

test('LeaseKeeper: a re-claim that changes a lease\'s TTL reschedules its renewal, either way', async () => {
  const v = keeperView();
  const { k, sent, clock } = keeper(v);
  k.track('prj', 'T-1', 'agent_b');
  v.apply(grant('ls_s', 'T-1', 600));
  await k.tick(); // received: next due in 200 s
  // The task re-claims it with ttl_s 10 (B5): its expiry can't move earlier, but harnessd must renew by 10 s now.
  v.apply(kev('lease.renewed', { task_id: 'T-1', leases: [{ lease_id: 'ls_s', expires_at: new Date(clock.t + 600 * sec).toISOString(), ttl_s: 10 }] }));
  await k.tick(); // the change is seen
  clock.t += 3 * sec;
  await k.tick();
  assert.deepEqual(sent, [], 'not yet: a third of 10 s from when the change was seen');
  clock.t += 1 * sec;
  await k.tick();
  assert.deepEqual(sent, [['ls_s']], 'brought forward to the new, shorter schedule');

  // The reverse: 10 s, then re-claimed for 600 s. After the next renewal, it isn't renewed every few seconds.
  v.apply(kev('lease.renewed', { task_id: 'T-1', leases: [{ lease_id: 'ls_s', expires_at: new Date(clock.t + 600 * sec).toISOString(), ttl_s: 600 }] }));
  for (let i = 0; i < 60; i++) { clock.t += sec; await k.tick(); }
  assert.equal(sent.length, 2, 'one renewal on the old schedule, then none for 60 s');
});

test('LeaseKeeper: a lease granted before its task was tracked is renewed at once, not a third of its TTL later', async () => {
  const v = keeperView();
  v.apply(grant('ls_early', 'T-1', 120, Date.now() - 90 * sec)); // a human's `harness claim`, 90 s before the agent started
  const { k, sent } = keeper(v);
  k.track('prj', 'T-1', 'agent_b');
  await k.tick();
  assert.deepEqual(sent, [['ls_early']], 'its age is unknown to this keeper, so it renews now');
});

test('LeaseKeeper: the next renewal is scheduled from when this one was sent, not when its reply came', async () => {
  const v = keeperView();
  const { k, sent, clock, setReply } = keeper(v);
  k.track('prj', 'T-1', 'agent_b');
  v.apply(grant('ls_slow', 'T-1', 120));
  await k.tick();
  clock.t += 40 * sec;
  // A reply that arrives 30 s later (say, replayed after a reconnect).
  setReply((ids) => { clock.t += 30 * sec; return { renewed: ids.map((lease_id) => ({ lease_id, expires_at: '', ttl_s: 120 })), lost: [] }; });
  await k.tick();
  assert.equal(sent.length, 1);
  clock.t += 10 * sec; // 40 s after it was sent, 10 s after the reply
  await k.tick();
  assert.equal(sent.length, 2, 'due a third of the TTL after it was sent');
});

test('LeaseKeeper: tokens() presents one token per path, the highest the task holds', () => {
  const v = keeperView();
  v.apply(kev('lease.granted', { lease_id: 'ls_p1', task_id: 'T-1', path: 'p/', token: 1, expires_at: new Date().toISOString(), ttl_s: 10, by: 'agent_b', force: false }));
  v.apply(kev('lease.expired', { lease_id: 'ls_p1', task_id: 'T-1' }));
  v.apply(kev('lease.granted', { lease_id: 'ls_p2', task_id: 'T-1', path: 'p/', token: 7, expires_at: new Date().toISOString(), ttl_s: 10, by: 'agent_b', force: false }));
  v.apply(kev('lease.granted', { lease_id: 'ls_q', task_id: 'T-1', path: 'q.ts', token: 3, expires_at: new Date().toISOString(), ttl_s: 10, by: 'agent_b', force: false }));
  v.apply(kev('lease.granted', { lease_id: 'ls_r', task_id: 'T-1', path: 'r/', token: 4, expires_at: new Date().toISOString(), ttl_s: 10, by: 'agent_b', force: false }));
  v.apply(kev('lease.released', { lease_id: 'ls_r', task_id: 'T-1', reason: 'released', by: 'agent_b' }));
  const { k } = keeper(v);
  assert.deepEqual(k.tokens('prj', 'T-1'), [{ lease_id: 'ls_q', token: 3 }, { lease_id: 'ls_p2', token: 7 }]);
});
