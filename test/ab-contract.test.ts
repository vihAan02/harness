// The A/B record contract's revision for §9 revision 2 (scripts/ab/summary.ts; validation.md §9, D-125): each
// task's `done_at`, M3's conflicts at most one per task, and `<task>.patch` as the task's own work, so a synced
// task's diff doesn't carry the other task's work to the M2 judge and give its arm away.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { EventMessage } from '../packages/protocol/src/index.ts';
import { ProjectView } from '../packages/daemon/src/index.ts';
import { gitIn, makeRepo, tempDir } from '../packages/daemon/test/fixtures.ts';
import { baselineDoneAt } from '../scripts/ab/baseline-arm.ts';
import { checkSummary, type RunSummary } from '../scripts/ab/summary.ts';
import { firstCompletion, ownBase, writeDiffs } from '../scripts/ab/summarize.ts';

const t = tempDir('ab-contract');
after(() => t.cleanup());

const summary = (o: Partial<RunSummary> = {}): Record<string, unknown> => ({
  v: 1, run_id: 'r-1', arm: 'baseline', scenario: 'SC-1', phrasing: 1, outcome: 'integrated', void: null, models: ['m'], cap_ms: 1_800_000,
  started_at: 'a', ended_at: 'b', m1_ms: 1, m3_conflicts: 0, sync_conflicts: 0, m4: { commits_after_first: 0, ms_to_green: null }, m5: 0, m5b: 0, m5c: 0,
  m7: {}, m8: { input: 0, output: 0, cache_read: 0, cache_creation: 0, cost_usd: 0 }, m9a: 0, m10_ms: 0, surfaced: null, base_sha: 'x', main_sha: 'y',
  tasks: [
    { key: 'T1', agent: 'backend', branch: 'b1', done_at: '2026-10-07T10:00:00.000Z', integrated_at: '2026-10-07T10:01:00.000Z' },
    { key: 'T2', agent: 'frontend', branch: 'b2', done_at: null, integrated_at: null },
  ],
  ...o,
});

test('the contract: every task has done_at (when it was first done, or null), and M3 counts at most one conflict per task', () => {
  checkSummary(summary());
  const tasks = summary().tasks as Record<string, unknown>[];
  assert.throws(() => checkSummary(summary({ tasks: [{ ...tasks[0], done_at: undefined }, tasks[1]] as RunSummary['tasks'] })), /tasks\[0\]\.done_at/);
  assert.throws(() => checkSummary(summary({ tasks: [tasks[0], { ...tasks[1], done_at: 5 }] as unknown as RunSummary['tasks'] })), /tasks\[1\]\.done_at/);
  checkSummary(summary({ m3_conflicts: 2 }));
  assert.throws(() => checkSummary(summary({ m3_conflicts: 3 })), /m3_conflicts/);
});

test('a task\'s own diff: from the last main it merged in, so the other task\'s synced work drops out (M2\'s judge, §9)', () => {
  const root = path.join(t.dir, 'own-diff');
  const { repo, sha } = makeRepo(root, { 'api.ts': 'export const v = 1;\n', 'ui.ts': 'export const u = 1;\n' });
  const wt = path.join(root, 'wt');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'harness/task/T-2', wt, sha);
  const commit = (dir: string, file: string, text: string, msg: string) => {
    fs.appendFileSync(path.join(dir, file), text);
    gitIn(dir, 'commit', '-q', '-am', msg);
  };
  commit(wt, 'ui.ts', 'export const before = 1; // T2, before it synced\n', 'T2: before');
  commit(repo, 'api.ts', 'export const other = 1; // T1, landed\n', 'T1 lands');
  gitIn(wt, 'merge', '-q', '--no-ff', '--no-edit', 'main'); // the sync
  commit(wt, 'ui.ts', 'export const after = 1; // T2, after it synced\n', 'T2: after');
  const tip = gitIn(wt, 'rev-parse', 'HEAD');
  assert.equal(ownBase(repo, sha, tip), gitIn(repo, 'rev-parse', 'main'), 'the last main it merged in');
  assert.equal(ownBase(repo, sha, gitIn(repo, 'rev-parse', 'main')), sha, 'never synced: the base');
  writeDiffs(path.join(root, 'record'), repo, sha, gitIn(repo, 'rev-parse', 'main'), [{ key: 'T2', commit: tip }]);
  const own = fs.readFileSync(path.join(root, 'record', 'diffs', 'T2.patch'), 'utf8');
  assert.match(own, /T2, before it synced/);
  assert.match(own, /T2, after it synced/);
  assert.doesNotMatch(own, /T1, landed/, 'the other task\'s work isn\'t in this task\'s own diff');
  const independent = fs.readFileSync(path.join(root, 'record', 'diffs', 'T2.independent.patch'), 'utf8');
  assert.match(independent, /T2, before it synced/);
  assert.doesNotMatch(independent, /T2, after it synced/, 'M3\'s independent diff still stops at the first sync');
  // Negative control: the diff from the base, what <task>.patch was, carries the other task's work.
  assert.match(gitIn(repo, 'diff', sha, tip), /T1, landed/);
});

test('done_at is a task\'s first completion: the first task.completed in the harness arm (a reopen doesn\'t move it), the first merge\'s start in the baseline', () => {
  let seq = 0;
  const ev = (kind: string, data: Record<string, unknown>, s: number): EventMessage =>
    ({ v: 1, type: 'event', project_id: 'p', seq: ++seq, at: new Date(Date.UTC(2026, 9, 7, 10, 0, s)).toISOString(), actor: { principal: 'x', on_behalf_of: null, device_id: null }, kind, data } as EventMessage);
  const view = new ProjectView('p');
  for (const e of [
    ev('task.completed', { task_id: 'T-1' }, 10), ev('task.reopened', { task_id: 'T-1', text: 'fix it' }, 20), ev('task.completed', { task_id: 'T-1' }, 30),
  ]) view.apply(e);
  assert.equal(firstCompletion(view, 'T-1'), '2026-10-07T10:00:10.000Z');
  assert.equal(firstCompletion(view, 'T-2'), null, 'never done');
  const t0 = Date.UTC(2026, 9, 7, 10, 0, 0);
  const marks = [
    { what: 'sync', task: 'T2', detail: { outcome: 'synced' } },
    { what: 'integration', task: 'T1', detail: { start: 5_000, outcome: 'tests_failed' } },
    { what: 'integration', task: 'T1', detail: { start: 9_000, outcome: 'merged' } },
  ];
  assert.deepEqual([...baselineDoneAt(marks, t0)], [['T1', '2026-10-07T10:00:05.000Z']], 'T1 at its first merge\'s start; T2 never merged');
});
