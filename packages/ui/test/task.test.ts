// The task page's model (D-117): the fields of one task, the overlap/stale/wait wording, the notices' delivery, the
// tests and PR lines, and which actions each state offers each human. Every string is data, never markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DerivedTaskState, LandSnapshot, ProjectSnapshot, TaskSnapshot } from '@harness/protocol';
import { actionsFor, taskModel } from '../web/model/task.ts';

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

const agent = { id: 'a1', name: 'Bot', vendor: 'claude', human_id: 'me', device_id: 'dev-1', online: true, active_task_id: 'T-1', live_session_id: null };

test('an unknown task is null', () => {
  assert.equal(taskModel(snapshot(), 'T-9'), null);
});

test('the model carries the task, its words, owner, agent and sha', () => {
  const snap = snapshot({ principal: 'me', agents: [agent], tasks: [task({ assignee_agent_id: 'a1', state: 'running' })] });
  const m = taskModel(snap, 'T-1');
  assert.ok(m !== null);
  assert.equal(m.id, 'T-1');
  assert.equal(m.title, 'A task');
  assert.equal(m.words, 'working');
  assert.equal(m.state, 'running');
  assert.equal(m.owner, 'h1');
  assert.equal(m.text, 'do it');
  assert.deepEqual(m.scope, ['src/**']);
  assert.equal(m.taskSha256, 'sha');
  assert.deepEqual(m.agent, { id: 'a1', name: 'Bot', human: 'me', device: 'dev-1', online: true });
});

test('an unassigned task has no agent', () => {
  const m = taskModel(snapshot({ tasks: [task()] }), 'T-1');
  assert.equal(m?.agent, null);
});

test('overlaps read "also changes" for observed and "scope overlaps" for prospective', () => {
  const m = taskModel(snapshot({ tasks: [task({ overlaps: [
    { task_id: 'T-2', paths: ['src/a.ts'], level: 'observed' },
    { task_id: 'T-3', paths: ['src/'], level: 'prospective' },
  ] })] }), 'T-1');
  assert.deepEqual(m?.overlaps, ['T-2 also changes src/a.ts', "T-3's scope overlaps src/"]);
});

test('stale reads name the file and the reason', () => {
  const m = taskModel(snapshot({ tasks: [task({ stale_reads: ['src/a.ts', 'src/b.ts'] })] }), 'T-1');
  assert.deepEqual(m?.stale, ['src/a.ts changed after its agent read it', 'src/b.ts changed after its agent read it']);
});

test('the wait line is the kind, id and a UTC time', () => {
  const wait = { id: 'w1', task_id: 'T-1', session_id: 's', on: { kind: 'message', id: 'm1' }, outcome: 'waiting' as const, started_at: 'x', timeout_at: '2026-10-12T15:30:00.000Z', finished_at: null, reason: null };
  assert.equal(taskModel(snapshot({ tasks: [task({ open_wait: wait })] }), 'T-1')?.wait, 'waiting for message m1 until 15:30 UTC');
  assert.equal(taskModel(snapshot({ tasks: [task()] }), 'T-1')?.wait, null);
});

test('notices are the messages to or from the task or its agent, oldest first, with their delivery', () => {
  const messages = [
    { id: 'm2', kind: 'question', from: 'a1', to: 'peer', from_task: 'T-1', to_task: null, in_reply_to: null, text: 'later', priority: 'normal', sent_at: '2026-10-12T02:00:00.000Z', seq: 2, delivered_at: null, held: false },
    { id: 'm1', kind: 'note', from: 'peer', to: 'a1', from_task: null, to_task: null, in_reply_to: null, text: 'first', priority: 'normal', sent_at: '2026-10-12T01:00:00.000Z', seq: 1, delivered_at: '2026-10-12T01:01:00.000Z', held: false },
    { id: 'm3', kind: 'note', from: 'peer', to: null, from_task: null, to_task: null, in_reply_to: null, text: 'unrelated', priority: 'normal', sent_at: '2026-10-12T00:30:00.000Z', seq: 0, delivered_at: null, held: false },
    { id: 'm4', kind: 'note', from: 'peer', to: 'a1', from_task: null, to_task: null, in_reply_to: null, text: 'held', priority: 'normal', sent_at: '2026-10-12T03:00:00.000Z', seq: 3, delivered_at: null, held: true },
    { id: 'm5', kind: 'note', from: 'peer', to: 'a1', from_task: null, to_task: null, in_reply_to: null, text: 'pending', priority: 'normal', sent_at: '2026-10-12T04:00:00.000Z', seq: 4, delivered_at: null, held: false },
  ];
  const m = taskModel(snapshot({ agents: [agent], tasks: [task({ assignee_agent_id: 'a1' })], messages }), 'T-1');
  assert.deepEqual(m?.notices.map((n) => n.id), ['m1', 'm2', 'm4', 'm5'], 'oldest first, the unrelated one left out');
  assert.deepEqual(m?.notices.map((n) => n.delivery), ['delivered', 'not delivered yet', 'held for your review', 'not delivered yet']);
});

test('the land line reports landed, failed and in-flight, then each PR check', () => {
  const land = (over: Partial<LandSnapshot>): LandSnapshot => ({ id: 'l1', task_id: 'T-1', mode: 'local', status: 'completed', step: null, reason: null, detail: null, pr_number: null, new_base_sha: 'abcdef0123456789', requested_at: 'x', finished_at: null, ...over });
  const pr = { number: 4, url: 'u', head_sha: 'h'.repeat(40), base_sha: 'b', state: 'open' as const, merged: false, merge_sha: null, mergeable_state: null, checks: { ci: 'success', lint: 'failure' }, reviews: [], updated_at: 'x' };
  assert.deepEqual(taskModel(snapshot({ tasks: [task({ land: land({}) })] }), 'T-1')?.tests, ['landed as abcdef012345']);
  assert.deepEqual(taskModel(snapshot({ tasks: [task({ land: land({ status: 'failed', reason: 'tests', detail: '3 failed' }) })] }), 'T-1')?.tests, ['the land failed (tests): 3 failed']);
  assert.deepEqual(taskModel(snapshot({ tasks: [task({ land: land({ status: 'accepted', step: 'testing', new_base_sha: null }) })] }), 'T-1')?.tests, ['integrating: testing']);
  assert.deepEqual(taskModel(snapshot({ tasks: [task({ pr })] }), 'T-1')?.tests, ['ci: success', 'lint: failure']);
});

test('the PR block and the session block are carried', () => {
  const pr = { number: 4, url: 'u', head_sha: 'h'.repeat(40), base_sha: 'b', state: 'open' as const, merged: false, merge_sha: null, mergeable_state: null, checks: {}, reviews: [], updated_at: 'x' };
  const session = { id: 's1', agent_id: 'a1', device_id: 'dev-1', status: 'ended', started_at: 'x', ended_at: 'y', end_reason: 'budget', model: 'claude', cost_usd: 0.5, input_tokens: 10, output_tokens: 20 };
  const m = taskModel(snapshot({ tasks: [task({ pr, session, cost_usd: 1.25 })] }), 'T-1');
  assert.deepEqual(m?.pr, { number: 4, state: 'open', merged: false, head: 'h'.repeat(40) });
  assert.deepEqual(m?.session, { status: 'ended', model: 'claude', endReason: 'budget', costUsd: 0.5, input: 10, output: 20 });
  assert.equal(m?.costUsd, 1.25);
});

test('actionsFor: open → Assign, and Abandon is not offered for a task that never started', () => {
  const snap = snapshot({ principal: 'h1', tasks: [task({ state: 'open' })] });
  assert.deepEqual(actionsFor(snap, 'T-1', false), [{ kind: 'start', label: 'Assign', needs: 'agent', optional: false }]);
});

test('actionsFor: stopped → Resume (optional text), and Abandon', () => {
  const actions = actionsFor(snapshot({ principal: 'h1', tasks: [task({ state: 'stopped' })] }), 'T-1', false);
  assert.deepEqual(actions.map((a) => a.kind), ['resume', 'abandon']);
  assert.equal(actions[0]?.needs, 'text');
  assert.equal(actions[0]?.optional, true);
  assert.equal(actions[1]?.needs, 'reason');
  assert.equal(actions[1]?.optional, false);
});

test('actionsFor: blocked → Unblock whose label names the conflict, plus Abandon', () => {
  const actions = actionsFor(snapshot({ principal: 'h1', tasks: [task({ state: 'blocked' })] }), 'T-1', false);
  assert.deepEqual(actions.map((a) => a.kind), ['unblock', 'abandon']);
  assert.equal(actions[0]?.needs, null);
  assert.match(actions[0]?.label ?? '', /after you've fixed the conflict in its worktree/);
});

test('actionsFor: done, pr_open and publish_blocked → Reopen with required text, plus Abandon', () => {
  for (const state of ['done', 'pr_open', 'publish_blocked'] as const) {
    const actions = actionsFor(snapshot({ principal: 'h1', tasks: [task({ state })] }), 'T-1', false);
    assert.deepEqual(actions.map((a) => a.kind), ['reopen', 'abandon'], state);
    assert.equal(actions[0]?.needs, 'text', state);
    assert.equal(actions[0]?.optional, false, state);
  }
});

test('actionsFor: starting and running → Mark done with an optional summary, plus Abandon', () => {
  for (const state of ['starting', 'running'] as const) {
    const actions = actionsFor(snapshot({ principal: 'h1', tasks: [task({ state })] }), 'T-1', false);
    assert.deepEqual(actions.map((a) => a.kind), ['complete', 'abandon'], state);
    assert.equal(actions[0]?.needs, 'summary', state);
    assert.equal(actions[0]?.optional, true, state);
  }
});

test('actionsFor: Abandon is offered in needs-a-human states but not while publishing or integrating', () => {
  const offered = (state: DerivedTaskState) => actionsFor(snapshot({ principal: 'h1', tasks: [task({ state })] }), 'T-1', false).map((a) => a.kind);
  for (const state of ['stopped', 'blocked', 'done', 'publish_blocked', 'pr_open', 'starting', 'running', 'fetch_pending', 'awaiting_approval', 'publish_pending_approval'] as const) {
    assert.ok(offered(state).includes('abandon'), state);
  }
  for (const state of ['open', 'landed', 'abandoned', 'publishing', 'integrating', 'outcome_unknown'] as const) {
    assert.ok(!offered(state).includes('abandon'), `${state} offers no abandon`);
  }
});

test('actionsFor: the owner and the agent’s human may act; another human may not', () => {
  const snap = (principal: string) => snapshot({ principal, agents: [agent], tasks: [task({ state: 'running', owner_human_id: 'h1', assignee_agent_id: 'a1' })] });
  assert.ok(actionsFor(snap('h1'), 'T-1', false).length > 0, 'the owner acts');
  assert.ok(actionsFor(snap('me'), 'T-1', false).length > 0, "the agent's human acts");
  assert.deepEqual(actionsFor(snap('other'), 'T-1', false), [], 'another human acts on nothing');
});

test('actionsFor: offline, an unknown task, or no states leave nothing to do', () => {
  assert.deepEqual(actionsFor(snapshot({ principal: 'h1', tasks: [task({ state: 'running' })] }), 'T-1', true), [], 'offline');
  assert.deepEqual(actionsFor(snapshot({ principal: 'h1' }), 'T-9', false), [], 'unknown task');
});

test('untrusted text stays data, unchanged', () => {
  const markup = '<img src=x onerror=alert(1)>';
  const m = taskModel(snapshot({ tasks: [task({ title: markup, text: markup, state_detail: markup })] }), 'T-1');
  assert.equal(m?.title, markup);
  assert.equal(m?.text, markup);
  assert.equal(m?.detail, markup);
});
