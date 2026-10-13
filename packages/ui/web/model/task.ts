// One task's model (D-117): everything about it, and the actions its state allows. Pure: no DOM, no fetch, no clock.
// Every string from the snapshot or a message is untrusted; this module only builds plain words and route strings.
import type { DerivedTaskState, ProjectSnapshot, TaskSnapshot } from '@harness/protocol';
import { stateWords } from './board.ts';
import { shortSha } from './format.ts';

const NONE = 'None yet';

export type TaskModel = {
  id: string;
  title: string;
  state: DerivedTaskState;
  words: string;
  detail: string | null;
  owner: string;
  agent: { id: string; name: string; human: string; device: string | null; online: boolean | null } | null;
  text: string;
  scope: string[];
  changing: string[];
  overlaps: string[];
  stale: string[];
  notices: { id: string; kind: string; from: string; sentAt: string; text: string; delivery: string }[];
  wait: string | null;
  session: { status: string; model: string | null; endReason: string | null; costUsd: number; input: number; output: number } | null;
  tests: string[];
  pr: { number: number; state: string; merged: boolean; head: string } | null;
  costUsd: number;
  taskSha256: string;
};

/** "until HH:MM UTC" from an ISO string; the raw string stands if it isn't a time (no locale, UTC only). */
function utcTime(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** The overlap wording: observed edits read "also changes", declared scope reads "scope overlaps". */
function overlap(a: TaskSnapshot['overlaps'][number]): string {
  const paths = a.paths.join(', ');
  return a.level === 'observed' ? `${a.task_id} also changes ${paths}` : `${a.task_id}'s scope overlaps ${paths}`;
}

/** How a message's recipient took it, in plain words (delivered_at wins over held). */
function delivery(m: { delivered_at: string | null; held: boolean }): string {
  if (m.delivered_at !== null) return 'delivered';
  if (m.held) return 'held for your review';
  return 'not delivered yet';
}

/** Every message to or from this task or its agent, oldest first. */
function notices(snap: ProjectSnapshot, t: TaskSnapshot): TaskModel['notices'] {
  const mine = new Set<string>([t.id]);
  if (t.assignee_agent_id !== null) mine.add(t.assignee_agent_id);
  return snap.messages
    .filter((m) => mine.has(m.from) || (m.to !== null && mine.has(m.to)) || (m.from_task !== null && mine.has(m.from_task)) || (m.to_task !== null && mine.has(m.to_task)))
    .map((m) => ({ id: m.id, kind: m.kind, from: m.from, sentAt: m.sent_at, text: m.text, delivery: delivery(m) }))
    .sort((a, b) => (a.sentAt < b.sentAt ? -1 : a.sentAt > b.sentAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** "waiting for <on.kind> <on.id> until HH:MM UTC" from the open wait's timeout. */
function waitWords(t: TaskSnapshot): string | null {
  const w = t.open_wait;
  if (w === null) return null;
  return `waiting for ${w.on.kind} ${w.on.id} until ${utcTime(w.timeout_at)} UTC`;
}

/** The land's own line, from its status and step. */
function landLine(t: TaskSnapshot): string | null {
  const l = t.land;
  if (l === null) return null;
  switch (l.status) {
    case 'completed':
      return l.new_base_sha !== null ? `landed as ${shortSha(l.new_base_sha)}` : 'landed';
    case 'failed':
      return `the land failed (${l.reason ?? 'error'}): ${l.detail ?? 'no detail'}`;
    case 'requested':
    case 'accepted':
      return `integrating: ${l.step ?? 'in progress'}`;
    default:
      return null;
  }
}

/** What the tests and PR section shows: the land, then each PR check. */
function tests(t: TaskSnapshot): string[] {
  const out: string[] = [];
  const land = landLine(t);
  if (land !== null) out.push(land);
  if (t.pr !== null) for (const [name, conclusion] of Object.entries(t.pr.checks)) out.push(`${name}: ${conclusion}`);
  return out;
}

/** Everything about one task, or null when the project has no such task. */
export function taskModel(snap: ProjectSnapshot, id: string): TaskModel | null {
  const t = snap.tasks.find((x) => x.id === id);
  if (t === undefined) return null;
  const agent = t.assignee_agent_id !== null ? snap.agents.find((a) => a.id === t.assignee_agent_id) ?? null : null;
  return {
    id: t.id,
    title: t.title,
    state: t.state,
    words: stateWords(t.state),
    detail: t.state_detail,
    owner: t.owner_human_id,
    agent: agent === null ? null : { id: agent.id, name: agent.name, human: agent.human_id, device: agent.device_id, online: agent.online },
    text: t.text,
    scope: [...t.scope],
    changing: [...t.changing],
    overlaps: t.overlaps.map(overlap),
    stale: t.stale_reads.map((path) => `${path} changed after its agent read it`),
    notices: notices(snap, t),
    wait: waitWords(t),
    session: t.session === null ? null : {
      status: t.session.status, model: t.session.model, endReason: t.session.end_reason,
      costUsd: t.session.cost_usd, input: t.session.input_tokens, output: t.session.output_tokens,
    },
    tests: tests(t),
    pr: t.pr === null ? null : { number: t.pr.number, state: t.pr.state, merged: t.pr.merged, head: t.pr.head_sha },
    costUsd: t.cost_usd,
    taskSha256: t.task_sha256,
  };
}

export type TaskAction = { kind: 'start' | 'resume' | 'reopen' | 'abandon' | 'complete' | 'unblock'; label: string; needs: 'agent' | 'text' | 'reason' | 'summary' | null; optional: boolean };

/** The abort is offered in every state but the ones it no longer means anything in. */
const NO_ABANDON: DerivedTaskState[] = ['open', 'landed', 'abandoned', 'publishing', 'integrating', 'outcome_unknown'];

export function actionsFor(snap: ProjectSnapshot, id: string, offline: boolean): TaskAction[] {
  if (offline) return [];
  const t = snap.tasks.find((x) => x.id === id);
  if (t === undefined) return [];
  const agent = t.assignee_agent_id !== null ? snap.agents.find((a) => a.id === t.assignee_agent_id) ?? null : null;
  if (t.owner_human_id !== snap.principal && (agent?.human_id ?? null) !== snap.principal) return [];

  const out: TaskAction[] = [];
  switch (t.state) {
    case 'open': out.push({ kind: 'start', label: 'Assign', needs: 'agent', optional: false }); break;
    case 'stopped': out.push({ kind: 'resume', label: 'Resume', needs: 'text', optional: true }); break;
    case 'blocked': out.push({ kind: 'unblock', label: "Unblock: after you've fixed the conflict in its worktree", needs: null, optional: false }); break;
    case 'done':
    case 'pr_open':
    case 'publish_blocked': out.push({ kind: 'reopen', label: 'Reopen', needs: 'text', optional: false }); break;
    case 'starting':
    case 'running': out.push({ kind: 'complete', label: 'Mark done', needs: 'summary', optional: true }); break;
    default: break;
  }
  if (!NO_ABANDON.includes(t.state)) out.push({ kind: 'abandon', label: 'Abandon', needs: 'reason', optional: false });
  return out;
}
