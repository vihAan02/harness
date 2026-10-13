// The integration page's model (D-114, D-115, D-116): the PR link is only built from a safe repo and number, integrate
// is allowed only when every condition holds (each condition proved alone, each with a control), a review on an old head
// isn't current, the in-flight wording for an unknown outcome, and the spend levels with their words. Untrusted text
// stays data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LandSnapshot, PrSnapshot, ProjectSnapshot, TaskSnapshot } from '@harness/protocol';
import { REQUIRED, budgetModel, integrationModel, prUrl } from '../web/model/integration.ts';

function task(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'T-1', title: 'A task', text: 'do it', scope: ['src/**'], owner_human_id: 'h1', priority: 0,
    assignee_agent_id: null, task_sha256: 'sha', status: 'pr_open', state: 'pr_open', state_detail: null,
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

/** A PR with all required checks passing and one current approval, so only the field under test is varied. */
function pr(over: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    number: 7, url: 'https://github.com/o/r/pull/7', head_sha: 'h'.repeat(40), base_sha: 'b'.repeat(40),
    state: 'open', merged: false, merge_sha: null, mergeable_state: 'clean',
    checks: { guard: 'success', 'unit-linux': 'success', 'full-macos': 'success', lint: 'success' },
    reviews: [{ login: 'daniyal', state: 'APPROVED', commit_id: 'h'.repeat(40) }], updated_at: '2026-10-12T00:00:00.000Z', ...over,
  };
}

/** A snapshot whose single task is ready to integrate: the control the per-condition tests break one field at a time. */
function ready(over: Partial<ProjectSnapshot> = {}, taskOver: Partial<TaskSnapshot> = {}): ProjectSnapshot {
  return snapshot({
    principal: 'me', repo: { github_repo: 'o/r', base_branch: 'main' },
    agents: [agent], tasks: [task({ assignee_agent_id: 'a1', state: 'pr_open', pr: pr(), ...taskOver })], ...over,
  });
}

test('prUrl builds a link only from a safe repo and a positive integer', () => {
  assert.equal(prUrl('o/r', 7), 'https://github.com/o/r/pull/7');
  assert.equal(prUrl('vihAan02/harness', 123), 'https://github.com/vihAan02/harness/pull/123');
  assert.equal(prUrl('owner.name/repo-name_x', 1), 'https://github.com/owner.name/repo-name_x/pull/1');
  // A hostile repo: a full URL, a scheme, spaces, a nested path, a leading slash, an empty half.
  assert.equal(prUrl('https://github.com/o/r', 7), null);
  assert.equal(prUrl('javascript:alert(1)/x', 7), null);
  assert.equal(prUrl('o/r', 7.5), null, 'a non-integer number');
  assert.equal(prUrl('o/r', 0), null, 'zero is not a PR');
  assert.equal(prUrl('o/r', -1), null);
  assert.equal(prUrl('o/r', Number.NaN), null);
  assert.equal(prUrl('o/r', Number.POSITIVE_INFINITY), null);
  assert.equal(prUrl('o /r', 7), null, 'a space in the repo');
  assert.equal(prUrl('o/r/extra', 7), null, 'a nested path');
  assert.equal(prUrl('/o/r', 7), null, 'a leading slash');
  assert.equal(prUrl('o/', 7), null, 'an empty name');
  assert.equal(prUrl(null, 7), null, 'no repo configured');
  // The URL is always https://github.com/…, never a scheme from the input.
  assert.ok(prUrl('o/r', 7)?.startsWith('https://github.com/'));
});

test('integrate is allowed when every condition holds, and expected names the head and base', () => {
  const model = integrationModel(ready(), false);
  const row = model.rows[0];
  assert.ok(row !== undefined);
  assert.equal(row.integrate.allowed, true);
  assert.equal(row.integrate.why, null);
  assert.deepEqual(row.expected, { pr_number: 7, head_sha: 'h'.repeat(40), base_sha: 'b'.repeat(40) });
});

test('integrate is refused for each condition alone; the control shows allowed', () => {
  // The control, so we know each refusal below is the field under test and not something else.
  assert.equal(integrationModel(ready(), false).rows[0]?.integrate.allowed, true);

  // 1. The principal must be the agent's accountable human.
  const wrongHuman = integrationModel(ready({ principal: 'someone' }), false);
  assert.equal(wrongHuman.rows[0]?.integrate.allowed, false);
  assert.match(wrongHuman.rows[0]?.integrate.why ?? '', /only me, the agent's human, can integrate/);

  // 2. The PR must be open.
  const closed = integrationModel(ready({}, { pr: pr({ state: 'closed' }) }), false);
  assert.equal(closed.rows[0]?.integrate.allowed, false);
  assert.equal(closed.rows[0]?.integrate.why, "the PR isn't open");

  // 3. Every required check must have passed.
  const failed = integrationModel(ready({}, { pr: pr({ checks: { guard: 'success', 'unit-linux': 'failure', 'full-macos': 'success' } }) }), false);
  assert.equal(failed.rows[0]?.integrate.allowed, false);
  assert.equal(failed.rows[0]?.integrate.why, "required checks haven't all passed: unit-linux");
  const missing = integrationModel(ready({}, { pr: pr({ checks: { guard: 'success' } }) }), false);
  assert.equal(missing.rows[0]?.integrate.why, "required checks haven't all passed: unit-linux, full-macos");
  const pending = integrationModel(ready({}, { pr: pr({ checks: { guard: 'pending', 'unit-linux': 'success', 'full-macos': 'success' } }) }), false);
  assert.equal(pending.rows[0]?.integrate.allowed, false, 'a pending required check is not a pass');

  // 4. One integration at a time: a land requested or accepted elsewhere blocks every row.
  const flyLand = { id: 'l1', task_id: 'T-2', mode: 'github', status: 'accepted', step: 'merging', reason: null, detail: null, pr_number: 8, new_base_sha: null, requested_at: 'x', finished_at: null } as LandSnapshot;
  const busy = integrationModel(ready({ lands: [flyLand] }), false);
  assert.equal(busy.rows[0]?.integrate.allowed, false);
  assert.equal(busy.rows[0]?.integrate.why, 'T-2 is integrating now');

  // 5. Offline waits.
  const off = integrationModel(ready(), true);
  assert.equal(off.rows[0]?.integrate.allowed, false);
  assert.equal(off.rows[0]?.integrate.why, 'actions wait while the banner shows');

  // 6. The task must be waiting for integration.
  const notWaiting = integrationModel(ready({}, { state: 'done' }), false);
  assert.equal(notWaiting.rows[0]?.integrate.allowed, false);
  assert.equal(notWaiting.rows[0]?.integrate.why, "it isn't waiting for integration");
});

test('a row with a land but no PR is listed and offers no integrate', () => {
  const land = { id: 'l1', task_id: 'T-1', mode: 'local', status: 'completed', step: null, reason: null, detail: null, pr_number: null, new_base_sha: 'abcdef0123456789', requested_at: '2026-10-12T01:00:00.000Z', finished_at: null } as LandSnapshot;
  const model = integrationModel(snapshot({ principal: 'me', tasks: [task({ land })] }), false);
  assert.equal(model.rows.length, 1);
  assert.equal(model.rows[0]?.pr, null);
  assert.equal(model.rows[0]?.integrate.allowed, false);
  assert.equal(model.rows[0]?.expected, null);
});

test('checks are the required ones first, then the rest by name, with plain words', () => {
  const row = integrationModel(ready({}, { pr: pr({ checks: { zeta: 'success', guard: 'success', alpha: 'failure', 'full-macos': 'pending', 'unit-linux': 'success' } }) }), false).rows[0];
  assert.deepEqual(row?.checks.map((c) => c.name), ['guard', 'unit-linux', 'full-macos', 'alpha', 'zeta']);
  assert.equal(row?.checks.find((c) => c.name === 'guard')?.words, '✓ passed');
  assert.equal(row?.checks.find((c) => c.name === 'alpha')?.words, '✗ failed');
  assert.equal(row?.checks.find((c) => c.name === 'full-macos')?.words, '… running');
  assert.deepEqual(REQUIRED, ['guard', 'unit-linux', 'full-macos']);
});

test('a review on an old head is not current; the latest per login wins', () => {
  const row = integrationModel(ready({}, {
    pr: pr({ reviews: [
      { login: 'a', state: 'APPROVED', commit_id: 'old'.padEnd(40, '0') },
      { login: 'b', state: 'CHANGES_REQUESTED', commit_id: 'h'.repeat(40) },
      { login: 'a', state: 'CHANGES_REQUESTED', commit_id: 'h'.repeat(40) },
    ] }),
  }), false).rows[0];
  assert.deepEqual(row?.reviews.map((r) => [r.login, r.state, r.current]), [
    ['a', 'CHANGES_REQUESTED', true],
    ['b', 'CHANGES_REQUESTED', true],
  ]);
  const stale = integrationModel(ready({}, { pr: pr({ reviews: [{ login: 'a', state: 'APPROVED', commit_id: 'old'.padEnd(40, '0') }] }) }), false).rows[0];
  assert.equal(stale?.reviews[0]?.current, false);
});

test('inFlight wording: a lost outcome says so; otherwise it names the task and step', () => {
  const land = (over: Partial<LandSnapshot>): LandSnapshot => ({ id: 'l1', task_id: 'T-1', mode: 'github', status: 'accepted', step: 'merging', reason: null, detail: null, pr_number: 7, new_base_sha: null, requested_at: '2026-10-12T02:00:00.000Z', finished_at: null, ...over });
  const unknown = integrationModel(snapshot({ tasks: [task({ state: 'outcome_unknown', land: land({}) })], lands: [land({})] }), false);
  assert.match(unknown.inFlight?.words ?? '', /answer to the merge was lost/);
  assert.equal(unknown.inFlight?.task, 'T-1');

  const integrating = integrationModel(snapshot({ tasks: [task({ state: 'integrating', land: land({ step: 'testing' }) })], lands: [land({ step: 'testing' })] }), false);
  assert.equal(integrating.inFlight?.words, 'integrating T-1: testing');

  const requested = integrationModel(snapshot({ tasks: [task({ state: 'integrating', land: land({ step: null }) })], lands: [land({ step: null })] }), false);
  assert.equal(requested.inFlight?.words, 'integrating T-1: requested');

  assert.equal(integrationModel(snapshot(), false).inFlight, null, 'nothing in flight');
});

test('outside merges are newest first, with a shortened range and their paths', () => {
  const model = integrationModel(snapshot({ base_advances: [
    { old_sha: 'a'.repeat(40), new_sha: 'b'.repeat(40), changed_paths: ['src/x.ts'], at: '2026-10-12T01:00:00.000Z' },
    { old_sha: 'c'.repeat(40), new_sha: 'd'.repeat(40), changed_paths: [], at: '2026-10-12T03:00:00.000Z' },
  ] }), false);
  assert.deepEqual(model.outside.map((o) => o.range), ['cccccccccccc → dddddddddddd', 'aaaaaaaaaaaa → bbbbbbbbbbbb']);
  assert.deepEqual(model.outside[1]?.paths, ['src/x.ts']);
});

test('rows are newest first by the PR update, then the land', () => {
  const mk = (id: string, at: string): TaskSnapshot => task({ id, pr: pr({ number: Number(id.slice(2)), updated_at: at }) });
  const model = integrationModel(snapshot({ tasks: [mk('T-1', '2026-10-12T01:00:00.000Z'), mk('T-2', '2026-10-12T03:00:00.000Z'), mk('T-3', '2026-10-12T02:00:00.000Z')] }), false);
  assert.deepEqual(model.rows.map((r) => r.task), ['T-2', 'T-3', 'T-1']);
});

test('budget: none without a daily budget, ok under 80%, warn at 80%, over at 100%', () => {
  const at = (spent: number, daily: number | null, cap: number | null = null) =>
    budgetModel(snapshot({ budget: { day: '2026-10-12', spent_usd: spent, daily_budget_usd: daily, session_cap_usd: cap } }));
  assert.equal(at(0, null).level, 'none');
  assert.equal(at(0, null).words[0], 'No daily budget set');
  assert.equal(at(5, 10).level, 'ok');
  assert.equal(at(7.999, 10).level, 'ok', 'just under 80% is ok');
  assert.equal(at(8, 10).level, 'warn', '80% warns');
  assert.equal(at(10, 10).level, 'over', '100% is over');
  assert.equal(at(11, 10).level, 'over');
  assert.equal(at(7.5, 10).words[0], '$7.500 of $10.000 spent today (UTC 2026-10-12)');
  assert.equal(at(11, 10).words.includes("New sessions won't start today"), true);
  assert.equal(at(5, 10).words.includes("New sessions won't start today"), false);
});

test('budget: a session may not fit when the room left is under the cap', () => {
  const at = (spent: number, daily: number, cap: number) =>
    budgetModel(snapshot({ budget: { day: '2026-10-12', spent_usd: spent, daily_budget_usd: daily, session_cap_usd: cap } }));
  assert.equal(at(9.5, 10, 1).words.includes('One more session may not fit'), true, '0.5 left under a $1 cap');
  assert.equal(at(5, 10, 1).words.includes('One more session may not fit'), false, '$5 left fits a $1 session');
  // The edge: room exactly equal to the cap still fits.
  assert.equal(at(9, 10, 1).words.includes('One more session may not fit'), false);
  assert.equal(at(9.001, 10, 1).words.includes('One more session may not fit'), true);
  // Over budget, the "may not fit" line is replaced by the over line.
  assert.equal(at(10, 10, 1).words.includes('One more session may not fit'), false);
});

test('budget: a running session with no cost reads "not reported yet", never $0', () => {
  const running = { id: 's1', agent_id: 'a1', device_id: 'dev-1', status: 'running', started_at: 'x', ended_at: null, end_reason: null, model: 'claude', cost_usd: 0, input_tokens: 0, output_tokens: 0 };
  const ended = { ...running, id: 's2', status: 'ended', ended_at: 'y', cost_usd: 1.5 };
  const model = budgetModel(snapshot({ tasks: [task({ id: 'T-1', session: running, cost_usd: 0 }), task({ id: 'T-2', session: ended, cost_usd: 1.5 })] }));
  const byId = new Map(model.tasks.map((t) => [t.task, t]));
  assert.equal(byId.get('T-1')?.reported, false, 'a running session with no cost is not reported');
  assert.equal(byId.get('T-2')?.reported, true);
  assert.equal(byId.get('T-2')?.costUsd, 1.5);
  // Most expensive first.
  assert.deepEqual(model.tasks.map((t) => t.task), ['T-2', 'T-1']);
  // A session that ended at $0 is a real $0, and is reported.
  const zero = budgetModel(snapshot({ tasks: [task({ id: 'T-3', session: { ...running, id: 's3', ended_at: 'z', cost_usd: 0 }, cost_usd: 0 })] }));
  assert.equal(zero.tasks[0]?.reported, true);
});

test('budget: a task shows its own cost (all its sessions), not just its live session', () => {
  const live = { id: 's2', agent_id: 'a1', device_id: 'dev-1', status: 'running', started_at: 'y', ended_at: null, end_reason: null, model: 'claude', cost_usd: 0, input_tokens: 0, output_tokens: 0 };
  // T-1's live session has reported nothing, but an earlier session cost $0.02: the task total is real money.
  const model = budgetModel(snapshot({ tasks: [task({ id: 'T-1', session: live, cost_usd: 0.02 })] }));
  assert.equal(model.tasks[0]?.costUsd, 0.02, "the task's own cost, not its last session's");
  assert.equal(model.tasks[0]?.reported, true);
  // A task with no cost at all and a live session still reports nothing.
  const fresh = budgetModel(snapshot({ tasks: [task({ id: 'T-2', session: live, cost_usd: 0 })] }));
  assert.equal(fresh.tasks[0]?.costUsd, 0);
  assert.equal(fresh.tasks[0]?.reported, false);
});

test('integrate: a task with no agent says so, not the same unknown twice', () => {
  const model = integrationModel(ready({}, { assignee_agent_id: null }), false);
  assert.equal(model.rows[0]?.integrate.allowed, false);
  assert.equal(model.rows[0]?.integrate.why, 'it has no agent');
});

test('budget: an open circuit is resettable unless it is a budget circuit', () => {
  const withCircuit = (kind: 'auth' | 'billing' | 'budget') =>
    budgetModel(snapshot({ provider: { circuit: { kind, reason: 'the key was rejected', at: '2026-10-12T00:00:00.000Z' } } }));
  assert.equal(withCircuit('auth').circuit?.resettable, true);
  assert.equal(withCircuit('billing').circuit?.resettable, true);
  assert.equal(withCircuit('budget').circuit?.resettable, false, 'a budget circuit closes on the next UTC day');
  assert.match(withCircuit('auth').words.join(' '), /No agent starts on this Mac: auth: the key was rejected/);
  assert.equal(budgetModel(snapshot()).circuit, null, 'no circuit');
});

test('alerts and titles are carried as data, markup unchanged', () => {
  const markup = '<img src=x onerror=alert(1)>';
  const model = integrationModel(snapshot({
    alerts: [{ seq: 1, at: '2026-10-12T00:00:00.000Z', what: markup, task_id: 'T-1', detail: markup }],
    tasks: [task({ id: 'T-1', title: markup, pr: pr() })],
  }), false);
  assert.equal(model.alerts[0]?.what, markup);
  assert.equal(model.alerts[0]?.detail, markup);
  assert.equal(model.rows[0]?.title, markup);
});

test('alerts are newest first and a task-less one carries a null task', () => {
  const model = integrationModel(snapshot({ alerts: [
    { seq: 1, at: '2026-10-12T01:00:00.000Z', what: 'forged', task_id: null, detail: null },
    { seq: 2, at: '2026-10-12T03:00:00.000Z', what: 'replayed', task_id: 'T-9', detail: 'from peer' },
  ] }), false);
  assert.deepEqual(model.alerts.map((a) => a.what), ['replayed', 'forged']);
  assert.equal(model.alerts[1]?.task, null);
  assert.equal(model.alerts[0]?.detail, 'from peer');
});
