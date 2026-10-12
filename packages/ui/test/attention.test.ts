// The attention queue's model (D-117): every "you" rule and every "others" rule, each with a control that must not
// trigger it, and the routes the view navigates by.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PendingApproval, ProjectSnapshot, TaskSnapshot } from '@harness/protocol';
import { attention } from '../web/model/attention.ts';

function task(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'T-1', title: 'A task', text: 'do it', scope: ['src/**'], owner_human_id: 'h1', priority: 0,
    assignee_agent_id: null, task_sha256: 'sha', status: 'open', state: 'open', state_detail: null,
    summary: null, created_at: '2026-10-12T00:00:00.000Z', assigned_at: null, completed_at: null,
    session: null, pr: null, land: null, publish_blocked: null, stale_reads: [], changing: [], overlaps: [],
    leases: [], open_wait: null, cost_usd: 0, ...over,
  };
}

function snapshot(over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    v: 1, project_id: 'p1', head_seq: 1, integration_mode: 'local', taken_at: '2026-10-12T00:00:00.000Z',
    device_id: 'dev-1', principal: 'me', connection: 'connected',
    tasks: [], agents: [], devices: [], messages: [], waits: [], lands: [], base_advances: [],
    budget: { day: '2026-10-12', spent_usd: 0, daily_budget_usd: null, session_cap_usd: null },
    repo: { github_repo: null, base_branch: 'main' }, alerts: [], provider: { circuit: null }, ...over,
  };
}

const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const keys = (items: ReturnType<typeof attention>) => items.map((i) => i.key);
const find = (items: ReturnType<typeof attention>, key: string) => items.find((i) => i.key === key);

function approval(over: Partial<PendingApproval> = {}): PendingApproval {
  return { id: 'ap1', project_id: 'p1', task_id: 'T-1', command: 'run it', manifests: [], hash: 'h', requested_at: 'x', kind: 'setup', details: null, ...over } as PendingApproval;
}

test('each approval kind has its title and its own route', () => {
  const snap = snapshot({ tasks: [task({ id: 'T-1', title: 'Widget' })] });
  const setup = attention(snap, [approval({ kind: 'setup' })], null, NOW);
  assert.equal(find(setup, 'approval:ap1')?.title, 'Approve the setup command for Widget');
  assert.equal(find(setup, 'approval:ap1')?.route, '#/approval/ap1');
  assert.equal(find(setup, 'approval:ap1')?.group, 'you');
  assert.equal(find(setup, 'approval:ap1')?.level, 'act');

  assert.match(attention(snap, [approval({ kind: 'test' })], null, NOW)[0]?.title ?? '', /test command for landing Widget/);
  assert.match(attention(snap, [approval({ kind: 'publish' })], null, NOW)[0]?.title ?? '', /publishing Widget as a PR/);
  assert.match(attention(snap, [approval({ kind: 'security_review' })], null, NOW)[0]?.title ?? '', /held message for Widget/);
});

test('an approval detail is the command\'s first line, cut to 160, and null for the kinds that show everything', () => {
  const snap = snapshot({ tasks: [task({ id: 'T-1', title: 'Widget' })] });

  const publish = find(attention(snap, [approval({ kind: 'publish', command: 'Title\n\nBody\nmore' })], null, NOW), 'approval:ap1');
  assert.equal(publish?.detail, null, 'a publish command is the whole PR body: the board shows none of it');

  const short = find(attention(snap, [approval({ kind: 'agent_session' })], null, NOW), 'approval:ap1');
  assert.equal(short?.detail, null, 'an agent_session approval has its own page');

  const review = find(attention(snap, [approval({ kind: 'security_review' })], null, NOW), 'approval:ap1');
  assert.equal(review?.detail, null, 'a security_review approval has its own page');

  const testKind = find(attention(snap, [approval({ kind: 'test', command: 'npm run check\n-- --reporter=x' })], null, NOW), 'approval:ap1');
  assert.equal(testKind?.detail, 'npm run check', 'the first line only');

  const long = find(attention(snap, [approval({ kind: 'setup', command: 'y'.repeat(200) })], null, NOW), 'approval:ap1');
  assert.equal(long?.detail, `${'y'.repeat(160)}…`);
});

test('an agent_session approval names the issuer and agent, and falls back when details are null', () => {
  const snap = snapshot({ tasks: [task({ id: 'T-2', title: 'Widget' })] });
  const details = { kind: 'start' as const, issuer_human_id: 'alice', issuer_device_id: 'd', nonce: 'n', expires_at: 'x', agent_name: 'Bot', task_id: 'T-2', task_title: 'Widget', task_text: 't', task_scope: [], task_owner_human_id: 'o', task_sha256: 's', message: null };
  const withDetails = attention(snap, [approval({ task_id: 'T-2', kind: 'agent_session', details })], null, NOW);
  assert.equal(withDetails[0]?.title, 'alice asks to start Bot on Widget');
  const without = attention(snap, [approval({ task_id: 'T-2', kind: 'agent_session', details: null })], null, NOW);
  assert.equal(without[0]?.title, "Another human's request for Widget");
});

test('a control with no approvals has no approval item', () => {
  assert.equal(attention(snapshot(), null, null, NOW).filter((i) => i.key.startsWith('approval:')).length, 0);
  assert.equal(attention(snapshot(), [], null, NOW).filter((i) => i.key.startsWith('approval:')).length, 0);
});

test('the provider circuit is an act, from the snapshot or the health reply', () => {
  const fromSnap = attention(snapshot({ provider: { circuit: { kind: 'auth', reason: 'bad key', at: 'x' } } }), null, null, NOW);
  const item = find(fromSnap, 'circuit:auth');
  assert.equal(item?.level, 'act');
  assert.equal(item?.route, '#/integration');
  assert.match(item?.title ?? '', /provider refused \(auth\)/);
  assert.equal(item?.detail, 'bad key');

  const fromHealth = attention(snapshot(), null, { provider_circuit: { kind: 'billing', reason: 'no funds' } }, NOW);
  assert.ok(fromHealth.some((i) => i.key === 'circuit:billing'));

  const cleared = attention(snapshot(), null, { provider_circuit: null }, NOW);
  assert.equal(cleared.filter((i) => i.key.startsWith('circuit:')).length, 0, 'a closed circuit makes no item');
});

test('the budget warns at 80% and acts when used up', () => {
  const over = attention(snapshot({ budget: { day: '2026-10-12', spent_usd: 5, daily_budget_usd: 5, session_cap_usd: null } }), null, null, NOW);
  const item = find(over, 'budget:over');
  assert.equal(item?.level, 'act');
  assert.match(item?.title ?? '', /used up/);
  assert.match(item?.detail ?? '', /UTC day 2026-10-12/);

  const warn = find(attention(snapshot({ budget: { day: 'd', spent_usd: 9, daily_budget_usd: 10, session_cap_usd: null } }), null, null, NOW), 'budget:warn');
  assert.equal(warn?.level, 'warn');

  const ok = attention(snapshot({ budget: { day: 'd', spent_usd: 1, daily_budget_usd: 10, session_cap_usd: null } }), null, null, NOW);
  assert.equal(ok.filter((i) => i.key.startsWith('budget:')).length, 0, 'a control under 80% makes no item');
});

test('my stopped, blocked and publish_blocked tasks are acts; others are not', () => {
  const stopped = attention(snapshot({ tasks: [task({ id: 'T-9', owner_human_id: 'me', state: 'stopped', state_detail: 'hit its cap' })] }), null, null, NOW);
  const item = find(stopped, 'stopped:T-9');
  assert.equal(item?.level, 'act');
  assert.match(item?.title ?? '', /hit its cap/);

  const defaulted = find(attention(snapshot({ tasks: [task({ id: 'T-9', owner_human_id: 'me', state: 'stopped' })] }), null, null, NOW), 'stopped:T-9');
  assert.match(defaulted?.title ?? '', /its session ended/);

  assert.match(find(attention(snapshot({ tasks: [task({ id: 'T-9', owner_human_id: 'me', state: 'blocked' })] }), null, null, NOW), 'blocked:T-9')?.title ?? '', /blocked/);
  assert.match(find(attention(snapshot({ tasks: [task({ id: 'T-9', owner_human_id: 'me', state: 'publish_blocked', state_detail: 'a manifest' })] }), null, null, NOW), 'publish_blocked:T-9')?.title ?? '', /a manifest/);

  const notMine = attention(snapshot({ tasks: [task({ id: 'T-9', owner_human_id: 'other', state: 'stopped' })] }), null, null, NOW);
  assert.equal(notMine.filter((i) => i.key === 'stopped:T-9').length, 0, 'a control I do not own makes no act');
});

test('a ready-to-integrate PR fires only when checks all pass and I am the agent human', () => {
  const pr = { number: 1, url: 'u', head_sha: 'h', base_sha: 'b', state: 'open' as const, merged: false, merge_sha: null, mergeable_state: null, checks: { ci: 'success' }, reviews: [], updated_at: 'x' };
  const snap = snapshot({
    principal: 'me',
    agents: [{ id: 'a1', name: 'Bot', vendor: 'claude', human_id: 'me', device_id: 'dev-1', online: true, active_task_id: 'T-1', live_session_id: null }],
    tasks: [task({ id: 'T-1', owner_human_id: 'me', assignee_agent_id: 'a1', state: 'pr_open', pr })],
  });
  const ready = find(attention(snap, null, null, NOW), 'ready:T-1');
  assert.equal(ready?.route, '#/integration');
  assert.equal(ready?.level, 'act');

  const failing = { ...pr, checks: { ci: 'success', lint: 'failure' } };
  const fail = find(attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'me', state: 'pr_open', pr: failing })] }), null, null, NOW), 'checks:T-1');
  assert.match(fail?.title ?? '', /lint/);
  assert.equal(fail?.level, 'act');

  const noChecks = attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'me', state: 'pr_open', pr: { ...pr, checks: {} } })] }), null, null, NOW);
  assert.equal(noChecks.filter((i) => i.key === 'ready:T-1').length, 0, 'no checks means not ready');

  const notMyAgent = attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'me', state: 'pr_open', pr })] }), null, null, NOW);
  assert.equal(notMyAgent.filter((i) => i.key === 'ready:T-1').length, 0, 'no agent human means no ready act');
});

test('an open unassigned task is info; an assigned one is not', () => {
  const unassigned = find(attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'me', state: 'open' })] }), null, null, NOW), 'unassigned:T-1');
  assert.equal(unassigned?.level, 'info');
  const assigned = attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'me', state: 'open', assignee_agent_id: 'a1' })] }), null, null, NOW);
  assert.equal(assigned.filter((i) => i.key === 'unassigned:T-1').length, 0);
});

test('stale reads warn only while starting, running or stopped', () => {
  for (const state of ['starting', 'running', 'stopped'] as const) {
    const item = find(attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'me', state, stale_reads: ['a.ts'] })] }), null, null, NOW), 'stale:T-1');
    assert.equal(item?.level, 'warn', state);
    assert.match(item?.title ?? '', /a\.ts/);
  }
  const none = attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'me', state: 'running', stale_reads: [] })] }), null, null, NOW);
  assert.equal(none.filter((i) => i.key === 'stale:T-1').length, 0, 'a control with no stale reads makes no item');
});

test('a question to my agent with no reply is info; a reply or another agent is not', () => {
  const agents = [{ id: 'a1', name: 'Bot', vendor: 'claude', human_id: 'me', device_id: 'dev-1', online: true, active_task_id: 'T-1', live_session_id: null }];
  const asked = { id: 'm1', kind: 'question', from: 'peer', to: 'a1', from_task: null, to_task: 'T-1', in_reply_to: null, text: 'why?', priority: 'normal', sent_at: 'x', seq: 1, delivered_at: null, held: false };
  const open = find(attention(snapshot({ agents, messages: [asked] }), null, null, NOW), 'question:m1');
  assert.equal(open?.level, 'info');
  assert.match(open?.title ?? '', /Bot was asked: why\?/);

  const replied = attention(snapshot({ agents, messages: [asked, { ...asked, id: 'm2', in_reply_to: 'm1' }] }), null, null, NOW);
  assert.equal(replied.filter((i) => i.key === 'question:m1').length, 0, 'a reply clears it');

  const otherAgent = attention(snapshot({ agents: [{ ...agents[0]!, human_id: 'other', id: 'a2' }], messages: [{ ...asked, to: 'a2' }] }), null, null, NOW);
  assert.equal(otherAgent.filter((i) => i.key === 'question:m1').length, 0, 'another human\'s agent is a control');
});

test('a long question is trimmed to 120 characters', () => {
  const agents = [{ id: 'a1', name: 'Bot', vendor: 'claude', human_id: 'me', device_id: 'dev-1', online: true, active_task_id: null, live_session_id: null }];
  const asked = { id: 'm1', kind: 'question', from: 'peer', to: 'a1', from_task: null, to_task: null, in_reply_to: null, text: 'x'.repeat(300), priority: 'normal', sent_at: 'x', seq: 1, delivered_at: null, held: false };
  const item = find(attention(snapshot({ agents, messages: [asked] }), null, null, NOW), 'question:m1');
  assert.equal((item?.title ?? '').endsWith('x'.repeat(120)), true);
});

test('a held message to my agent warns; an ordinary one is info', () => {
  const agents = [{ id: 'a1', name: 'Bot', vendor: 'claude', human_id: 'me', device_id: 'dev-1', online: true, active_task_id: 'T-1', live_session_id: null }];
  const asked = { id: 'm1', kind: 'question', from: 'peer', to: 'a1', from_task: null, to_task: 'T-1', in_reply_to: null, text: 'why?', priority: 'normal', sent_at: 'x', seq: 1, delivered_at: null, held: false };

  const held = find(attention(snapshot({ agents, messages: [{ ...asked, held: true }] }), null, null, NOW), 'question:m1');
  assert.equal(held?.level, 'warn');
  assert.equal(held?.title, 'A message to Bot is held for your review: why?');

  const notHeld = find(attention(snapshot({ agents, messages: [asked] }), null, null, NOW), 'question:m1');
  assert.equal(notHeld?.level, 'info');
  assert.equal(notHeld?.title, 'Bot was asked: why?');
});

test('"others": awaiting approval by another human; mine is a control', () => {
  const agents = [{ id: 'a1', name: 'Bot', vendor: 'claude', human_id: 'alice', device_id: 'dev-1', online: true, active_task_id: 'T-1', live_session_id: null }];
  const item = find(attention(snapshot({ agents, tasks: [task({ id: 'T-1', state: 'awaiting_approval', assignee_agent_id: 'a1', state_detail: 'nonce x' })] }), null, null, NOW), 'awaiting:T-1');
  assert.equal(item?.group, 'others');
  assert.match(item?.title ?? '', /waits for alice to approve its start/);
  assert.equal(item?.detail, 'nonce x');

  const mineAgent = attention(snapshot({ agents: [{ ...agents[0]!, human_id: 'me' }], tasks: [task({ id: 'T-1', state: 'awaiting_approval', assignee_agent_id: 'a1' })] }), null, null, NOW);
  assert.equal(mineAgent.filter((i) => i.key === 'awaiting:T-1').length, 0, 'my own agent is a control');
});

test('an open wait shows the kind, id and a UTC time', () => {
  const wait = { id: 'w1', task_id: 'T-1', session_id: 's', on: { kind: 'message', id: 'm1' }, outcome: 'waiting' as const, started_at: 'x', timeout_at: '2026-10-12T15:30:00.000Z', finished_at: null, reason: null };
  const item = find(attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'me', open_wait: wait })] }), null, null, NOW), 'wait:T-1');
  assert.match(item?.title ?? '', /waits for message m1/);
  assert.equal(item?.detail, 'until 15:30');
  const none = attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'me', open_wait: null })] }), null, null, NOW);
  assert.equal(none.filter((i) => i.key === 'wait:T-1').length, 0);
});

test('an open wait on a task that is not mine makes no item', () => {
  const wait = { id: 'w1', task_id: 'T-1', session_id: 's', on: { kind: 'message', id: 'm1' }, outcome: 'waiting' as const, started_at: 'x', timeout_at: '2026-10-12T15:30:00.000Z', finished_at: null, reason: null };
  const notMine = attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'other', open_wait: wait })] }), null, null, NOW);
  assert.equal(notMine.filter((i) => i.key === 'wait:T-1').length, 0, 'another human\'s task is a control');

  const agents = [{ id: 'a1', name: 'Bot', vendor: 'claude', human_id: 'me', device_id: 'dev-1', online: true, active_task_id: 'T-1', live_session_id: null }];
  const viaAgent = find(attention(snapshot({ agents, tasks: [task({ id: 'T-1', owner_human_id: 'other', assignee_agent_id: 'a1', open_wait: wait })] }), null, null, NOW), 'wait:T-1');
  assert.ok(viaAgent !== undefined, 'my agent\'s task is mine');
});

test('integrating, outcome_unknown and fetch_pending are "others"', () => {
  const integrating = find(attention(snapshot({ tasks: [task({ id: 'T-1', state: 'integrating', state_detail: 'testing' })] }), null, null, NOW), 'integrating:T-1');
  assert.equal(integrating?.group, 'others');
  assert.match(integrating?.title ?? '', /integrating \(testing\)/);

  const outcome = find(attention(snapshot({ tasks: [task({ id: 'T-1', state: 'outcome_unknown' })] }), null, null, NOW), 'outcome:T-1');
  assert.equal(outcome?.level, 'warn');
  assert.match(outcome?.detail ?? '', /asking GitHub again/);

  const fetch = find(attention(snapshot({ tasks: [task({ id: 'T-1', state: 'fetch_pending' })] }), null, null, NOW), 'fetch:T-1');
  assert.equal(fetch?.level, 'warn');
});

test('an offline device running an active task warns; an online one is a control', () => {
  const agents = [{ id: 'a1', name: 'Bot', vendor: 'claude', human_id: 'alice', device_id: 'dev-2', online: false, active_task_id: 'T-1', live_session_id: null }];
  const offline = find(attention(snapshot({ agents, devices: [{ device_id: 'dev-2', online: false, at: 'x' }] }), null, null, NOW), 'offline:dev-2:T-1');
  assert.equal(offline?.level, 'warn');
  assert.match(offline?.title ?? '', /dev-2 is offline/);
  assert.match(offline?.detail ?? '', /Bot on T-1/);

  const online = attention(snapshot({ agents: [{ ...agents[0]!, online: true }], devices: [{ device_id: 'dev-2', online: true, at: 'x' }] }), null, null, NOW);
  assert.equal(online.filter((i) => i.key.startsWith('offline:')).length, 0, 'an online device is a control');
});

test('keys are unique and stable across two runs', () => {
  const snap = snapshot({
    tasks: [task({ id: 'T-1', owner_human_id: 'me', state: 'stopped' }), task({ id: 'T-2', state: 'integrating' })],
    budget: { day: 'd', spent_usd: 10, daily_budget_usd: 10, session_cap_usd: null },
  });
  const a = attention(snap, null, null, NOW);
  const b = attention(snap, null, null, NOW);
  assert.deepEqual(keys(a), keys(b));
  assert.equal(new Set(keys(a)).size, keys(a).length, 'keys are unique');
});

test('untrusted text stays data, unchanged', () => {
  const markup = '<img src=x onerror=alert(1)>';
  const item = find(attention(snapshot({ tasks: [task({ id: 'T-1', owner_human_id: 'me', state: 'publish_blocked', state_detail: markup })] }), null, null, NOW), 'publish_blocked:T-1');
  assert.ok((item?.title ?? '').includes(markup), 'the string is carried verbatim as data');
});
