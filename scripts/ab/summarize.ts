// A run's measurements in the shape both arms share (scripts/ab/summary.ts; validation.md §4, §9; B9b,
// D-121), plus what the judge needs beside them: each task's diff from the base, main's, and the agents'
// transcripts. The harness arm's come from its event log; the baseline's from the runner's timeline, Git and
// the transcripts (baseline-arm.ts). Git-derived figures (M4) are taken the same way in both.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectView, RunMetrics } from '../../packages/daemon/src/index.ts';
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
 * Writes diffs/<task>.patch (`-U0`, for M3's overlapping hunks) for each task's final commit, and
 * diffs/main.patch for main as the run ended. A task with no commit gets an empty patch.
 */
export function writeDiffs(dir: string, repo: string, baseSha: string, mainSha: string, tasks: { key: string; commit: string | null }[]): void {
  const out = path.join(dir, 'diffs');
  fs.mkdirSync(out, { recursive: true });
  for (const t of tasks) fs.writeFileSync(path.join(out, `${t.key}.patch`), t.commit ? gitOut(repo, 'diff', '-U0', '--no-color', '--no-ext-diff', baseSha, t.commit) : '');
  fs.writeFileSync(path.join(out, 'main.patch'), gitOut(repo, 'diff', '--no-color', '--no-ext-diff', baseSha, mainSha));
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

/**
 * P1's first half for a harness run: was the affected agent told of the planted change before its task was
 * done? A dependency notice, a message about those files, or a sync bringing them in all count.
 */
export function surfaced(view: ProjectView, scenario: string, ids: Map<string, string>): RunSummary['surfaced'] {
  const p = PLANTED[scenario];
  if (!p) return null;
  const task = ids.get(p.affected);
  if (!task) return { planted: 1, surfaced: 0 };
  const done = view.events.find((e) => e.kind === 'task.completed' && (e.data as { task_id?: string }).task_id === task);
  const before = (at: string | null | undefined) => !!at && (!done || Date.parse(at) <= Date.parse(done.at));
  const told = [...view.messages.values()].some((m) => m.toTask === task && before(m.deliveredAt) && m.from !== view.tasks.get(task)?.assignee
    && [...strings(m.data.paths), ...strings(m.data.about_paths)].some((x) => hits(p.paths, x)))
    || view.events.some((e) => e.kind === 'worktree.synced' && (e.data as { task_id?: string }).task_id === task && before(e.at)
      && strings((e.data as { changed_paths?: unknown }).changed_paths).some((x) => hits(p.paths, x)));
  return { planted: 1, surfaced: told ? 1 : 0 };
}

const data = (e: { data: unknown }) => e.data as Record<string, unknown>;

/** The harness arm's summary, from its event log, `harness metrics` and Git. */
export function harnessSummary(o: {
  runId: string; scenario: string; phrasing: number; outcome: RunSummary['outcome']; capMs: number; startedAt: string; endedAt: string;
  view: ProjectView; metrics: RunMetrics; ids: Map<string, string>; runnerCancels: number; m10Ms: number; repo: string; baseSha: string; mainSha: string;
  tasks: { key: string; agent: string }[];
}): RunSummary {
  const ev = o.view.events;
  const taskIds = [...o.ids.values()];
  const assigned = ev.filter((e) => e.kind === 'task.assigned' && taskIds.includes(String(data(e).task_id))).map((e) => Date.parse(e.at));
  const start = assigned.length ? Math.min(...assigned) : Date.parse(o.startedAt);
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
    m3_conflicts: [...o.view.lands.values()].filter((l) => taskIds.includes(l.taskId) && l.status === 'failed' && l.reason === 'conflict').length,
    m4: { commits_after_first: commitsAfterFirst(o.repo, o.baseSha, o.mainSha, landedAt.size), ms_to_green: all && times.length ? times.at(-1)! - times[0]! : null },
    m5: o.metrics.interventions.total,
    m5b: o.metrics.deniedToolCalls,
    m5c: Math.max(0, o.metrics.integrationActions.total - o.runnerCancels),
    m7, m8: { input: t.input, output: t.output, cache_read: t.cacheRead, cache_creation: t.cacheCreation, cost_usd: t.costUsd },
    m9a, m10_ms: o.m10Ms, surfaced: surfaced(o.view, o.scenario, o.ids), base_sha: o.baseSha, main_sha: o.mainSha,
    tasks: o.tasks.map((x) => {
      const id = o.ids.get(x.key)!;
      return { key: x.key, agent: x.agent, branch: `harness/task/${id}`, integrated_at: landedAt.has(id) ? new Date(landedAt.get(id)!).toISOString() : null };
    }),
  };
}
