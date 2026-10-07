// A run's measurements in the shape both arms share (scripts/ab/summary.ts; validation.md §4, §9; B9b,
// D-121), plus what the judge needs beside them: each task's diff from the base, main's, and the agents'
// transcripts. The harness arm's come from its event log; the baseline's from the runner's timeline, Git and
// the transcripts (baseline-arm.ts). Git-derived figures (M4) are taken the same way in both.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectView, RunMetrics } from '../../packages/daemon/src/index.ts';
import { commitAll } from '../../packages/daemon/src/git.ts';
import type { RunSummary } from './summary.ts';
import { transcriptFiles } from './transcripts.ts';

/**
 * The planted dependency change of each coupled scenario (D-120; validation.md §9): made by task 1, it
 * affects task 2, in these files (a trailing slash is a directory). SC-4's trap is duplication, which P2
 * measures, and SC-0 has no coupling, so P1 looks at neither.
 */
export const PLANTED: Record<string, { upstream: string; affected: string; paths: string[] } | null> = {
  'SC-0': null,
  'SC-1': { upstream: 'T1', affected: 'T2', paths: ['src/shared/types.ts', 'src/server/routes.ts', 'src/server/auth.ts'] },
  'SC-2': { upstream: 'T1', affected: 'T2', paths: ['src/shared/types.ts', 'src/server/routes.ts', 'src/server/repos/books.ts'] },
  'SC-3': { upstream: 'T1', affected: 'T2', paths: ['src/server/migrations/', 'src/server/repos/loans.ts', 'src/shared/types.ts'] },
  'SC-4': null,
};

const gitOut = (repo: string, ...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

/** M4's commit count: main's commits after the first integration, less the other tasks' own integrations. */
export function commitsAfterFirst(repo: string, baseSha: string, mainSha: string, integrated: number): number {
  const n = gitOut(repo, 'rev-list', '--first-parent', '--count', `${baseSha}..${mainSha}`).trim();
  return Math.max(0, Number(n) - Math.max(integrated, 1));
}

/**
 * A task's last commit before it first merged main in (harnessd's sync, the baseline's `sync`): what it had
 * done before it could see the other task's work. Its branch's own commits are on the first-parent line;
 * a sync is a merge commit there, so this is the first such merge's first parent, or the final commit.
 */
export function independentTip(repo: string, baseSha: string, commit: string): string {
  for (const line of gitOut(repo, 'rev-list', '--first-parent', '--reverse', '--parents', `${baseSha}..${commit}`).split('\n')) {
    const [, first, second] = line.trim().split(' ');
    if (second) return first!;
  }
  return commit;
}

/**
 * The last main a task merged in (the second parent of the last sync merge on its first-parent line), or the base if
 * it never synced. The diff from there to its final commit is its own work: everything the sync brought in is on
 * both sides, so the other task's work drops out (validation.md §9, M2's judge input).
 */
export function ownBase(repo: string, baseSha: string, commit: string): string {
  for (const line of gitOut(repo, 'rev-list', '--first-parent', '--parents', `${baseSha}..${commit}`).split('\n')) {
    const [, , second] = line.trim().split(' ');
    if (second) return second;
  }
  return baseSha;
}

const DIFF = ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/'];

/**
 * Each task's last commit, for its diffs. harnessd commits a task's work only when the task is done, so the work
 * an unfinished task (capped, stopped, or reopened and not done again) left in its worktree is committed first,
 * as the baseline runner does with its agents' leftovers. The branch's tip then also holds the task's sync merges.
 * A task whose branch is gone (landed, and deleted) keeps its last committed work; one never started has none.
 */
export async function finalCommits(
  repo: string, tasks: { key: string; branch: string | null; worktree: string | null; committed: string | null }[], author: { name: string; email: string },
): Promise<{ key: string; commit: string | null }[]> {
  const out: { key: string; commit: string | null }[] = [];
  for (const t of tasks) {
    // Fails only with a merge left unresolved in the worktree, which is never committed as the agent's work.
    if (t.worktree && fs.existsSync(t.worktree)) await commitAll(t.worktree, `Left at the end of the run\n\nAB-Task: ${t.key}`, author).catch(() => null);
    let tip: string | null = null;
    if (t.branch) {
      try { tip = gitOut(repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${t.branch}^{commit}`).trim() || null; } catch { tip = null; }
    }
    out.push({ key: t.key, commit: tip ?? t.committed });
  }
  return out;
}

/**
 * The patches the judge and the scorer read (scripts/ab/summary.ts): for each task, diffs/<task>.patch, its own
 * work, from the last main it merged in (`ownBase`) to its final commit, and diffs/<task>.independent.patch, from
 * the base to its last commit before a sync (both -U0; M3's overlapping hunks compare the latter), and
 * diffs/main.patch for main as the run ended. A task with no commit gets empty patches.
 */
export function writeDiffs(dir: string, repo: string, baseSha: string, mainSha: string, tasks: { key: string; commit: string | null }[]): void {
  const out = path.join(dir, 'diffs');
  fs.mkdirSync(out, { recursive: true });
  for (const t of tasks) {
    fs.writeFileSync(path.join(out, `${t.key}.patch`), t.commit ? gitOut(repo, ...DIFF, '-U0', ownBase(repo, baseSha, t.commit), t.commit) : '');
    fs.writeFileSync(path.join(out, `${t.key}.independent.patch`), t.commit ? gitOut(repo, ...DIFF, '-U0', baseSha, independentTip(repo, baseSha, t.commit)) : '');
  }
  fs.writeFileSync(path.join(out, 'main.patch'), gitOut(repo, ...DIFF, baseSha, mainSha));
}

/** Copies each agent's transcripts, concatenated oldest first, to transcripts/<agent>.jsonl. */
export function copyTranscripts(dir: string, agents: { name: string; configDir: string }[]): void {
  const out = path.join(dir, 'transcripts');
  fs.mkdirSync(out, { recursive: true });
  for (const a of agents) {
    const text = transcriptFiles(a.configDir).map((f) => fs.readFileSync(f, 'utf8').replace(/\n?$/, '\n')).join('');
    fs.writeFileSync(path.join(out, `${a.name.replace(/^agent\//, '')}.jsonl`), text);
  }
}

const hits = (paths: string[], p: string) => paths.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const data = (e: { data: unknown }) => e.data as Record<string, unknown>;

/**
 * P1's first half for a harness run (validation.md §9): was the affected agent told of task 1's planted change
 * before its task was first done? That's a `dependency_changed` notice from task 1's writes, or a message from
 * task 1's agent, naming a planted file and delivered after task 1 first edited one. A `claim_conflict` (harnessd
 * on the scopes, whatever task 1 did) and a sync on its own (code merged, nothing said) don't count.
 */
export function surfaced(view: ProjectView, scenario: string, ids: Map<string, string>): RunSummary['surfaced'] {
  const p = PLANTED[scenario];
  if (!p) return null;
  const task = ids.get(p.affected);
  const upstream = ids.get(p.upstream);
  if (!task || !upstream) return { planted: 1, surfaced: 0 };
  const firstEdit = view.events.find((e) => e.kind === 'claim.observed' && data(e).task_id === upstream && strings(data(e).paths).some((x) => hits(p.paths, x)));
  if (!firstEdit) return { planted: 1, surfaced: 0 };
  const done = view.events.find((e) => e.kind === 'task.completed' && data(e).task_id === task);
  const inWindow = (at: string | undefined) => !!at && Date.parse(at) >= Date.parse(firstEdit.at) && (!done || Date.parse(at) <= Date.parse(done.at));
  const told = [...view.messages.values()].some((m) => m.toTask === task && inWindow(m.deliveredAt)
    && ((m.kind === 'dependency_changed' && m.data.writer_task === upstream) || (m.fromTask === upstream && m.kind !== 'claim_conflict'))
    && [...strings(m.data.paths), ...strings(m.data.about_paths), ...strings([m.data.path])].some((x) => hits(p.paths, x)));
  return { planted: 1, surfaced: told ? 1 : 0 };
}

/** M3's conflicts (validation.md §9): each task's first textual conflict with the other's integrated work, at a sync or at an integration. */
export function conflictedTasks(view: ProjectView, taskIds: string[]): number {
  return new Set(view.events
    .filter((e) => (e.kind === 'worktree.sync_conflict' || (e.kind === 'land.failed' && data(e).reason === 'conflict')) && taskIds.includes(String(data(e).task_id)))
    .map((e) => String(data(e).task_id))).size;
}

/**
 * D-124: in SC-1 to SC-3 a change can span both tasks, so neither can pass a test-gated integration alone. When
 * the first task to be integrated fails its tests at its first attempt, it's integrated again at once with tests
 * skipped. Both arms' auto coordinators ask this; the coordinator's playbook says the same (validation.md §9).
 */
export function untestedRetry(scenario: string, o: { anyIntegrated: boolean; attempts: number; testsFailed: boolean }): boolean {
  return !!PLANTED[scenario] && !o.anyIntegrated && o.attempts === 1 && o.testsFailed;
}

/** One integration attempt (a land, or the baseline's `merge`): its task's key, how it ended, when, and what it merged. */
export type IntegrationAttempt = {
  task: string; outcome: 'merged' | 'tests_failed' | 'conflict' | 'other'; start: number; end: number; base: string | null; head: string | null;
};

/**
 * M6 "reached" at integration (validation.md §9): the base and head of the first integration attempt, of either
 * task, whose merge held both tasks' work (the other task was already integrated) and was clean but failed its
 * tests. Null otherwise, and for a conflict, which leaves no merge result to grade.
 */
export function firstAttempt(scenario: string, attempts: IntegrationAttempt[]): { base: string; head: string } | null {
  if (!PLANTED[scenario]) return null;
  const sorted = [...attempts].sort((x, y) => x.start - y.start);
  const a = sorted.find((x) => x.outcome === 'tests_failed' && x.base && x.head && sorted.some((y) => y.task !== x.task && y.outcome === 'merged' && y.end <= x.start));
  return a ? { base: a.base!, head: a.head! } : null;
}

/** The harness arm's integration attempts: each accepted land of a card's task, in order, with how it ended. */
export function harnessAttempts(view: ProjectView, ids: Map<string, string>): IntegrationAttempt[] {
  const keyOf = new Map([...ids].map(([key, id]) => [id, key]));
  const out: IntegrationAttempt[] = [];
  for (const e of view.events) {
    const key = e.kind === 'land.accepted' ? keyOf.get(String(data(e).task_id)) : undefined;
    if (!key) continue;
    const end = view.events.find((x) => (x.kind === 'land.completed' || x.kind === 'land.failed') && data(x).land_id === data(e).land_id);
    const reason = end?.kind === 'land.failed' ? data(end).reason : null;
    out.push({
      task: key, start: e.seq, end: end?.seq ?? Number.POSITIVE_INFINITY, base: String(data(e).base_sha), head: String(data(e).head_sha),
      outcome: end?.kind === 'land.completed' ? 'merged' : reason === 'tests' ? 'tests_failed' : reason === 'conflict' ? 'conflict' : 'other',
    });
  }
  return out;
}

/**
 * True when a failed `git merge-tree --write-tree` was a conflict: it exits 1 and still prints the merged tree's id
 * first. It also exits 1 for a commit it can't merge, printing nothing, which must not pass for a conflict.
 */
export function mergeTreeConflicted(e: unknown): boolean {
  const err = e as { status?: number; stdout?: string | Buffer };
  return err.status === 1 && /^[0-9a-f]{40,64}$/.test(String(err.stdout ?? '').split('\n')[0]!.trim());
}

/**
 * What an integration of `head` into `base` tested, as a tree: the same merge harnessd's land and the baseline's
 * `merge` make (ort), without a worktree. Null if they conflict; any other failure (an unknown commit, a Git
 * without `--write-tree`) throws, so a missing tree is never mistaken for a conflict.
 */
export function mergeTree(repo: string, base: string, head: string): string | null {
  try {
    return gitOut(repo, 'merge-tree', '--write-tree', '--no-messages', base, head).split('\n')[0]!.trim();
  } catch (e) {
    if (mergeTreeConflicted(e)) return null;
    throw e;
  }
}


/** A task's first completion, `done_at` (D-125): its first `task.completed`. A reopened task is done again later; the first counts. */
export function firstCompletion(view: ProjectView, taskId: string): string | null {
  return view.events.find((e) => e.kind === 'task.completed' && data(e).task_id === taskId)?.at ?? null;
}

/** The harness arm's summary, from its event log, `harness metrics` and Git. */
export function harnessSummary(o: {
  runId: string; scenario: string; phrasing: number; outcome: RunSummary['outcome']; capMs: number; startedAt: string; endedAt: string;
  view: ProjectView; metrics: RunMetrics; ids: Map<string, string>; runnerCancels: number; m10Ms: number; repo: string; baseSha: string; mainSha: string;
  tasks: { key: string; agent: string }[];
}): RunSummary {
  const ev = o.view.events;
  const taskIds = [...o.ids.values()];
  // M1 starts when both agents have started work, after their worktrees and setup, as the baseline's clock does
  // (validation.md §9). The assignment is the fallback if a session never started.
  const sessionStarts = taskIds.map((id) => ev.find((e) => e.kind === 'session.started' && data(e).task_id === id)).filter((e) => e !== undefined).map((e) => Date.parse(e.at));
  const assigned = ev.filter((e) => e.kind === 'task.assigned' && taskIds.includes(String(data(e).task_id))).map((e) => Date.parse(e.at));
  const start = sessionStarts.length === taskIds.length ? Math.max(...sessionStarts) : assigned.length ? Math.min(...assigned) : Date.parse(o.startedAt);
  const landedAt = new Map<string, number>();
  for (const e of ev) if (e.kind === 'land.completed' && !landedAt.has(String(data(e).task_id))) landedAt.set(String(data(e).task_id), Date.parse(e.at));
  const all = taskIds.every((id) => landedAt.has(id));
  const times = [...landedAt.values()].sort((a, b) => a - b);
  // M9a: each task's first land that got as far as its tests, and failed there.
  let m9a = 0;
  for (const id of taskIds) {
    const lands = [...o.view.lands.values()].filter((l) => l.taskId === id && (l.status === 'completed' || (l.status === 'failed' && l.reason !== 'cancelled' && l.reason !== 'conflict')));
    if (lands[0]?.status === 'failed' && lands[0].reason === 'tests') m9a++;
  }
  const m7: Record<string, number> = {};
  for (const m of o.view.messages.values()) if (m.from !== 'harness') m7[m.kind] = (m7[m.kind] ?? 0) + 1;
  const t = o.metrics.tokens;
  return {
    v: 1, run_id: o.runId, arm: 'harness', scenario: o.scenario, phrasing: o.phrasing, outcome: o.outcome, void: null,
    models: t.configured, cap_ms: o.capMs, started_at: o.startedAt, ended_at: o.endedAt,
    m1_ms: all ? times.at(-1)! - start : null,
    m3_conflicts: conflictedTasks(o.view, taskIds),
    sync_conflicts: o.metrics.lands.syncConflicts,
    m4: { commits_after_first: commitsAfterFirst(o.repo, o.baseSha, o.mainSha, landedAt.size), ms_to_green: all && times.length ? times.at(-1)! - times[0]! : null },
    m5: o.metrics.interventions.total,
    m5b: o.metrics.deniedToolCalls,
    m5c: Math.max(0, o.metrics.integrationActions.total - o.runnerCancels),
    m7, m8: { input: t.input, output: t.output, cache_read: t.cacheRead, cache_creation: t.cacheCreation, cost_usd: t.costUsd },
    m9a, m10_ms: o.m10Ms, surfaced: surfaced(o.view, o.scenario, o.ids), base_sha: o.baseSha, main_sha: o.mainSha,
    tasks: o.tasks.map((x) => {
      const id = o.ids.get(x.key)!;
      return { key: x.key, agent: x.agent, branch: `harness/task/${id}`, done_at: firstCompletion(o.view, id), integrated_at: landedAt.has(id) ? new Date(landedAt.get(id)!).toISOString() : null };
    }),
  };
}
