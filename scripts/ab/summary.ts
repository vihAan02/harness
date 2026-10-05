// What a counted run leaves for scoring, the same in both arms (validation.md §4, §9; D-121). The runner
// (B9a, B9b) writes these into runs/record/<run-id>/; the judge and the scorer (A9) read them. The grader's
// side, grades.json, comes back separately and is joined by run id.
//
//   record/<run-id>/summary.json         RunSummary
//   record/<run-id>/diffs/<task>.patch   `git diff -U0 <base> <task's final commit>`: what the task did in the end (the judge)
//   record/<run-id>/diffs/<task>.independent.patch
//                                        the same, at its last commit before it first merged main in (a sync): what
//                                        it changed before it could see the other task's work. M3's overlapping
//                                        hunks compare these, so an edit made on top of the other's synced-in change
//                                        isn't counted as a collision (validation.md §9)
//   record/<run-id>/diffs/main.patch     `git diff <base> <main as the run ended>`: the judge's view of the result
//   All patches: `git diff --no-color --no-ext-diff --src-prefix=a/ --dst-prefix=b/`, task patches with -U0.
//   record/<run-id>/transcripts/<agent>.jsonl   the agent's Claude Code transcript(s), concatenated: M6, M8
//   record/<run-id>/judge.json           JudgeResult, written by scripts/ab/judge.ts

export type Arm = 'harness' | 'baseline';
export const ARMS: readonly Arm[] = ['harness', 'baseline'];
export const SCENARIOS = ['SC-0', 'SC-1', 'SC-2', 'SC-3', 'SC-4'] as const;
/** The scenarios the primary criteria and G1/G2 compare over (validation.md §5); SC-0 is G3's. */
export const COUPLED = ['SC-1', 'SC-2', 'SC-3', 'SC-4'] as const;

export type RunSummary = {
  v: 1;
  run_id: string;
  arm: Arm;
  scenario: string;
  phrasing: number;
  /** How the run ended: both tasks integrated with tests green, the cap, the coordinator, or a failure. */
  outcome: 'integrated' | 'capped' | 'stopped' | 'abandoned' | 'land_rejected' | 'land_failed' | 'error';
  /** Set when the run is void (validation.md §9): the reason. A void run is never scored. */
  void: string | null;
  /** Every model and provider its sessions ran on, e.g. "deepseek/deepseek-v4.1-flash (openrouter)". */
  models: string[];
  cap_ms: number;
  started_at: string;
  ended_at: string;
  /** M1: from the assignment until both tasks are integrated with tests green; null if that never happened (scored as the cap). */
  m1_ms: number | null;
  /** M3, the integration half: textual conflicts when a task was integrated (lands, or the runner's `merge`). */
  m3_conflicts: number;
  /** A diagnostic, not M3: conflicts when main was merged into a task's branch mid-run (harnessd's sync, the baseline's `sync`). */
  sync_conflicts: number;
  /** M4: commits to main after the first integration, and the time from it until main is green with both tasks. */
  m4: { commits_after_first: number; ms_to_green: number | null };
  /** M5: human interventions (messages and actions to agents after their cards). */
  m5: number;
  /** M5b: tool calls denied by the shared allow list; null where the arm can't see them. */
  m5b: number | null;
  /** M5c: human integration actions (lands, merges, syncs, approvals, cancels). */
  m5c: number;
  /** M7: messages by kind, e.g. { "question": 2, "human_to_agent": 1 }. */
  m7: Record<string, number>;
  /** M8: tokens and their cost, priced from the provider table in both arms. */
  m8: { input: number; output: number; cache_read: number; cache_creation: number; cost_usd: number };
  /** M9a: first integration attempts (one per task) whose tests failed. */
  m9a: number;
  /** M10: the coordinator's timer, both arms the same way. */
  m10_ms: number;
  /** P1's first half, harness arm: planted changes the affected agent was told of before its task was done. Null in the baseline. */
  surfaced: { planted: number; surfaced: number } | null;
  /** The base every diff is taken from, and main as the run ended. */
  base_sha: string;
  main_sha: string;
  tasks: { key: string; agent: string; branch: string; integrated_at: string | null }[];
};

/** What the LLM judge decides for one run (scripts/ab/judge.ts, the prompts in scripts/ab/rubric/). */
export type JudgeResult = {
  v: 1;
  run_id: string;
  judge_model: string;
  /**
   * M2: each functionality implemented more than once, with where. `planted` marks SC-4's planted ISBN helper,
   * whose count the grader decides (Grade.m2_planted); the scorer ignores it in other scenarios.
   */
  m2: { units: { what: string; locations: string[]; extra_copies: number; planted?: boolean }[]; lines_removed_in_integration: number };
  /** M6: stale-context incidents, each caught before its task finished or not. */
  m6: { incidents: { agent: string; coupling: string; evidence: string; caught: boolean }[] };
  cost_usd: number;
};

/** What the grader returns for each run, from the hidden checks (validation.md §9; D-120). */
export type Grade = {
  /** Each hidden check by name. */
  checks: Record<string, 'pass' | 'fail'>;
  /** M9b: hidden checks failing on the final main that are broken contracts. */
  m9b: number;
  /** M6, reached: planted-coupling failures that reached integration. Authoritative over the judge (D-120). */
  m6_reached: number;
  /** M2 for the planted helper (SC-4): extra copies the checks found. Authoritative over the judge for that helper. */
  m2_planted: number;
};
export type Grades = { v: 1; runs: Record<string, Grade> };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonNeg = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
/** A count: a whole number, not negative. */
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;

/** Throws on a summary.json that isn't a RunSummary, naming the first bad field. */
export function checkSummary(v: unknown, where = 'summary.json'): RunSummary {
  const bad = (f: string): never => { throw new Error(`${where}: bad or missing ${f}`); };
  if (!isObj(v) || v.v !== 1) bad('v');
  const s = v as Record<string, unknown>;
  for (const f of ['run_id', 'scenario', 'outcome', 'started_at', 'ended_at', 'base_sha', 'main_sha']) if (typeof s[f] !== 'string') bad(f);
  if (!ARMS.includes(s.arm as Arm)) bad('arm');
  if (!(SCENARIOS as readonly string[]).includes(s.scenario as string)) bad('scenario');
  for (const f of ['cap_ms', 'm10_ms']) if (!nonNeg(s[f])) bad(f);
  for (const f of ['phrasing', 'm3_conflicts', 'sync_conflicts', 'm5', 'm5c', 'm9a']) if (!count(s[f])) bad(f);
  if (s.m1_ms !== null && !nonNeg(s.m1_ms)) bad('m1_ms');
  if (s.m5b !== null && !count(s.m5b)) bad('m5b');
  if (s.void !== null && (typeof s.void !== 'string' || !s.void.trim())) bad('void (null, or the reason)');
  if (!Array.isArray(s.models) || !s.models.every((m) => typeof m === 'string')) bad('models');
  if (!isObj(s.m4) || !count(s.m4.commits_after_first) || (s.m4.ms_to_green !== null && !nonNeg(s.m4.ms_to_green))) bad('m4');
  if (!isObj(s.m7) || !Object.values(s.m7).every(count)) bad('m7');
  const m8 = s.m8 as Record<string, unknown>;
  if (!isObj(m8) || !['input', 'output', 'cache_read', 'cache_creation'].every((k) => count(m8[k])) || !nonNeg(m8.cost_usd)) bad('m8');
  if (s.surfaced !== null && (!isObj(s.surfaced) || !count(s.surfaced.planted) || !count(s.surfaced.surfaced) || (s.surfaced.surfaced as number) > (s.surfaced.planted as number))) bad('surfaced (whole numbers, surfaced ≤ planted)');
  if (!Array.isArray(s.tasks)) bad('tasks');
  return v as RunSummary;
}


/** Throws on M2 and M6 answers that don't match JudgeResult's m2 and m6, naming the first bad field. */
export function checkJudgeParts(v: unknown, where: string, parts: readonly ('m2' | 'm6')[] = ['m2', 'm6']): Pick<JudgeResult, 'm2' | 'm6'> {
  const bad = (f: string): never => { throw new Error(`${where}: bad or missing ${f}`); };
  if (!isObj(v)) bad('object');
  const j = v as Record<string, unknown>;
  if (parts.includes('m2')) {
    if (!isObj(j.m2) || !Array.isArray(j.m2.units) || !count(j.m2.lines_removed_in_integration)) bad('m2');
    for (const [i, u] of ((j.m2 as Record<string, unknown>).units as unknown[]).entries()) {
      if (!isObj(u) || typeof u.what !== 'string' || !Array.isArray(u.locations) || !u.locations.every((l) => typeof l === 'string')
        || !count(u.extra_copies) || (u.planted !== undefined && typeof u.planted !== 'boolean')) bad(`m2.units[${i}]`);
    }
  }
  if (parts.includes('m6')) {
    if (!isObj(j.m6) || !Array.isArray(j.m6.incidents)) bad('m6');
    for (const [i, x] of ((j.m6 as Record<string, unknown>).incidents as unknown[]).entries()) {
      if (!isObj(x) || typeof x.agent !== 'string' || typeof x.coupling !== 'string' || typeof x.evidence !== 'string' || typeof x.caught !== 'boolean') bad(`m6.incidents[${i}]`);
    }
  }
  return v as Pick<JudgeResult, 'm2' | 'm6'>;
}

/** Throws on a judge.json that isn't a JudgeResult. */
export function checkJudge(v: unknown, where = 'judge.json'): JudgeResult {
  checkJudgeParts(v, where);
  const j = v as Record<string, unknown>;
  if (j.v !== 1) throw new Error(`${where}: bad or missing v`);
  for (const f of ['run_id', 'judge_model']) if (typeof j[f] !== 'string') throw new Error(`${where}: bad or missing ${f}`);
  if (!nonNeg(j.cost_usd)) throw new Error(`${where}: bad or missing cost_usd`);
  return v as JudgeResult;
}

/** Throws on a grades.json that isn't Grades, naming the first bad run. */
export function checkGrades(v: unknown, where = 'grades.json'): Grades {
  if (!isObj(v) || v.v !== 1 || !isObj(v.runs)) throw new Error(`${where}: bad or missing v or runs`);
  for (const [id, g] of Object.entries(v.runs)) {
    if (!isObj(g) || !isObj(g.checks) || !Object.values(g.checks).every((c) => c === 'pass' || c === 'fail')
      || !count(g.m9b) || !count(g.m6_reached) || !count(g.m2_planted)) throw new Error(`${where}: bad grade for run ${id}`);
  }
  return v as Grades;
}
