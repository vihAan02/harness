// The A/B scorer (A9): the pass bar v1 rules at their edges, on small synthetic studies (validation.md §5, §9).
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dropBy, evaluate, hunksOverlap, loadRecords, median, medianOfMedians, noWorse, overlappingHunks, parseHunks, renderReport, scoreRun,
  type Hunk, type Loaded, type RunRecord, type RunScore, type Security,
} from '../scripts/ab/score.ts';
import { checkGrades, checkJudge, COUPLED, SCENARIOS, type Arm, type Grade, type Grades, type JudgeResult, type RunSummary } from '../scripts/ab/summary.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-score-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const SECURE: Security = { t1: true, t1b: true, t2: true, at: '2026-10-05' };

function summary(o: Partial<RunSummary> & Pick<RunSummary, 'run_id' | 'arm' | 'scenario'>): RunSummary {
  return {
    v: 1, phrasing: 1, outcome: 'integrated', void: null, models: ['deepseek/deepseek-v4.1-flash (openrouter)'], cap_ms: 1_800_000,
    started_at: '2026-10-05T10:00:00.000Z', ended_at: '2026-10-05T10:10:00.000Z', m1_ms: 600_000, m3_conflicts: 0,
    m4: { commits_after_first: 0, ms_to_green: null }, m5: 0, m5b: 0, m5c: 2, m7: {}, m8: { input: 1000, output: 100, cache_read: 0, cache_creation: 0, cost_usd: 0.01 },
    m9a: 0, m10_ms: 60_000, surfaced: null, base_sha: 'b'.repeat(40), main_sha: 'c'.repeat(40),
    tasks: [{ key: 'T1', agent: 'backend', branch: 't1', integrated_at: null }, { key: 'T2', agent: 'frontend', branch: 't2', integrated_at: null }],
    ...o,
  };
}
const judge = (run_id: string, o: Partial<Pick<JudgeResult, 'm2' | 'm6'>> = {}): JudgeResult =>
  ({ v: 1, run_id, judge_model: 'anthropic/claude-sonnet-5.5', m2: { units: [], lines_removed_in_integration: 0 }, m6: { incidents: [] }, cost_usd: 0.02, ...o });
const grade = (o: Partial<Grade> = {}): Grade => ({ checks: {}, m9b: 0, m6_reached: 0, m2_planted: 0, ...o });
const copy = (n: number) => ({ units: n ? [{ what: 'a helper', locations: ['a.ts: f', 'b.ts: f'], extra_copies: n }] : [], lines_removed_in_integration: 0 });

type Spec = { s?: Partial<RunSummary>; g?: Partial<Grade> | null; j?: Partial<Pick<JudgeResult, 'm2' | 'm6'>> | null; patches?: Record<string, string> };

/**
 * Three runs per scenario per arm. By default a strong pass: on the coupled scenarios the baseline has 1 broken
 * contract, 1 extra copy, 1 conflict and 2 interventions per run and 100 s of coordination, the harness none of
 * them and 60 s; time and tokens are equal; SC-0 is identical in both arms; every planted change surfaced.
 */
function study(f: (arm: Arm, sc: string, i: number) => Spec = () => ({})): { loaded: Loaded; grades: Grades } {
  const records: RunRecord[] = [];
  const grades: Grades = { v: 1, runs: {} };
  for (const sc of SCENARIOS) {
    for (const arm of ['harness', 'baseline'] as const) {
      for (let i = 0; i < 3; i++) {
        const id = `r-${sc}-${arm}-${i}`;
        const coupledBaseline = arm === 'baseline' && sc !== 'SC-0';
        const surfaced = arm === 'harness' && ['SC-1', 'SC-2', 'SC-3'].includes(sc) ? { planted: 1, surfaced: 1 } : null;
        const spec = f(arm, sc, i);
        const s = summary({ run_id: id, arm, scenario: sc, phrasing: i + 1, surfaced, ...(coupledBaseline ? { m3_conflicts: 1, m5: 2, m10_ms: 100_000 } : {}), ...spec.s });
        const j = spec.j === null ? null : judge(id, { m2: copy(coupledBaseline ? 1 : 0), ...spec.j });
        if (spec.g !== null) grades.runs[id] = grade({ m6_reached: coupledBaseline ? 1 : 0, ...spec.g });
        records.push({ dir: id, summary: s, judge: j, patches: spec.patches ?? { T1: '', T2: '' }, problems: [] });
      }
    }
  }
  return { loaded: { records, skipped: [], errors: [] }, grades };
}
const ev = (f?: (arm: Arm, sc: string, i: number) => Spec, security = SECURE) => { const s = study(f); return evaluate(s.loaded, s.grades, security); };
const coupled = (sc: string) => (COUPLED as readonly string[]).includes(sc);

test('median: odd, even (the mean of the middle two), empty', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test('time metrics: the median per scenario, then the median across scenarios (an even count averages the middle two)', () => {
  const r = (scenario: string, m1_ms: number) => ({ scenario, m1_ms }) as RunScore;
  const runs = [r('SC-1', 1), r('SC-1', 9), r('SC-1', 2), r('SC-2', 4), r('SC-3', 6), r('SC-3', 8), r('SC-4', 100)];
  // Scenario medians 2, 4, 7, 100: the median of four is (4 + 7) / 2.
  assert.equal(medianOfMedians(runs, COUPLED, (x) => x.m1_ms), 5.5);
  assert.equal(medianOfMedians(runs, ['SC-0'], (x) => x.m1_ms), null);
});

test('the default study is a complete strong pass', () => {
  const e = ev();
  assert.deepEqual(e.incomplete, []);
  assert.equal(e.complete, true);
  assert.equal(e.outcome, 'strong pass');
  assert.deepEqual([e.p1.surfaced, e.p1.planted, e.p1.broken_harness, e.p1.broken_baseline], [9, 9, 0, 12]);
  assert.deepEqual([e.p2.m2_baseline, e.p2.m3_baseline, e.p3.m5_baseline], [12, 12, 24]);
});

test('counts are totals over runs; time and tokens are medians of scenario medians', () => {
  const e = ev((arm, sc, i) => (arm === 'harness' && coupled(sc) ? { s: { m5: i, m1_ms: [100, 200, 900][i]! * 1000 + Number(sc.at(-1)) * 1000 } } : {}));
  assert.equal(e.p3.m5_harness, 4 * (0 + 1 + 2), 'M5 summed over 12 runs');
  // Per-scenario medians 201, 202, 203, 204 s: the median of the four is 202.5 s.
  assert.equal(e.g1.harness_ms, 202_500);
  assert.equal(e.scenarios['SC-2']!.harness.m1_ms, 202_000);
});

test('the zero-baseline rule, both ways, and the threshold edges', () => {
  assert.equal(dropBy(0, 0, 50), true);
  assert.equal(dropBy(1, 0, 50), false);
  assert.equal(dropBy(5, 10, 50), true);
  assert.equal(dropBy(6, 10, 50), false);
  assert.equal(dropBy(7, 10, 30), true);
  assert.equal(dropBy(8, 10, 30), false);
  assert.equal(noWorse(1, 0, 15, true), true, 'a zero baseline allows +1 in total');
  assert.equal(noWorse(2, 0, 15, true), false);
  assert.equal(noWorse(115, 100, 15, true), true);
  assert.equal(noWorse(116, 100, 15, true), false);
  assert.equal(noWorse(2, 1, 15, true), false);
  assert.equal(noWorse(690_000, 600_000, 15, false), true);
  assert.equal(noWorse(690_001, 600_000, 15, false), false);
});

test('P1, first half: surfaced ÷ planted ≥ 70% over the harness arm\'s SC-1 to SC-3 runs; SC-4 and SC-0 never count', () => {
  // Nine runs, planted 10 (the first has 2); the first surfaces both, runs 1..n-1 one each.
  const at = (n: number) => ev((arm, sc, i) => {
    if (arm !== 'harness') return {};
    if (sc === 'SC-4') return { s: { surfaced: { planted: 5, surfaced: 0 } } };
    if (!['SC-1', 'SC-2', 'SC-3'].includes(sc)) return {};
    const k = (Number(sc.at(-1)) - 1) * 3 + i;
    return { s: { surfaced: k === 0 ? { planted: 2, surfaced: 2 } : { planted: 1, surfaced: k < n ? 1 : 0 } } };
  });
  const met = at(6);
  assert.deepEqual([met.p1.surfaced, met.p1.planted, met.p1.first_half, met.outcome], [7, 10, true, 'strong pass']);
  const short = at(5);
  assert.deepEqual([short.p1.surfaced, short.p1.planted, short.p1.first_half, short.p1.met], [6, 10, false, false]);
  assert.equal(short.primary.rule, false, 'P2 and P3 hold, but P1 must be among them');
  assert.equal(short.outcome, 'fail');
});

test('P1, first half: a harness SC-1 to SC-3 run without a surfaced count makes the evaluation incomplete', () => {
  const e = ev((arm, sc, i) => (arm === 'harness' && sc === 'SC-2' && i === 0 ? { s: { surfaced: null } } : {}));
  assert.match(e.incomplete.join('\n'), /r-SC-2-harness-0 \(harness, SC-2\) has no surfaced count/);
  assert.deepEqual([e.p1.surfaced, e.p1.planted], [8, 8]);
});

test('P1, second half: broken contracts (M6 reached + M9b) drop by 50%', () => {
  // Baseline 12 broken (1 per coupled run). The harness's 6 is exactly half; 7 isn't.
  const at = (n: number) => ev((arm, sc, i) => {
    const k = COUPLED.indexOf(sc as 'SC-1') * 3 + i;
    return arm === 'harness' && k >= 0 && k < n ? { g: k % 2 ? { m9b: 1 } : { m6_reached: 1 } } : {};
  });
  assert.deepEqual([at(6).p1.broken_harness, at(6).p1.second_half, at(6).p1.met], [6, true, true]);
  assert.deepEqual([at(7).p1.broken_harness, at(7).p1.second_half, at(7).p1.met], [7, false, false]);
});

test('P2: extra copies plus conflicts and overlapping hunks drop by 50% combined; lines removed are never added', () => {
  // n conflicts over the 12 coupled harness runs (n ≥ 12): one each, the rest in the first.
  const at = (n: number) => ev((arm, sc, i) => {
    const k = COUPLED.indexOf(sc as 'SC-1') * 3 + i;
    return arm === 'harness' && k >= 0 ? { s: { m3_conflicts: k === 0 ? n - 11 : 1 }, j: { m2: { units: [], lines_removed_in_integration: 40 } } } : {};
  });
  assert.deepEqual([at(12).p2.m3_harness, at(12).p2.met], [12, true], '12 against 24 is exactly half');
  assert.deepEqual([at(13).p2.m3_harness, at(13).p2.met], [13, false]);
  assert.equal(at(12).p2.m2_harness, 0, 'lines removed in integration are reported beside M2, not added to it');
  assert.equal(at(12).scenarios['SC-1']!.harness.m2_lines, 120);
  // Zero baseline: met only if the harness is at zero too.
  const zero = (h: number) => ev((arm, sc, i) => (!coupled(sc) ? {} : arm === 'baseline' ? { s: { m3_conflicts: 0 }, j: { m2: copy(0) } } : i === 0 && sc === 'SC-1' ? { s: { m3_conflicts: h } } : {}));
  assert.equal(zero(0).p2.met, true);
  assert.equal(zero(1).p2.met, false);
});

test('P3: interventions drop by 30%, or coordination time does', () => {
  // M5: baseline 24. M10: baseline median 100 s, harness 60 s (met) unless raised.
  const at = (m5: number, m10: number) => ev((arm, sc, i) => (arm === 'harness' && coupled(sc) ? { s: { m5: sc === 'SC-1' && i === 0 ? m5 : 0, m10_ms: m10 } } : {}));
  assert.deepEqual([at(16, 100_000).p3.m5_met, at(16, 100_000).p3.met], [true, true], '16 of 24 is a 33% drop');
  assert.deepEqual([at(17, 100_000).p3.m5_met, at(17, 100_000).p3.m10_met, at(17, 100_000).p3.met], [false, false, false]);
  assert.deepEqual([at(17, 70_000).p3.m10_met, at(17, 70_000).p3.met], [true, true], '70 s against 100 s is exactly 30%');
  assert.equal(at(17, 70_001).p3.met, false);
});

test('the primary rule: two of three with P1 among them', () => {
  const noP2 = ev((arm, sc) => (arm === 'harness' && coupled(sc) ? { s: { m3_conflicts: 2 } } : {}));
  assert.deepEqual([noP2.p1.met, noP2.p2.met, noP2.p3.met, noP2.primary.rule, noP2.outcome], [true, false, true, true, 'pass']);
  const onlyP1 = ev((arm, sc) => (arm === 'harness' && coupled(sc) ? { s: { m3_conflicts: 2, m5: 2, m10_ms: 100_000 } } : {}));
  assert.deepEqual([onlyP1.primary.met, onlyP1.primary.rule, onlyP1.outcome], [1, false, 'fail']);
});

test('G1 and G2 at their edges, and strong pass needs median M1 at most the baseline\'s', () => {
  const m1 = (ms: number) => ev((arm, sc) => (arm === 'harness' && coupled(sc) ? { s: { m1_ms: ms } } : {}));
  assert.deepEqual([m1(690_000).g1.met, m1(690_000).outcome], [true, 'pass'], '+15% passes G1, but M1 is above the baseline: no strong pass');
  assert.deepEqual([m1(690_001).g1.met, m1(690_001).outcome], [false, 'fail']);
  assert.equal(m1(600_000).outcome, 'strong pass');
  const capped = ev((arm, sc) => (arm === 'harness' && coupled(sc) ? { s: { m1_ms: null, outcome: 'capped' } } : {}));
  assert.equal(capped.g1.harness_ms, 1_800_000, 'a run that never integrated counts as the cap');
  const tok = (output: number) => ev((arm, sc) => (arm === 'harness' && coupled(sc) ? { s: { m8: { input: 1000, output, cache_read: 0, cache_creation: 0, cost_usd: 1 } } } : {}));
  // Baseline 1100 tokens a run; cache reads and writes count too.
  assert.deepEqual([tok(375).g2.harness_tokens, tok(375).g2.met], [1375, true]);
  assert.equal(tok(376).g2.met, false);
  const cache = ev((arm, sc) => (arm === 'harness' && coupled(sc) ? { s: { m8: { input: 1000, output: 100, cache_read: 200, cache_creation: 76, cost_usd: 0 } } } : {}));
  assert.deepEqual([cache.g2.harness_tokens, cache.g2.met], [1376, false]);
});

test('G3: SC-0 only, totals with the +1 zero-baseline allowance, medians for time and tokens, M7 left out', () => {
  const sc0 = (s: Partial<RunSummary>, i0 = false) => ev((arm, sc, i) => (arm === 'harness' && sc === 'SC-0' && (!i0 || i === 0) ? { s } : {}));
  assert.equal(sc0({ m5: 1 }, true).g3.met, true, 'baseline 0, harness 1');
  assert.equal(sc0({ m5: 2 }, true).g3.met, false, 'baseline 0, harness 2');
  assert.equal(sc0({ m7: { question: 50 } }).g3.met, true, 'messages are the treatment\'s own channel');
  assert.equal(sc0({ m10_ms: 69_000 }).g3.met, true, '+15%');
  assert.equal(sc0({ m10_ms: 69_001 }).g3.met, false);
  assert.equal(sc0({ m4: { commits_after_first: 2, ms_to_green: 1 } }, true).g3.met, false);
  const m9 = ev((arm, sc, i) => (arm === 'harness' && sc === 'SC-0' && i === 0 ? { s: { m9a: 1 }, g: { m9b: 1 } } : {}));
  assert.deepEqual(m9.g3.rows.find((r) => r.metric.startsWith('M9'))!, { metric: 'M9 integration failures (a + b)', kind: 'total', harness: 2, baseline: 0, met: false });
  assert.equal(m9.outcome, 'fail');
});

test('G4: every security test must pass', () => {
  assert.equal(ev(undefined, { ...SECURE, t1b: false }).g4.met, false);
  assert.equal(ev(undefined, { ...SECURE, t1b: false }).outcome, 'fail');
});

test('"inconclusive" is flagged, never decided: the rule fails but every primary metric met its bar or moved the harness\'s way', () => {
  // Every harness metric a little better than the baseline, none by enough; surfacing poor.
  const near = (arm: Arm, sc: string, i: number): Spec => (arm === 'harness' && coupled(sc)
    ? { s: { m3_conflicts: 1, m5: 2 - (i === 0 ? 1 : 0), m10_ms: 90_000, surfaced: sc === 'SC-4' ? null : { planted: 1, surfaced: 0 } }, g: { m6_reached: i === 0 ? 0 : 1 }, j: { m2: copy(i === 0 ? 0 : 1) } }
    : {});
  const e = ev(near);
  assert.deepEqual([e.p1.met, e.p2.met, e.p3.met, e.primary.rule, e.primary.every_metric_favourable, e.outcome], [false, false, false, false, true, 'fail']);
  const worse = ev((arm, sc, i) => (arm === 'harness' && sc === 'SC-1' && i === 1 ? { ...near(arm, sc, i), s: { ...near(arm, sc, i).s, m5: 10 } } : near(arm, sc, i)));
  assert.equal(worse.primary.every_metric_favourable, false, 'M5 went up');
  assert.match(renderReport(e), /the owners decide/);
});

test('void runs are listed with their reason and never scored', () => {
  const e = ev((arm, sc, i) => (arm === 'harness' && sc === 'SC-1' && i === 0 ? { s: { void: 'provider errors for 3 minutes', m5: 99, m1_ms: null } } : {}));
  assert.deepEqual(e.void, [{ run_id: 'r-SC-1-harness-0', scenario: 'SC-1', arm: 'harness', phrasing: 1, reason: 'provider errors for 3 minutes' }]);
  assert.equal(e.runs.some((r) => r.run_id === 'r-SC-1-harness-0'), false);
  assert.equal(e.p3.m5_harness, 0);
  assert.match(e.incomplete.join('\n'), /SC-1: 2 non-void runs in the harness arm; validation.md §3 needs at least 3/);
  assert.match(e.incomplete.join('\n'), /SC-1: 2 harness runs against 3 baseline runs/);
  assert.match(renderReport(e), /\| r-SC-1-harness-0 \| SC-1 \| harness \| 1 \| provider errors for 3 minutes \|/);
});

test('a run without a grade or a judge result is reported missing, and the outcome is provisional', () => {
  const e = ev((arm, sc, i) => (sc === 'SC-3' && i === 2 ? (arm === 'harness' ? { g: null } : { j: null }) : {}));
  assert.equal(e.complete, false);
  assert.deepEqual(e.missing, [
    { run_id: 'r-SC-3-harness-2', scenario: 'SC-3', arm: 'harness', what: ['grade'] },
    { run_id: 'r-SC-3-baseline-2', scenario: 'SC-3', arm: 'baseline', what: ['judge'] },
  ]);
  const h = e.runs.find((r) => r.run_id === 'r-SC-3-harness-2')!;
  assert.deepEqual([h.m6_reached, h.m9b], [null, null]);
  assert.equal(e.runs.find((r) => r.run_id === 'r-SC-3-baseline-2')!.m2, null);
  const text = renderReport(e);
  assert.match(text, /provisional: the evaluation is incomplete/);
  assert.match(text, /r-SC-3-harness-2 \(SC-3, harness\): no grade/);
});

test('SC-4: the grader\'s count replaces the judge\'s for the planted helper; elsewhere the flag is ignored', () => {
  const rec = (scenario: string): RunRecord => ({
    dir: 'r', problems: [], patches: {}, summary: summary({ run_id: 'r', arm: 'baseline', scenario }),
    judge: judge('r', { m2: { units: [{ what: 'ISBN check digit', locations: ['a', 'b'], extra_copies: 1, planted: true }, { what: 'trim', locations: ['c', 'd', 'e'], extra_copies: 2 }], lines_removed_in_integration: 0 } }),
  });
  assert.equal(scoreRun(rec('SC-4'), grade({ m2_planted: 0 })).m2, 2);
  assert.equal(scoreRun(rec('SC-4'), grade({ m2_planted: 3 })).m2, 5);
  assert.equal(scoreRun(rec('SC-4'), undefined).m2, null, 'no grade: the planted helper is unknown');
  assert.equal(scoreRun(rec('SC-2'), grade({ m2_planted: 3 })).m2, 3);
});

test('M6: reached from the grader, caught from the judge, at most one per agent and coupling', () => {
  const r: RunRecord = {
    dir: 'r', problems: [], patches: {}, summary: summary({ run_id: 'r', arm: 'harness', scenario: 'SC-1' }),
    judge: judge('r', { m6: { incidents: [
      { agent: 'frontend', coupling: 'login-response', evidence: 'x', caught: true },
      { agent: 'Frontend', coupling: 'login-response ', evidence: 'y', caught: true },
      { agent: 'backend', coupling: 'login-response', evidence: 'z', caught: false },
    ] } }),
  };
  const s = scoreRun(r, grade({ m6_reached: 2 }));
  assert.deepEqual([s.m6_reached, s.m6_caught, s.m6_judge_uncaught], [2, 1, 1]);
});

test('M3 hunks: parsed by base range from a -U0 patch, new files keyed by their path', () => {
  const patch = [
    'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts',
    '@@ -3,2 +3,1 @@', '--- a removed line that looks like a header', '-x', '+y',
    '@@ -10,0 +10,2 @@ function f() {', '+p', '+q',
    '@@ -20 +21 @@', '-r', '+s', '\\ No newline at end of file',
    'diff --git a/src/new.ts b/src/new.ts', 'new file mode 100644', '--- /dev/null', '+++ b/src/new.ts', '@@ -0,0 +1,2 @@', '+one', '+two',
    'diff --git a/src/gone.ts b/src/gone.ts', 'deleted file mode 100644', '--- a/src/gone.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@', '-1', '-2', '-3', '',
  ].join('\n');
  assert.deepEqual(parseHunks(patch).map((h) => [h.file, h.start, h.count]), [
    ['src/a.ts', 3, 2], ['src/a.ts', 10, 0], ['src/a.ts', 20, 1], ['src/new.ts', 0, 0], ['src/gone.ts', 1, 3],
  ]);
});

test('M3 hunks: which pairs overlap, including pure insertions', () => {
  const h = (start: number, count: number, file = 'f'): Hunk => ({ file, start, count, body: '' });
  assert.equal(hunksOverlap(h(3, 2), h(4, 5)), true, 'lines 3-4 and 4-8');
  assert.equal(hunksOverlap(h(3, 2), h(5, 1)), false, 'adjacent changes: lines 3-4 and 5');
  assert.equal(hunksOverlap(h(3, 2), h(4, 1, 'g')), false, 'another file');
  assert.equal(hunksOverlap(h(3, 0), h(3, 2)), true, 'an insertion between lines 3 and 4, both replaced by the other');
  assert.equal(hunksOverlap(h(3, 2), h(3, 0)), true, 'the same, either way round');
  assert.equal(hunksOverlap(h(2, 0), h(3, 2)), false, 'an insertion just before the change');
  assert.equal(hunksOverlap(h(4, 0), h(3, 2)), false, 'an insertion just after it');
  assert.equal(hunksOverlap(h(5, 0), h(3, 1)), false);
  assert.equal(hunksOverlap(h(7, 0), h(7, 0)), true, 'two insertions at the same point');
  assert.equal(hunksOverlap(h(7, 0), h(8, 0)), false);
});

test('M3 hunks: overlapping pairs counted once each, identical hunks (a synced-in change) not at all', () => {
  const p = (...hunks: string[]) => ['diff --git a/f b/f', '--- a/f', '+++ b/f', ...hunks, ''].join('\n');
  const t1 = p('@@ -3,2 +3,2 @@', '-a', '-b', '+A', '+B', '@@ -10,0 +11 @@', '+n');
  const t2 = p('@@ -4 +4 @@', '-b', '+bee', '@@ -10,0 +11 @@', '+m', '@@ -30 +31 @@', '-z', '+Z');
  assert.equal(overlappingHunks(t1, t2), 2, 'line 4, and the two insertions after line 10');
  const synced = p('@@ -3,2 +3,2 @@', '-a', '-b', '+A', '+B', '@@ -30 +30 @@', '-z', '+Z');
  assert.equal(overlappingHunks(t1, synced), 0, 'the same edit on both branches merges cleanly');
  assert.equal(overlappingHunks(t1, ''), 0);
});

test('records from disk: overlaps from the task diffs, a directory without summary.json skipped, a bad file an error', () => {
  const dir = path.join(tmp, 'disk');
  const write = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
  write(path.join(dir, 'r-1', 'summary.json'), summary({ run_id: 'r-1', arm: 'harness', scenario: 'SC-1', m3_conflicts: 1 }));
  write(path.join(dir, 'r-1', 'judge.json'), judge('r-1'));
  write(path.join(dir, 'r-1', 'diffs', 'T1.patch'), '--- a/f\n+++ b/f\n@@ -3 +3 @@\n-a\n+b\n');
  write(path.join(dir, 'r-1', 'diffs', 'T2.patch'), '--- a/f\n+++ b/f\n@@ -2,3 +2 @@\n-x\n-a\n-y\n+c\n');
  write(path.join(dir, 'r-1', 'diffs', 'main.patch'), 'not a task');
  write(path.join(dir, 'r-2', 'summary.json'), summary({ run_id: 'r-2', arm: 'baseline', scenario: 'SC-1' }));
  write(path.join(dir, 'r-3', 'summary.json'), { v: 1, run_id: 'r-3' });
  write(path.join(dir, 'old', 'meta.json'), {});
  const loaded = loadRecords(dir);
  assert.deepEqual(loaded.records.map((r) => [r.dir, Object.keys(r.patches)]), [['r-1', ['T1', 'T2']], ['r-2', []]]);
  assert.deepEqual(loaded.skipped, [{ dir: 'old', reason: 'no summary.json' }]);
  assert.match(loaded.errors[0]!, /r-3\/summary.json: bad or missing/);
  const e = evaluate(loaded, { v: 1, runs: { 'r-1': grade(), 'r-9': grade() } }, SECURE);
  const r1 = e.runs.find((r) => r.run_id === 'r-1')!;
  assert.deepEqual([r1.m3_conflicts, r1.m3_overlaps, r1.m3], [1, 1, 2]);
  assert.deepEqual(e.missing.find((m) => m.run_id === 'r-2')!.what, ['grade', 'judge', 'task diffs (0 of 2)']);
  assert.match(e.incomplete.join('\n'), /unreadable: r-3/);
  assert.match(e.notes.join('\n'), /grades run r-9, which has no record/);
});

test('the report says which pass bar it judged against, and has every section §8 asks of the scorer', () => {
  const text = renderReport(ev());
  for (const s of ['judged against pass bar v1', '**Outcome: STRONG PASS**', '## Pass-bar evaluation', '### G3 on SC-0', '## Per-scenario metrics', '## Runs', '## Diagnostics', '## Void runs', '## Missing and skipped', '## Judge']) {
    assert.ok(text.includes(s), s);
  }
  assert.match(text, /\| P2 \| .* \| 0 \(M2 0 \+ M3 0\) \| 24 \(M2 12 \+ M3 12\) \| drop ≥ 50% \(−100%\) \| \*\*✔ met\*\* \|/);
});

test('grades.json and judge.json are checked', () => {
  assert.throws(() => checkGrades({ v: 1, runs: { r: { checks: { a: 'maybe' }, m9b: 0, m6_reached: 0, m2_planted: 0 } } }), /bad grade for run r/);
  assert.throws(() => checkGrades({ v: 1, runs: { r: { checks: {}, m9b: -1, m6_reached: 0, m2_planted: 0 } } }), /bad grade for run r/);
  assert.throws(() => checkJudge({ ...judge('r'), m6: { incidents: [{ agent: 'a', coupling: 'c', evidence: 'e', caught: 'yes' }] } }), /m6.incidents\[0\]/);
  assert.throws(() => checkJudge({ ...judge('r'), m2: { units: [{ what: 'w', locations: [], extra_copies: 1.5 }], lines_removed_in_integration: 0 } }), /m2.units\[0\]/);
  assert.equal(checkJudge(judge('r')).run_id, 'r');
});
