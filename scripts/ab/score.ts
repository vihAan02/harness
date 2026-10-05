// The A/B scorer (A9; validation.md §5, §8, §9). It reads every run the runner recorded, the grader's
// grades.json and the security tests' latest results, computes each run's metrics, and judges the study
// against pass bar v1 (D-57) with §9's scoring rules, applied as written. It reads what the grader returns,
// never the hidden checks (B11).
//
//   node scripts/ab/score.ts --records runs/record --grades grades.json --security security.json [--out <file.md>] [--json]
//
//   --records <dir>    one directory per run (the layout in scripts/ab/summary.ts), each with the judge.json
//                      that scripts/ab/judge.ts writes
//   --grades <file>    the grader's grades.json
//   --security <file>  the security tests' latest results, for G4: { "t1": true, "t1b": true, "t2": true, "at": "<date>" }
//   --out <file>       write there instead of to stdout
//   --json             the machine-readable evaluation instead of the Markdown results report (§8)
//
// A run with no grade or no judge result is listed as missing and the evaluation is marked incomplete; void
// runs are listed with their reasons and never scored.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  ARMS, checkGrades, checkJudge, checkSummary, COUPLED, SCENARIOS, type Arm, type Grade, type Grades, type JudgeResult, type RunSummary,
} from './summary.ts';

/** The pass bar every run here is judged against (validation.md §5). A later version applies only to runs started after it. */
export const PASS_BAR = 'v1';
/** validation.md §3: at least this many non-void runs per scenario per arm. */
export const MIN_RUNS = 3;
/** The scenarios with a planted dependency change, which P1's first half sums over (§9); SC-4's trap is duplication (P2). */
export const PLANTED_CHANGE = ['SC-1', 'SC-2', 'SC-3'] as const;

// ---- M3's overlapping hunks (§9) ----

/** One hunk of a `git diff -U0` patch by its base range, `@@ -start,count`. Count 0 is a pure insertion after line `start`. */
export type Hunk = { file: string; start: number; count: number; body: string };

const pathOf = (s: string) => {
  const p = s.replace(/\t.*$/, '').trim().replace(/^"(.*)"$/, '$1');
  return p === '/dev/null' ? p : p.replace(/^[ab]\//, '');
};

/** The hunks of a patch, keyed by the file's base path; a new file's by its new path, so two tasks adding it collide. */
export function parseHunks(patch: string): Hunk[] {
  const out: Hunk[] = [];
  let from = '';
  let to = '';
  let cur: Hunk | null = null;
  let left = 0;
  let right = 0;
  for (const line of patch.split('\n')) {
    if (cur && (left > 0 || right > 0)) {
      if (line.startsWith('-')) left--;
      else if (line.startsWith('+')) right--;
      else if (line.startsWith(' ')) { left--; right--; } else if (!line.startsWith('\\')) left = right = 0;
      if (left >= 0 && right >= 0) cur.body += `${line}\n`;
      continue;
    }
    if (line.startsWith('diff --git ')) { from = to = ''; cur = null; continue; }
    if (line.startsWith('--- ')) { from = pathOf(line.slice(4)); continue; }
    if (line.startsWith('+++ ')) { to = pathOf(line.slice(4)); continue; }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!m) continue;
    cur = { file: from === '/dev/null' || from === '' ? to : from, start: Number(m[1]), count: m[2] === undefined ? 1 : Number(m[2]), body: '' };
    left = cur.count;
    right = m[4] === undefined ? 1 : Number(m[4]);
    out.push(cur);
  }
  return out;
}

/**
 * Whether two hunks touch the same base lines. A change covers lines start..start+count-1. An insertion after
 * line g sits between lines g and g+1: it meets a change only strictly inside it (start <= g < end), and another
 * insertion only at the same point. Hunks that are merely adjacent don't overlap.
 */
export function hunksOverlap(a: Hunk, b: Hunk): boolean {
  if (a.file !== b.file) return false;
  if (a.count === 0 && b.count === 0) return a.start === b.start;
  if (a.count === 0) return b.start <= a.start && a.start < b.start + b.count - 1;
  if (b.count === 0) return hunksOverlap(b, a);
  return a.start < b.start + b.count && b.start < a.start + a.count;
}

/**
 * M3's second half: pairs of hunks, one from each task's diff, whose base lines intersect, counted once per pair.
 * Identical hunks don't count: that's one edit on both branches (what a sync brings in, or the same line written
 * twice), and it merges cleanly.
 */
export function overlappingHunks(a: string, b: string): number {
  const hb = parseHunks(b);
  let n = 0;
  for (const x of parseHunks(a)) {
    for (const y of hb) if (hunksOverlap(x, y) && !(x.start === y.start && x.count === y.count && x.body === y.body)) n++;
  }
  return n;
}

// ---- Loading ----

export type RunRecord = { dir: string; summary: RunSummary; judge: JudgeResult | null; patches: Record<string, string>; problems: string[] };
export type Loaded = { records: RunRecord[]; skipped: { dir: string; reason: string }[]; errors: string[] };
export type Security = { t1: boolean; t1b: boolean; t2: boolean; at: string };

/** Every run directory under `dir`. A directory without summary.json is skipped (named); an unreadable file is an error. */
export function loadRecords(dir: string): Loaded {
  const out: Loaded = { records: [], skipped: [], errors: [] };
  for (const name of fs.readdirSync(dir).sort()) {
    const d = path.join(dir, name);
    if (!fs.statSync(d).isDirectory()) continue;
    const file = path.join(d, 'summary.json');
    if (!fs.existsSync(file)) { out.skipped.push({ dir: name, reason: 'no summary.json' }); continue; }
    let summary: RunSummary;
    try {
      summary = checkSummary(JSON.parse(fs.readFileSync(file, 'utf8')), `${name}/summary.json`);
    } catch (e) {
      out.errors.push((e as Error).message);
      continue;
    }
    const problems: string[] = [];
    if (summary.run_id !== name) problems.push(`its directory is ${name}, its run_id ${summary.run_id}`);
    let judge: JudgeResult | null = null;
    const jf = path.join(d, 'judge.json');
    if (fs.existsSync(jf)) {
      try {
        judge = checkJudge(JSON.parse(fs.readFileSync(jf, 'utf8')), `${name}/judge.json`);
        if (judge.run_id !== summary.run_id) throw new Error(`${name}/judge.json: judges run ${judge.run_id}`);
      } catch (e) {
        out.errors.push((e as Error).message);
        judge = null;
      }
    }
    const patches: Record<string, string> = {};
    const dd = path.join(d, 'diffs');
    if (fs.existsSync(dd)) {
      for (const f of fs.readdirSync(dd).sort()) if (f.endsWith('.patch') && f !== 'main.patch') patches[f.slice(0, -6)] = fs.readFileSync(path.join(dd, f), 'utf8');
    }
    out.records.push({ dir: name, summary, judge, patches, problems });
  }
  return out;
}

/** The security tests' results file (G4). Throws when it isn't one. */
export function checkSecurity(v: unknown, where = 'security.json'): Security {
  const s = v as Record<string, unknown>;
  if (typeof v !== 'object' || v === null || !['t1', 't1b', 't2'].every((k) => typeof s[k] === 'boolean') || typeof s.at !== 'string') {
    throw new Error(`${where}: expected { "t1": bool, "t1b": bool, "t2": bool, "at": "<date>" }`);
  }
  return v as Security;
}

// ---- One run's metrics ----

export type RunScore = {
  run_id: string; arm: Arm; scenario: string; phrasing: number; outcome: RunSummary['outcome']; models: string[];
  /** Inputs the run lacks ('grade', 'judge', a diff); the metrics that need them are null. */
  missing: string[];
  dry_judge: boolean;
  /** M1, with a run that never integrated counted as the cap (§9). */
  m1_ms: number; m1_capped: boolean;
  /** M2: extra copies (on SC-4 the grader's count for the planted helper replaces the judge's); lines removed beside it. */
  m2: number | null; m2_lines: number | null;
  /** M3: conflicts at integration plus overlapping hunk pairs. */
  m3: number; m3_conflicts: number; m3_overlaps: number;
  m4_commits: number; m4_ms_to_green: number | null;
  m5: number; m5b: number | null; m5c: number;
  /** M6: reached (the grader) and caught (the judge); the judge's own uncaught count, beside the grader's. */
  m6_reached: number | null; m6_caught: number | null; m6_judge_uncaught: number | null;
  m7: number; m7_by_kind: Record<string, number>;
  /** M8: input + output + cache reads + cache writes; cost beside it. */
  m8_tokens: number; m8_cost_usd: number;
  m9a: number; m9b: number | null;
  m10_ms: number;
  surfaced: { planted: number; surfaced: number } | null;
  judge_cost_usd: number | null;
};

/** At most one M6 incident per planted coupling per agent per run (§9): distinct (agent, coupling) pairs. */
const pairs = (xs: { agent: string; coupling: string }[]) => new Set(xs.map((x) => `${x.agent.trim().toLowerCase()}\u0000${x.coupling.trim().toLowerCase()}`));

/** One run's metrics from its record, its judge result and its grade. */
export function scoreRun(rec: RunRecord, grade: Grade | undefined): RunScore {
  const s = rec.summary;
  const j = rec.judge;
  const missing: string[] = [];
  if (!grade) missing.push('grade');
  if (!j) missing.push('judge');
  const keys = Object.keys(rec.patches);
  if (keys.length < s.tasks.length) missing.push(`task diffs (${keys.length} of ${s.tasks.length})`);
  let overlaps = 0;
  for (let i = 0; i < keys.length; i++) for (let k = i + 1; k < keys.length; k++) overlaps += overlappingHunks(rec.patches[keys[i]!]!, rec.patches[keys[k]!]!);
  const sc4 = s.scenario === 'SC-4';
  const judged = j ? j.m2.units.filter((u) => !(sc4 && u.planted)).reduce((n, u) => n + u.extra_copies, 0) : null;
  const m2 = judged === null ? null : sc4 ? (grade ? judged + grade.m2_planted : null) : judged;
  const caught = j ? pairs(j.m6.incidents.filter((x) => x.caught)) : null;
  const uncaught = j && caught ? [...pairs(j.m6.incidents.filter((x) => !x.caught))].filter((p) => !caught.has(p)).length : null;
  return {
    run_id: s.run_id, arm: s.arm, scenario: s.scenario, phrasing: s.phrasing, outcome: s.outcome, models: s.models,
    missing, dry_judge: j?.judge_model === 'dry',
    m1_ms: s.m1_ms ?? s.cap_ms, m1_capped: s.m1_ms === null,
    m2, m2_lines: j ? j.m2.lines_removed_in_integration : null,
    m3: s.m3_conflicts + overlaps, m3_conflicts: s.m3_conflicts, m3_overlaps: overlaps,
    m4_commits: s.m4.commits_after_first, m4_ms_to_green: s.m4.ms_to_green,
    m5: s.m5, m5b: s.m5b, m5c: s.m5c,
    m6_reached: grade ? grade.m6_reached : null, m6_caught: caught ? caught.size : null, m6_judge_uncaught: uncaught,
    m7: Object.values(s.m7).reduce((a, b) => a + b, 0), m7_by_kind: s.m7,
    m8_tokens: s.m8.input + s.m8.output + s.m8.cache_read + s.m8.cache_creation, m8_cost_usd: s.m8.cost_usd,
    m9a: s.m9a, m9b: grade ? grade.m9b : null,
    m10_ms: s.m10_ms,
    surfaced: s.surfaced,
    judge_cost_usd: j ? j.cost_usd : null,
  };
}

// ---- The rules (§5, §9) ----

/** The median; with an even count, the mean of the middle two (§9). Null for no values. */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const v = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2;
}

/** Time and token metrics (§5): the median per scenario, then the median of those across scenarios. */
export function medianOfMedians(runs: RunScore[], scenarios: readonly string[], f: (r: RunScore) => number): number | null {
  const per = scenarios.map((sc) => median(runs.filter((r) => r.scenario === sc).map(f)));
  return median(per.filter((m): m is number => m !== null));
}

/** Count metrics (§5): the total across runs. A run missing the input adds nothing (and is listed as missing). */
export const total = (runs: RunScore[], f: (r: RunScore) => number | null) => runs.reduce((n, r) => n + (f(r) ?? 0), 0);

/** A "drops by pct%" criterion, with the zero-baseline rule: against a zero baseline only zero meets it (§5). */
export function dropBy(harness: number, baseline: number, pct: number): boolean {
  return baseline === 0 ? harness === 0 : (baseline - harness) * 100 >= pct * baseline;
}

/** A "no worse than baseline + pct%" guardrail; a count metric with a zero baseline allows at most +1 in total (§5). */
export function noWorse(harness: number, baseline: number, pct: number, count: boolean): boolean {
  return count && baseline === 0 ? harness <= 1 : harness * 100 <= baseline * (100 + pct);
}

const broken = (r: RunScore) => (r.m6_reached === null && r.m9b === null ? null : (r.m6_reached ?? 0) + (r.m9b ?? 0));
const m6 = (r: RunScore) => (r.m6_reached === null && r.m6_caught === null ? null : (r.m6_reached ?? 0) + (r.m6_caught ?? 0));
const m9 = (r: RunScore) => r.m9a + (r.m9b ?? 0);

export type Agg = {
  runs: number; m1_ms: number | null; capped: number; m2: number; m2_lines: number; m3: number; m3_conflicts: number; m4_commits: number;
  m5: number; m5b: number; m5c: number; m6_reached: number; m6_caught: number; m7: number; m8_tokens: number | null; m8_cost_usd: number;
  m9a: number; m9b: number; m10_ms: number | null;
};

/** One scenario's runs in one arm: totals for counts, medians for time and tokens. */
export function aggregate(runs: RunScore[]): Agg {
  return {
    runs: runs.length, m1_ms: median(runs.map((r) => r.m1_ms)), capped: runs.filter((r) => r.m1_capped).length,
    m2: total(runs, (r) => r.m2), m2_lines: total(runs, (r) => r.m2_lines), m3: total(runs, (r) => r.m3), m3_conflicts: total(runs, (r) => r.m3_conflicts),
    m4_commits: total(runs, (r) => r.m4_commits), m5: total(runs, (r) => r.m5), m5b: total(runs, (r) => r.m5b), m5c: total(runs, (r) => r.m5c),
    m6_reached: total(runs, (r) => r.m6_reached), m6_caught: total(runs, (r) => r.m6_caught), m7: total(runs, (r) => r.m7),
    m8_tokens: median(runs.map((r) => r.m8_tokens)), m8_cost_usd: total(runs, (r) => r.m8_cost_usd),
    m9a: total(runs, (r) => r.m9a), m9b: total(runs, (r) => r.m9b), m10_ms: median(runs.map((r) => r.m10_ms)),
  };
}

export type G3Row = { metric: string; kind: 'total' | 'median'; harness: number | null; baseline: number | null; met: boolean };
export type Evaluation = {
  pass_bar: typeof PASS_BAR;
  outcome: 'strong pass' | 'pass' | 'fail';
  /** False when anything below is missing; the outcome is then provisional. */
  complete: boolean;
  incomplete: string[];
  notes: string[];
  p1: { surfaced: number; planted: number; first_half: boolean; broken_harness: number; broken_baseline: number; second_half: boolean; met: boolean };
  p2: { m2_harness: number; m3_harness: number; m2_baseline: number; m3_baseline: number; met: boolean };
  p3: { m5_harness: number; m5_baseline: number; m5_met: boolean; m10_harness_ms: number | null; m10_baseline_ms: number | null; m10_met: boolean; met: boolean };
  primary: { met: number; rule: boolean; every_metric_favourable: boolean };
  g1: { harness_ms: number | null; baseline_ms: number | null; met: boolean };
  g2: { harness_tokens: number | null; baseline_tokens: number | null; met: boolean };
  g3: { rows: G3Row[]; met: boolean };
  g4: Security & { met: boolean };
  strong: { m1_at_most_baseline: boolean; met: boolean };
  scenarios: Record<string, Record<Arm, Agg>>;
  runs: RunScore[];
  void: { run_id: string; scenario: string; arm: Arm; phrasing: number; reason: string }[];
  missing: { run_id: string; scenario: string; arm: Arm; what: string[] }[];
  skipped: { dir: string; reason: string }[];
  errors: string[];
  judge: { runs: number; cost_usd: number; models: string[] };
};

/** Scores every run and judges the study against pass bar v1. */
export function evaluate(loaded: Loaded, grades: Grades, security: Security): Evaluation {
  const incomplete: string[] = [...loaded.errors.map((e) => `unreadable: ${e}`)];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const r of loaded.records) {
    if (seen.has(r.summary.run_id)) incomplete.push(`run ${r.summary.run_id} is recorded twice`);
    seen.add(r.summary.run_id);
    for (const p of r.problems) notes.push(`run ${r.summary.run_id}: ${p}`);
  }
  const voids = loaded.records.filter((r) => r.summary.void !== null)
    .map((r) => ({ run_id: r.summary.run_id, scenario: r.summary.scenario, arm: r.summary.arm, phrasing: r.summary.phrasing, reason: r.summary.void! }));
  const runs = loaded.records.filter((r) => r.summary.void === null).map((r) => scoreRun(r, grades.runs[r.summary.run_id]));
  const missing = runs.filter((r) => r.missing.length).map((r) => ({ run_id: r.run_id, scenario: r.scenario, arm: r.arm, what: r.missing }));
  for (const m of missing) incomplete.push(`run ${m.run_id} (${m.scenario}, ${m.arm}) has no ${m.what.join(', no ')}`);
  for (const r of runs.filter((x) => x.dry_judge)) incomplete.push(`run ${r.run_id} was judged with --dry, a stub`);
  for (const id of Object.keys(grades.runs)) if (!seen.has(id)) notes.push(`grades.json grades run ${id}, which has no record`);
  for (const sc of SCENARIOS) {
    const n = Object.fromEntries(ARMS.map((a) => [a, runs.filter((r) => r.scenario === sc && r.arm === a).length])) as Record<Arm, number>;
    for (const a of ARMS) if (n[a] < MIN_RUNS) incomplete.push(`${sc}: ${n[a]} non-void run${n[a] === 1 ? '' : 's'} in the ${a} arm; validation.md §3 needs at least ${MIN_RUNS}`);
    if (n.harness !== n.baseline) incomplete.push(`${sc}: ${n.harness} harness runs against ${n.baseline} baseline runs, so its totals compare unequal numbers of runs`);
  }
  const modelSets = new Set(runs.map((r) => [...r.models].sort().join(' + ')));
  if (modelSets.size > 1) notes.push(`the runs used different models: ${[...modelSets].map((m) => m || 'none recorded').join('; ')}`);

  const arm = (a: Arm, scs: readonly string[]) => runs.filter((r) => r.arm === a && scs.includes(r.scenario));
  const [h, b] = [arm('harness', COUPLED), arm('baseline', COUPLED)];

  // P1: surfaced ÷ planted over the harness arm's SC-1 to SC-3 runs, and broken contracts (M6 reached + M9b) halved.
  const hp = arm('harness', PLANTED_CHANGE);
  const withSurfaced = hp.filter((r) => r.surfaced !== null);
  for (const r of hp.filter((x) => x.surfaced === null)) incomplete.push(`run ${r.run_id} (harness, ${r.scenario}) has no surfaced count for P1`);
  const surfaced = total(withSurfaced, (r) => r.surfaced!.surfaced);
  const planted = total(withSurfaced, (r) => r.surfaced!.planted);
  const firstHalf = planted > 0 && surfaced * 100 >= 70 * planted;
  const [bh, bb] = [total(h, broken), total(b, broken)];
  const secondHalf = dropBy(bh, bb, 50);
  const p1 = { surfaced, planted, first_half: firstHalf, broken_harness: bh, broken_baseline: bb, second_half: secondHalf, met: firstHalf && secondHalf };

  // P2: duplicated work (extra copies) plus conflicting edits, halved together.
  const p2v = { m2_harness: total(h, (r) => r.m2), m3_harness: total(h, (r) => r.m3), m2_baseline: total(b, (r) => r.m2), m3_baseline: total(b, (r) => r.m3) };
  const p2 = { ...p2v, met: dropBy(p2v.m2_harness + p2v.m3_harness, p2v.m2_baseline + p2v.m3_baseline, 50) };

  // P3: interventions (a total) or coordination time (a median of medians) down by 30%.
  const [m5h, m5b] = [total(h, (r) => r.m5), total(b, (r) => r.m5)];
  const [m10h, m10b] = [medianOfMedians(h, COUPLED, (r) => r.m10_ms), medianOfMedians(b, COUPLED, (r) => r.m10_ms)];
  const m5met = dropBy(m5h, m5b, 30);
  const m10met = m10h !== null && m10b !== null && dropBy(m10h, m10b, 30);
  const p3 = { m5_harness: m5h, m5_baseline: m5b, m5_met: m5met, m10_harness_ms: m10h, m10_baseline_ms: m10b, m10_met: m10met, met: m5met || m10met };

  const met = [p1.met, p2.met, p3.met].filter(Boolean).length;
  const rule = met >= 2 && p1.met;
  // "Inconclusive" is the owners' call (§9): flag it when the rule fails but each primary metric met its bar or moved the harness's way.
  const lower = (x: number | null, y: number | null) => x !== null && y !== null && x < y;
  const favourable = !rule && (secondHalf || bh < bb)
    && (p2.met || p2v.m2_harness + p2v.m3_harness < p2v.m2_baseline + p2v.m3_baseline)
    && (p3.met || ((m5met || m5h < m5b) && (m10met || lower(m10h, m10b))));

  const [m1h, m1b] = [medianOfMedians(h, COUPLED, (r) => r.m1_ms), medianOfMedians(b, COUPLED, (r) => r.m1_ms)];
  const g1 = { harness_ms: m1h, baseline_ms: m1b, met: m1h !== null && m1b !== null && noWorse(m1h, m1b, 15, false) };
  const [th, tb] = [medianOfMedians(h, COUPLED, (r) => r.m8_tokens), medianOfMedians(b, COUPLED, (r) => r.m8_tokens)];
  const g2 = { harness_tokens: th, baseline_tokens: tb, met: th !== null && tb !== null && noWorse(th, tb, 25, false) };

  // G3: SC-0 only, every metric but M7, no worse than baseline + 15%.
  const [h0, b0] = [arm('harness', ['SC-0']), arm('baseline', ['SC-0'])];
  const both = h0.length > 0 && b0.length > 0;
  const g3row = (metric: string, kind: G3Row['kind'], f: (r: RunScore) => number | null): G3Row => {
    const v = (rs: RunScore[]) => (!rs.length ? null : kind === 'total' ? total(rs, f) : median(rs.map((r) => f(r) ?? 0)));
    const [x, y] = [v(h0), v(b0)];
    return { metric, kind, harness: x, baseline: y, met: both && x !== null && y !== null && noWorse(x, y, 15, kind === 'total') };
  };
  const g3rows = [
    g3row('M1 completion time', 'median', (r) => r.m1_ms), g3row('M2 duplicated work', 'total', (r) => r.m2),
    g3row('M3 conflicting edits', 'total', (r) => r.m3), g3row('M4 commits after the first integration', 'total', (r) => r.m4_commits),
    g3row('M5 human interventions', 'total', (r) => r.m5), g3row('M6 stale-context incidents', 'total', m6),
    g3row('M8 total tokens', 'median', (r) => r.m8_tokens), g3row('M9 integration failures (a + b)', 'total', m9),
    g3row('M10 coordination time', 'median', (r) => r.m10_ms),
  ];
  const g3 = { rows: g3rows, met: both && g3rows.every((r) => r.met) };
  const g4 = { ...security, met: security.t1 && security.t1b && security.t2 };

  const guards = g1.met && g2.met && g3.met && g4.met;
  const m1AtMost = m1h !== null && m1b !== null && m1h <= m1b;
  const strong = { m1_at_most_baseline: m1AtMost, met: p1.met && p2.met && p3.met && guards && m1AtMost };
  const scenarios = Object.fromEntries(SCENARIOS.map((sc) => [sc, Object.fromEntries(ARMS.map((a) => [a, aggregate(arm(a, [sc]))]))])) as Evaluation['scenarios'];
  const judged = runs.filter((r) => r.judge_cost_usd !== null);
  const judgeModels = [...new Set(loaded.records.flatMap((r) => (r.judge ? [r.judge.judge_model] : [])))];
  return {
    pass_bar: PASS_BAR, outcome: strong.met ? 'strong pass' : rule && guards ? 'pass' : 'fail', complete: incomplete.length === 0, incomplete, notes,
    p1, p2, p3, primary: { met, rule, every_metric_favourable: favourable }, g1, g2, g3, g4, strong, scenarios, runs,
    void: voids, missing, skipped: loaded.skipped, errors: loaded.errors,
    judge: { runs: judged.length, cost_usd: total(judged, (r) => r.judge_cost_usd), models: judgeModels },
  };
}

// ---- The results report (§8) ----

const mins = (ms: number | null) => (ms === null ? '—' : `${(ms / 60_000).toFixed(1)} min`);
const int = (n: number | null) => (n === null ? '—' : Math.round(n).toLocaleString('en-US'));
const usd = (n: number) => `$${n.toFixed(n < 1 ? 4 : 2)}`;
const ok = (b: boolean) => (b ? '✔ met' : '✖ not met');
const change = (h: number | null, b: number | null) => (h === null || b === null || b === 0 ? '' : ` (${h >= b ? '+' : '−'}${Math.round((Math.abs(h - b) / b) * 100)}%)`);
const opt = (n: number | null) => (n === null ? '—' : String(n));

/** What §5 recommends for the outcome. */
export function recommendation(e: Evaluation): string {
  if (e.outcome !== 'fail') return 'Proceed to Phase 1. The owner decides and records the decision as a D-ID (§5).';
  if (e.primary.every_metric_favourable) {
    return 'The primary rule isn\'t met, but every primary metric met its bar or moved in the harness\'s favour. Whether that is "inconclusive" is the owners\' call (§5, §9); if it is, add runs under the same bar before deciding.';
  }
  return 'Adjust the thesis or the design before Phase 1, rather than adding features to rescue the result (§5, R-8).';
}

/** The Markdown results report: the evaluation, the per-scenario metrics, diagnostics, void and missing runs. */
export function renderReport(e: Evaluation, recordsDir = 'runs/record'): string {
  const L: string[] = [];
  const counted = e.runs.length + e.void.length;
  L.push(`# A/B gate results, judged against pass bar ${e.pass_bar}`, '');
  L.push(`Every run is judged against **pass bar ${e.pass_bar}** (approved 2026-10-01, D-57; validation.md §5), with the scoring rules of validation.md §9. ${counted} recorded run${counted === 1 ? '' : 's'}: ${e.runs.length} scored, ${e.void.length} void. Records: \`${recordsDir}\`.`, '');
  L.push(`**Outcome: ${e.outcome.toUpperCase()}**${e.complete ? '' : ' (provisional: the evaluation is incomplete, see below)'}`, '');
  L.push(`- Primary criteria met: ${e.primary.met} of 3; the primary rule (at least 2, P1 among them) is ${e.primary.rule ? 'met' : 'not met'}.`);
  L.push(`- Guardrails: G1 ${e.g1.met ? '✔' : '✖'}, G2 ${e.g2.met ? '✔' : '✖'}, G3 ${e.g3.met ? '✔' : '✖'}, G4 ${e.g4.met ? '✔' : '✖'}.`);
  if (e.primary.every_metric_favourable) L.push('- **Every primary metric met its bar or moved in the harness\'s favour, but the primary rule isn\'t met: the owners decide (§5 "inconclusive").**');
  L.push(`- Recommendation: ${recommendation(e)}`, '');
  if (!e.complete) {
    L.push('## Incomplete', '', 'The outcome above is provisional until these are resolved:', '');
    for (const x of e.incomplete) L.push(`- ${x}`);
    L.push('');
  }

  L.push('## Pass-bar evaluation (coupled scenarios SC-1 to SC-4 unless stated)', '');
  L.push('| ID | Criterion | Harness | Baseline | Threshold | Result |', '|---|---|---|---|---|---|');
  const rate = e.p1.planted ? ` (${Math.round((e.p1.surfaced / e.p1.planted) * 100)}%)` : '';
  L.push(`| P1 | Planted changes surfaced to the affected agent before its task finished (SC-1 to SC-3) | ${e.p1.surfaced} of ${e.p1.planted}${rate} | (harness arm only) | ≥ 70% | ${ok(e.p1.first_half)} |`);
  L.push(`| | and broken contracts reaching integration (M6 reached + M9b), totals | ${e.p1.broken_harness} | ${e.p1.broken_baseline} | drop ≥ 50%${change(e.p1.broken_harness, e.p1.broken_baseline)} | ${ok(e.p1.second_half)} |`);
  L.push(`| | **P1** | | | both halves | **${ok(e.p1.met)}** |`);
  const [ph, pb] = [e.p2.m2_harness + e.p2.m3_harness, e.p2.m2_baseline + e.p2.m3_baseline];
  L.push(`| P2 | Duplicated work (M2, extra copies) plus conflicting edits (M3), totals | ${ph} (M2 ${e.p2.m2_harness} + M3 ${e.p2.m3_harness}) | ${pb} (M2 ${e.p2.m2_baseline} + M3 ${e.p2.m3_baseline}) | drop ≥ 50%${change(ph, pb)} | **${ok(e.p2.met)}** |`);
  L.push(`| P3 | Human interventions (M5), totals | ${e.p3.m5_harness} | ${e.p3.m5_baseline} | drop ≥ 30%${change(e.p3.m5_harness, e.p3.m5_baseline)} | ${ok(e.p3.m5_met)} |`);
  L.push(`| | or human coordination time (M10), median of scenario medians | ${mins(e.p3.m10_harness_ms)} | ${mins(e.p3.m10_baseline_ms)} | drop ≥ 30%${change(e.p3.m10_harness_ms, e.p3.m10_baseline_ms)} | ${ok(e.p3.m10_met)} |`);
  L.push(`| | **P3** | | | either | **${ok(e.p3.met)}** |`);
  L.push(`| | **Primary rule** | ${e.primary.met} of 3 | | ≥ 2 of 3, P1 among them | **${ok(e.primary.rule)}** |`);
  L.push(`| G1 | Completion time (M1, the cap when never integrated), median of scenario medians | ${mins(e.g1.harness_ms)} | ${mins(e.g1.baseline_ms)} | ≤ baseline + 15%${change(e.g1.harness_ms, e.g1.baseline_ms)} | **${ok(e.g1.met)}** |`);
  L.push(`| G2 | Total tokens per run (M8: input, output, cache reads and writes), median of scenario medians | ${int(e.g2.harness_tokens)} | ${int(e.g2.baseline_tokens)} | ≤ baseline + 25%${change(e.g2.harness_tokens, e.g2.baseline_tokens)} | **${ok(e.g2.met)}** |`);
  L.push(`| G3 | SC-0: no metric worse than baseline by more than 15% (table below) | | | each row | **${ok(e.g3.met)}** |`);
  L.push(`| G4 | Security tests T-1, T-1b, T-2, latest results (${e.g4.at}) | T-1 ${e.g4.t1 ? 'pass' : 'fail'}, T-1b ${e.g4.t1b ? 'pass' : 'fail'}, T-2 ${e.g4.t2 ? 'pass' : 'fail'} | | all pass | **${ok(e.g4.met)}** |`);
  L.push(`| | **Strong pass** | | | P1–P3, G1–G4, and median M1 ≤ baseline (${e.strong.m1_at_most_baseline ? 'yes' : 'no'}) | **${ok(e.strong.met)}** |`, '');

  L.push('### G3 on SC-0', '', 'Totals use the zero-baseline rule (a zero baseline allows at most +1); time and tokens are medians. M7 is left out: it counts the treatment\'s own channel (§9).', '');
  L.push('| Metric | | Harness | Baseline | Result |', '|---|---|---|---|---|');
  for (const r of e.g3.rows) {
    const f = r.metric.startsWith('M1 ') || r.metric.startsWith('M10 ') ? mins : int;
    L.push(`| ${r.metric} | ${r.kind} | ${f(r.harness)} | ${f(r.baseline)}${change(r.harness, r.baseline)} | ${r.met ? '✔' : '✖'} |`);
  }
  L.push('');

  L.push('## Per-scenario metrics', '', 'Counts are totals over the scenario\'s scored runs; M1, M8 tokens and M10 are medians. M3 is conflicts at integration plus overlapping hunk pairs. M6 is reached (the grader) / caught (the judge).', '');
  L.push('| Scenario | Arm | Runs | M1 (capped) | M2 (lines removed) | M3 (conflicts) | M4 commits | M5 | M6 reached / caught | M7 | M8 tokens | M8 cost | M9a + M9b | M10 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const sc of SCENARIOS) {
    for (const a of ARMS) {
      const g = e.scenarios[sc]![a];
      L.push(`| ${sc} | ${a} | ${g.runs} | ${mins(g.m1_ms)} (${g.capped}) | ${g.m2} (${g.m2_lines}) | ${g.m3} (${g.m3_conflicts}) | ${g.m4_commits} | ${g.m5} | ${g.m6_reached} / ${g.m6_caught} | ${g.m7} | ${int(g.m8_tokens)} | ${usd(g.m8_cost_usd)} | ${g.m9a} + ${g.m9b} | ${mins(g.m10_ms)} |`);
    }
  }
  L.push('');

  L.push('## Runs', '');
  L.push('| Run | Scenario | Arm | Phrasing | Outcome | M1 | M2 | M3 | M5 | M6 r / c | M9 a + b | M10 | Tokens | Judge |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of [...e.runs].sort((x, y) => x.scenario.localeCompare(y.scenario) || x.phrasing - y.phrasing || x.arm.localeCompare(y.arm))) {
    L.push(`| ${r.run_id} | ${r.scenario} | ${r.arm} | ${r.phrasing} | ${r.outcome} | ${mins(r.m1_ms)}${r.m1_capped ? ' (cap)' : ''} | ${opt(r.m2)} | ${r.m3_conflicts} + ${r.m3_overlaps} | ${r.m5} | ${opt(r.m6_reached)} / ${opt(r.m6_caught)} | ${r.m9a} + ${opt(r.m9b)} | ${mins(r.m10_ms)} | ${int(r.m8_tokens)} | ${r.judge_cost_usd === null ? '—' : usd(r.judge_cost_usd)} |`);
  }
  L.push('');

  L.push('## Diagnostics (not pass criteria)', '');
  for (const a of ARMS) {
    const rs = e.runs.filter((r) => r.arm === a);
    const kinds: Record<string, number> = {};
    for (const r of rs) for (const [k, n] of Object.entries(r.m7_by_kind)) kinds[k] = (kinds[k] ?? 0) + n;
    const ttg = median(rs.flatMap((r) => (r.m4_ms_to_green === null ? [] : [r.m4_ms_to_green])));
    L.push(`- **${a}:** M5b denied tool calls ${total(rs, (r) => r.m5b)}, M5c integration actions ${total(rs, (r) => r.m5c)}; M7 messages by kind ${Object.keys(kinds).length ? Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(', ') : 'none'}; M2 lines removed in integration ${total(rs, (r) => r.m2_lines)}; M4 median time to green ${mins(ttg)}; agent cost ${usd(total(rs, (r) => r.m8_cost_usd))}.`);
  }
  const disagree = e.runs.filter((r) => r.m6_reached !== null && r.m6_judge_uncaught !== null && r.m6_reached !== r.m6_judge_uncaught);
  L.push(`- M6, the judge's uncaught incidents against the grader's reached count (the grader decides): ${disagree.length ? disagree.map((r) => `${r.run_id} judge ${r.m6_judge_uncaught}, grader ${r.m6_reached}`).join('; ') : 'they agree in every run'}. Disagreements are for the spot check.`);
  for (const n of e.notes) L.push(`- ${n}`);
  L.push('');

  L.push('## Void runs', '');
  if (!e.void.length) L.push('None.');
  else {
    L.push('| Run | Scenario | Arm | Phrasing | Reason |', '|---|---|---|---|---|');
    for (const v of e.void) L.push(`| ${v.run_id} | ${v.scenario} | ${v.arm} | ${v.phrasing} | ${v.reason.replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  L.push('## Missing and skipped', '');
  if (!e.missing.length && !e.skipped.length && !e.errors.length) L.push('Nothing: every scored run has its grade, judge result and diffs.');
  for (const m of e.missing) L.push(`- ${m.run_id} (${m.scenario}, ${m.arm}): no ${m.what.join(', no ')}`);
  for (const s of e.skipped) L.push(`- skipped \`${s.dir}\`: ${s.reason}`);
  for (const x of e.errors) L.push(`- unreadable: ${x}`);
  L.push('');
  L.push('## Judge', '');
  L.push(`${e.judge.runs} run${e.judge.runs === 1 ? '' : 's'} judged by ${e.judge.models.join(', ') || 'no judge yet'}, for ${usd(e.judge.cost_usd)} in all. The spot check (at least 20% of runs, §9) and notable transcripts are added by the owners.`);
  return `${L.join('\n')}\n`;
}

async function main(): Promise<void> {
  const USAGE = 'usage: node scripts/ab/score.ts --records <dir> --grades <grades.json> --security <security.json> [--out <file>] [--json]';
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      strict: true, allowPositionals: false,
      options: { records: { type: 'string' }, grades: { type: 'string' }, security: { type: 'string' }, out: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (values.help) { console.log(USAGE); process.exit(0); }
  const [records, gradesFile, securityFile] = [values.records, values.grades, values.security] as (string | undefined)[];
  if (!records || !gradesFile || !securityFile) { console.error(USAGE); process.exit(2); }
  let e: Evaluation;
  try {
    const grades = checkGrades(JSON.parse(fs.readFileSync(gradesFile, 'utf8')), gradesFile);
    const security = checkSecurity(JSON.parse(fs.readFileSync(securityFile, 'utf8')), securityFile);
    e = evaluate(loadRecords(records), grades, security);
  } catch (err) {
    console.error(`score: ${(err as Error).message}`);
    process.exit(2);
  }
  const text = values.json ? `${JSON.stringify(e, null, 2)}\n` : renderReport(e, records);
  if (typeof values.out === 'string') {
    fs.writeFileSync(values.out, text);
    console.log(`${e.outcome}${e.complete ? '' : ' (provisional, incomplete)'}: wrote ${values.out}`);
  } else process.stdout.write(text);
}

if (import.meta.main) await main();
