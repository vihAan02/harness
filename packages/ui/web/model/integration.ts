// The integration page's model (D-114, D-115, D-116): every task's PR, its checks and reviews, the one integration at a
// time, merges made outside the harness, security alerts, and this Mac's spend and provider circuit. Pure: no DOM, no
// fetch, no clock. Every string from the snapshot is untrusted; this module only turns it into plain words and route
// strings, and the one link it builds is checked before it is offered.
import type { ProjectSnapshot, TaskSnapshot } from '@harness/protocol';
import { stateWords } from './board.ts';
import { shortSha } from './format.ts';

/** The checks that must all pass before a GitHub integration may be offered (D-115). */
export const REQUIRED = ['guard', 'unit-linux', 'full-macos'];

/** The checks that gate a land, in their fixed order. */
const REQUIRED_SET = new Set(REQUIRED);

/**
 * The GitHub URL of PR `n` in `repo`, or null when either can't make a safe link. `repo` is the snapshot's own config
 * value, never a URL from the server: only `owner/name` of safe characters is accepted, and `n` must be a positive
 * integer, so a hostile repo or number can never become a `javascript:` link.
 */
export function prUrl(repo: string | null, n: number): string | null {
  if (repo === null) return null;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return `https://github.com/${repo}/pull/${n}`;
}

/** One PR check's words: a tick, a cross, an ellipsis while it runs, else the raw conclusion as text. */
function checkWords(conclusion: string): string {
  switch (conclusion) {
    case 'success': return '✓ passed';
    case 'failure': return '✗ failed';
    case 'pending': return '… running';
    default: return conclusion;
  }
}

export type IntegrationRow = {
  task: string;
  title: string;
  words: string;
  pr: { number: number; url: string | null; state: string; merged: boolean; mergeable: string | null } | null;
  checks: { name: string; conclusion: string; words: string }[];
  reviews: { login: string; state: string; current: boolean }[];
  land: string | null;
  integrate: { allowed: boolean; why: string | null };
  expected: { pr_number: number; head_sha: string; base_sha: string } | null;
};

export type IntegrationModel = {
  mode: 'local' | 'github';
  rows: IntegrationRow[];
  inFlight: { task: string; words: string; since: string; step: string } | null;
  outside: { at: string; range: string; paths: string[] }[];
  alerts: { at: string; what: string; task: string | null; detail: string | null }[];
};

/** The land's own line: its mode, status, step, reason and detail, in words. */
function landLine(l: TaskSnapshot['land']): string | null {
  if (l === null) return null;
  const bits: string[] = [`${l.mode} land: ${l.status}`];
  if (l.step !== null) bits.push(l.step);
  if (l.reason !== null) bits.push(l.reason);
  if (l.detail !== null) bits.push(l.detail);
  if (l.new_base_sha !== null) bits.push(`base ${shortSha(l.new_base_sha)}`);
  return bits.join(' · ');
}

/** The checks in their show order: the required ones first (by REQUIRED's order), then the rest by name. */
function orderedChecks(checks: Record<string, string>): IntegrationRow['checks'] {
  const names = Object.keys(checks);
  const required = REQUIRED.filter((name) => names.includes(name));
  const rest = names.filter((name) => !REQUIRED_SET.has(name)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return [...required, ...rest].map((name) => ({ name, conclusion: checks[name] ?? '', words: checkWords(checks[name] ?? '') }));
}

/** The latest review per login, oldest-seen first in the PR's own order; `current` when it is on the PR's head. */
function reviewsOf(pr: NonNullable<TaskSnapshot['pr']>): IntegrationRow['reviews'] {
  const latest = new Map<string, { login: string; state: string; commit_id: string }>();
  for (const r of pr.reviews) latest.set(r.login, r); // a later review by the same login wins
  return [...latest.values()].map((r) => ({ login: r.login, state: r.state, current: r.commit_id === pr.head_sha }));
}

/** Whether one land in the snapshot is still in flight (requested or accepted). */
function inFlightLand(snap: ProjectSnapshot): NonNullable<TaskSnapshot['land']> | null {
  for (const l of snap.lands) if (l.status === 'requested' || l.status === 'accepted') return l;
  return null;
}

/** The first integrate precondition that fails, or null when every one holds. Order is the order it is shown. */
function whyNot(snap: ProjectSnapshot, t: TaskSnapshot, offline: boolean): string | null {
  // A task with no agent has no accountable human: say so rather than naming the same unknown twice.
  const human = agentHuman(snap, t);
  if (human === null) return 'it has no agent';
  if (snap.principal !== human) return `only ${human}, the agent's human, can integrate`;
  const pr = t.pr;
  if (pr === null || pr.state !== 'open') return "the PR isn't open";
  const missing = REQUIRED.filter((name) => (pr.checks[name] ?? '') !== 'success');
  if (missing.length > 0) return `required checks haven't all passed: ${missing.join(', ')}`;
  const fly = inFlightLand(snap);
  if (fly !== null) return `${fly.task_id} is integrating now`;
  if (offline) return 'actions wait while the banner shows';
  if (t.state !== 'pr_open') return "it isn't waiting for integration";
  return null;
}

/** The accountable human of a task's agent, or null when it has none. */
function agentHuman(snap: ProjectSnapshot, t: TaskSnapshot): string | null {
  if (t.assignee_agent_id === null) return null;
  return snap.agents.find((a) => a.id === t.assignee_agent_id)?.human_id ?? null;
}

/**
 * The integration page's data: one row per task with a PR or a land (newest first by when its PR was last updated),
 * the one integration in flight, the base moves made outside the harness, and the security alerts.
 */
export function integrationModel(snap: ProjectSnapshot, offline: boolean): IntegrationModel {
  const withPrOrLand = snap.tasks.filter((t) => t.pr !== null || t.land !== null);
  // Newest first: by the PR's updated_at, else the land's requested_at; a task with neither sorts last.
  const at = (t: TaskSnapshot): string => t.pr?.updated_at ?? t.land?.requested_at ?? '';
  const ordered = [...withPrOrLand].sort((a, b) => {
    const x = at(a);
    const y = at(b);
    if (x !== y) return x < y ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const rows: IntegrationRow[] = ordered.map((t) => {
    const pr = t.pr;
    const why = whyNot(snap, t, offline);
    return {
      task: t.id,
      title: t.title,
      words: stateWords(t.state),
      pr: pr === null ? null : {
        number: pr.number,
        url: prUrl(snap.repo.github_repo, pr.number),
        state: pr.state,
        merged: pr.merged,
        mergeable: pr.mergeable_state,
      },
      checks: pr === null ? [] : orderedChecks(pr.checks),
      reviews: pr === null ? [] : reviewsOf(pr),
      land: landLine(t.land),
      integrate: { allowed: pr !== null && why === null, why },
      expected: pr === null ? null : { pr_number: pr.number, head_sha: pr.head_sha, base_sha: pr.base_sha },
    };
  });

  const land = inFlightLand(snap);
  const inFlight = land === null ? null : {
    task: land.task_id,
    since: land.requested_at,
    step: land.step ?? 'requested',
    words: snap.tasks.find((t) => t.id === land.task_id)?.state === 'outcome_unknown'
      ? "GitHub's answer to the merge was lost; harnessd is reconciling from GitHub. Don't merge or close the PR by hand."
      : `integrating ${land.task_id}: ${land.step ?? 'requested'}`,
  };

  const outside = [...snap.base_advances]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .map((b) => ({ at: b.at, range: `${shortSha(b.old_sha)} → ${shortSha(b.new_sha)}`, paths: [...b.changed_paths] }));

  const alerts = [...snap.alerts]
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
    .map((a) => ({ at: a.at, what: a.what, task: a.task_id, detail: a.detail }));

  return { mode: snap.integration_mode, rows, inFlight, outside, alerts };
}

export type BudgetModel = {
  spent: number;
  daily: number | null;
  cap: number | null;
  level: 'none' | 'ok' | 'warn' | 'over';
  words: string[];
  tasks: { task: string; costUsd: number; reported: boolean }[];
  circuit: { kind: string; reason: string; at: string; resettable: boolean } | null;
};

/**
 * This Mac's spend and provider state (D-116): the day's spend against the daily budget and session cap, each task's
 * cost, and the provider circuit. A session still running reports no cost (0) and reads "not reported yet".
 */
export function budgetModel(snap: ProjectSnapshot): BudgetModel {
  const { day, spent_usd: spent, daily_budget_usd: daily, session_cap_usd: cap } = snap.budget;

  let level: BudgetModel['level'];
  if (daily === null) level = 'none';
  else if (daily > 0 && spent >= daily) level = 'over';
  else if (daily > 0 && spent / daily >= 0.8) level = 'warn';
  else level = 'ok';

  const words: string[] = [];
  if (daily !== null) {
    words.push(`$${spent.toFixed(3)} of $${daily.toFixed(3)} spent today (UTC ${day})`);
    if (level === 'over') words.push("New sessions won't start today");
    else if (cap !== null && daily - spent < cap) words.push('One more session may not fit');
  } else {
    words.push('No daily budget set');
  }

  // Each task with a session, by its own cost (all its sessions), most expensive first. A task is unreported only while
  // its live session has reported nothing and the task total is still 0: an earlier session's cost is real money.
  const tasks = snap.tasks
    .filter((t) => t.session !== null)
    .map((t) => ({
      task: t.id,
      costUsd: t.cost_usd,
      reported: !(t.cost_usd === 0 && t.session !== null && t.session.ended_at === null),
    }))
    .sort((a, b) => (a.costUsd === b.costUsd ? (a.task < b.task ? -1 : a.task > b.task ? 1 : 0) : b.costUsd - a.costUsd));

  const c = snap.provider.circuit;
  const circuit = c === null ? null : { kind: c.kind, reason: c.reason, at: c.at, resettable: c.kind !== 'budget' };
  if (circuit !== null) words.push(`No agent starts on this Mac: ${circuit.kind}: ${circuit.reason}`);

  return { spent, daily, cap, level, words, tasks, circuit };
}
