// The board's model (D-117): every state lands in its one column, mine sorts first, the budget has its four levels, the
// new-task form validates each rule, and no snapshot string is ever markup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DerivedTaskState, ProjectSnapshot, TaskSnapshot } from '@harness/protocol';
import { COLUMNS, boardModel, newTaskModel, stateWords } from '../web/model/board.ts';

/** A valid TaskSnapshot with sensible defaults; pass overrides to place it. */
export function task(over: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: 'T-1', title: 'A task', text: 'do it', scope: ['src/**'], owner_human_id: 'h1', priority: 0,
    assignee_agent_id: null, task_sha256: 'sha', status: 'open', state: 'open', state_detail: null,
    summary: null, created_at: '2026-10-12T00:00:00.000Z', assigned_at: null, completed_at: null,
    session: null, pr: null, land: null, publish_blocked: null, stale_reads: [], changing: [], overlaps: [],
    leases: [], open_wait: null, cost_usd: 0, ...over,
  };
}

/** A valid ProjectSnapshot; every field it names points at what the board reads. */
export function snapshot(over: Partial<ProjectSnapshot> = {}): ProjectSnapshot {
  return {
    v: 1, project_id: 'p1', head_seq: 1, integration_mode: 'local', taken_at: '2026-10-12T00:00:00.000Z',
    device_id: 'dev-1', principal: 'me', connection: 'connected',
    tasks: [], agents: [], devices: [], messages: [], waits: [], lands: [], base_advances: [],
    budget: { day: '2026-10-12', spent_usd: 0, daily_budget_usd: null, session_cap_usd: null },
    repo: { github_repo: null, base_branch: 'main' }, alerts: [], provider: { circuit: null }, ...over,
  };
}

test('every derived state has plain words', () => {
  const states: DerivedTaskState[] = ['open', 'awaiting_approval', 'starting', 'running', 'stopped', 'blocked', 'done',
    'publish_pending_approval', 'publishing', 'publish_blocked', 'pr_open', 'integrating', 'outcome_unknown', 'fetch_pending', 'landed', 'abandoned'];
  for (const s of states) {
    const words = stateWords(s);
    assert.ok(words.length > 0, s);
    assert.ok(!words.includes('_'), `${s}: words are not an identifier`);
  }
  assert.equal(stateWords('running'), 'working');
});

test('each state lands in exactly one column, and abandoned is left out', () => {
  const all: DerivedTaskState[] = ['open', 'awaiting_approval', 'starting', 'running', 'stopped', 'blocked', 'done',
    'publish_pending_approval', 'publishing', 'publish_blocked', 'pr_open', 'integrating', 'outcome_unknown', 'fetch_pending', 'landed', 'abandoned'];
  const seen = new Map<string, number>();
  for (const col of COLUMNS) for (const s of col.states) seen.set(s, (seen.get(s) ?? 0) + 1);
  for (const s of all) {
    const n = seen.get(s) ?? 0;
    if (s === 'abandoned') assert.equal(n, 0, 'abandoned is not shown');
    else assert.equal(n, 1, `${s} is in exactly one column`);
  }
  const model = boardModel(snapshot({ tasks: all.map((state, i) => task({ id: `T-${i}`, state })) }));
  assert.equal(model.columns.reduce((n, c) => n + c.cards.length, 0), all.length - 1, 'abandoned has no card');
  const needs = model.columns.find((c) => c.key === 'needs_human');
  assert.deepEqual(needs?.cards.map((c) => c.state).sort(), ['blocked', 'fetch_pending', 'outcome_unknown', 'publish_blocked', 'stopped'].sort());
});

test('cards sort mine first, then by id', () => {
  const model = boardModel(snapshot({
    principal: 'me',
    tasks: [
      task({ id: 'T-3', owner_human_id: 'other' }),
      task({ id: 'T-1', owner_human_id: 'other' }),
      task({ id: 'T-2', owner_human_id: 'me' }),
    ],
  }));
  const cards = model.columns.find((c) => c.key === 'not_started')?.cards ?? [];
  assert.deepEqual(cards.map((c) => c.id), ['T-2', 'T-1', 'T-3']);
  assert.deepEqual(cards.map((c) => c.mine), [true, false, false]);
});

test('mine is the owner, or the agent human', () => {
  const model = boardModel(snapshot({
    principal: 'me',
    agents: [{ id: 'a1', name: 'Bot', vendor: 'claude', human_id: 'me', device_id: 'dev-1', online: true, active_task_id: 'T-5', live_session_id: null }],
    devices: [{ device_id: 'dev-1', online: true, at: 'x' }],
    tasks: [task({ id: 'T-5', owner_human_id: 'other', assignee_agent_id: 'a1' })],
  }));
  const card = model.columns.find((c) => c.key === 'not_started')?.cards[0];
  assert.equal(card?.mine, true);
  assert.equal(card?.agentHuman, 'me');
  assert.equal(card?.agent, 'Bot');
  assert.equal(card?.device, 'dev-1');
  assert.equal(card?.deviceOnline, true);
});

test('the budget has four levels: none, ok, warn at 80%, over at 100%', () => {
  const at = (spent: number, daily: number | null) =>
    boardModel(snapshot({ budget: { day: '2026-10-12', spent_usd: spent, daily_budget_usd: daily, session_cap_usd: null } })).budget;
  assert.equal(at(0, null).level, 'none', 'no daily budget');
  assert.equal(at(5, 10).level, 'ok');
  assert.equal(at(7.99, 10).level, 'ok', '79% is still ok');
  assert.equal(at(8, 10).level, 'warn', '80% warns');
  assert.equal(at(10, 10).level, 'over', '100% is over');
  assert.equal(at(11, 10).level, 'over');
  assert.equal(at(3, 10).spent, 3);
  assert.equal(at(3, 10).daily, 10);
});

test('newTaskModel accepts a valid form and splits scope on commas and newlines', () => {
  const r = newTaskModel({ title: '  Do it  ', text: '  the text  ', scope: 'a/b, c/d\ne/f ,, g/**' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.title, 'Do it');
  assert.equal(r.args.text, 'the text');
  assert.deepEqual(r.args.scope, ['a/b', 'c/d', 'e/f', 'g/**']);
});

test('newTaskModel validates each rule with a valid control', () => {
  const good = { title: 't', text: 'x', scope: 'src/a.ts' };
  assert.equal(newTaskModel(good).ok, true);
  assert.equal(newTaskModel({ ...good, title: '   ' }).ok, false);
  assert.equal(newTaskModel({ ...good, title: 'x'.repeat(200) }).ok, true);
  assert.equal(newTaskModel({ ...good, title: 'x'.repeat(201) }).ok, false);
  assert.equal(newTaskModel({ ...good, text: '' }).ok, false);
  assert.equal(newTaskModel({ ...good, text: 'x'.repeat(8000) }).ok, true);
  assert.equal(newTaskModel({ ...good, text: 'x'.repeat(8001) }).ok, false);
  for (const scope of ['/abs', 'a/../b', '../b', 'a/**/b', 'a/*.ts', '*']) {
    const r = newTaskModel({ ...good, scope });
    assert.equal(r.ok, false, `${scope} is invalid`);
    if (!r.ok) assert.ok(r.errors.scope !== undefined, `${scope} names the scope field`);
  }
  assert.equal(newTaskModel({ ...good, scope: 'a/**' }).ok, true);
  assert.equal(newTaskModel({ ...good, scope: '' }).ok, true, 'empty scope is allowed');
  const bad = newTaskModel({ title: '', text: '', scope: '/x' });
  if (!bad.ok) { assert.ok(bad.errors.title); assert.ok(bad.errors.text); assert.ok(bad.errors.scope); }
});

test('a title of markup stays data, unchanged', () => {
  const title = '<img src=x onerror=alert(1)>';
  const r = newTaskModel({ title, text: 'x', scope: 'a' });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.args.title, title);
  const model = boardModel(snapshot({ tasks: [task({ title })] }));
  assert.equal(model.columns[0]?.cards[0]?.title, title, 'the string is carried verbatim as data');
});
