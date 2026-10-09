// The UI's read model (D-117; protocol.md §12): one project as a JSON-serializable snapshot, with each task's derived
// state. Pure: the project's view, plus what only this device's harnessd knows (its approvals, its publishing, its
// link, its budget). The UI renders it; every string in it that came from a task, an agent, a peer, the server or
// GitHub stays untrusted text.
import type {
  AgentSnapshot, DerivedTaskState, IntegrationMode, LandSnapshot, MessageSnapshot, ProjectSnapshot, SessionSnapshot, SnapshotConnection, TaskSnapshot, WaitSnapshot,
} from '@harness/protocol';
import type { LandInfo, ProjectView, SessionInfo, TaskInfo, WaitInfo } from './view.ts';

/** What only this harnessd knows. */
export type SnapshotLocal = {
  deviceId: string; principal: string; integrationMode: IntegrationMode; connection: SnapshotConnection;
  /** Its pending local approvals (setup, test, publish, and later agent_session), by task. */
  approvals: { taskId: string; kind: string }[];
  /** Tasks it has committed or is pushing, with no PR yet (the journal's committed/pushing, D-114). */
  publishing: Set<string>;
  budget: { dailyBudgetUsd: number | null; sessionCapUsd: number | null };
  now?: number;
};

const MESSAGES = 200;
const IN_FLIGHT = ['requested', 'accepted'];

const lastSession = (v: ProjectView, taskId: string): SessionInfo | undefined => [...v.sessions.values()].filter((x) => x.taskId === taskId).at(-1);
const lastLand = (v: ProjectView, taskId: string): LandInfo | undefined => [...v.lands.values()].filter((l) => l.taskId === taskId).at(-1);
const costOf = (v: ProjectView, sessionId: string) => v.usage.get(sessionId)?.costUsd ?? 0;

/** A task's state as the UI shows it, and why, where there's a reason. Most specific first. */
export function deriveTaskState(v: ProjectView, t: TaskInfo, local: Pick<SnapshotLocal, 'approvals' | 'publishing'>): { state: DerivedTaskState; detail: string | null } {
  if (t.status === 'abandoned') return { state: 'abandoned', detail: null };
  if (t.status === 'landed') return { state: 'landed', detail: null };
  const land = lastLand(v, t.id);
  if (land && IN_FLIGHT.includes(land.status)) {
    return land.step === 'outcome_unknown' ? { state: 'outcome_unknown', detail: `PR #${land.prNumber ?? '?'}: the merge's answer was lost; reconciling from GitHub` } : { state: 'integrating', detail: land.step ?? null };
  }
  const approval = (kinds: string[]) => local.approvals.find((a) => a.taskId === t.id && kinds.includes(a.kind));
  if (t.status === 'done') {
    const pr = v.prs.get(t.id);
    const blocked = v.publishBlocked.get(t.id);
    if (blocked && (!pr || pr.publishedAt < blocked.at)) return { state: 'publish_blocked', detail: blocked.reasons.map((r) => r.rule).join(', ') };
    if (approval(['publish'])) return { state: 'publish_pending_approval', detail: null };
    if (local.publishing.has(t.id)) return { state: 'publishing', detail: null };
    if (pr && pr.state === 'open') {
      const failed = land?.status === 'failed' && land.finishedAt && land.finishedAt > pr.publishedAt ? `the last integration failed: ${land.reason}` : null;
      return { state: 'pr_open', detail: failed };
    }
    return { state: 'done', detail: null };
  }
  if (t.status === 'blocked') return { state: 'blocked', detail: null };
  if (t.status === 'in_progress') {
    const fetch = v.fetchFailed.get(t.id);
    if (fetch) return { state: 'fetch_pending', detail: fetch.reason };
    const session = lastSession(v, t.id);
    if (session && session.status !== 'ended') return { state: session.status === 'starting' ? 'starting' : 'running', detail: null };
    if (approval(['agent_session', 'setup'])) return { state: 'awaiting_approval', detail: null };
    if (session) return { state: 'stopped', detail: session.endReason ?? null };
    return { state: 'starting', detail: null };
  }
  return { state: 'open', detail: null };
}

function session(v: ProjectView, x: SessionInfo): SessionSnapshot {
  const u = v.usage.get(x.id);
  return {
    id: x.id, agent_id: x.agentId, device_id: x.deviceId, status: x.status, started_at: x.startedAt, ended_at: x.endedAt ?? null, end_reason: x.endReason ?? null,
    model: x.model ?? null, cost_usd: u?.costUsd ?? 0, input_tokens: u?.input ?? 0, output_tokens: u?.output ?? 0,
  };
}

function land(l: LandInfo): LandSnapshot {
  return {
    id: l.id, task_id: l.taskId, mode: l.mode, status: l.status, step: l.step ?? null, reason: l.reason ?? null, detail: l.detail ?? null,
    pr_number: l.prNumber ?? null, new_base_sha: l.newBaseSha ?? null, requested_at: l.requestedAt, finished_at: l.finishedAt ?? null,
  };
}

function wait(w: WaitInfo): WaitSnapshot {
  return { id: w.id, task_id: w.taskId, session_id: w.sessionId, on: { ...w.on }, outcome: w.outcome, started_at: w.startedAt, timeout_at: w.timeoutAt, finished_at: w.finishedAt ?? null, reason: w.reason ?? null };
}

export function snapshotOf(v: ProjectView, local: SnapshotLocal): ProjectSnapshot {
  const now = local.now ?? Date.now();
  const day = new Date(now).toISOString().slice(0, 10);
  const tasks = [...v.tasks.values()].map((t): TaskSnapshot => {
    const { state, detail } = deriveTaskState(v, t, local);
    const last = lastSession(v, t.id);
    const pr = v.prs.get(t.id);
    const l = lastLand(v, t.id);
    const ow = v.openWait(t.id);
    return {
      id: t.id, title: t.title, text: t.text, scope: [...t.scope], owner_human_id: t.ownerHumanId, priority: t.priority, assignee_agent_id: t.assignee,
      status: t.status, state, state_detail: detail, summary: t.summary ?? null, created_at: t.createdAt, assigned_at: t.assignedAt ?? null, completed_at: t.completedAt ?? null,
      session: last ? session(v, last) : null,
      pr: pr ? {
        number: pr.prNumber, url: pr.url, head_sha: pr.headSha, base_sha: pr.baseSha, state: pr.state, merged: pr.merged, merge_sha: pr.mergeSha,
        mergeable_state: pr.mergeableState, checks: { ...pr.checks }, reviews: pr.reviews.map((r) => ({ ...r })), updated_at: pr.updatedAt,
      } : null,
      land: l ? land(l) : null,
      publish_blocked: v.publishBlocked.get(t.id)?.reasons.map((r) => ({ ...r })) ?? null,
      stale_reads: [...(v.reads.get(t.id)?.entries() ?? [])].filter(([, r]) => r.stale).map(([p]) => p).sort(),
      leases: v.currentLeases(t.id, now).map((x) => ({ path: x.path, expires_at: x.expiresAt })),
      open_wait: ow ? wait(ow) : null,
      cost_usd: [...v.sessions.values()].filter((x) => x.taskId === t.id).reduce((sum, x) => sum + costOf(v, x.id), 0),
    };
  });
  const agents = [...v.agents.values()].map((a): AgentSnapshot => {
    const latest = [...v.sessions.values()].filter((x) => x.agentId === a.id).at(-1);
    const device = latest?.deviceId ?? null;
    return {
      id: a.id, name: a.name, vendor: a.vendor, human_id: a.humanId, device_id: device, online: device ? v.devices.get(device)?.online ?? null : null,
      active_task_id: v.activeTask(a.id)?.id ?? null, live_session_id: v.liveSession(a.id)?.id ?? null,
    };
  });
  const messages = [...v.messages.values()].sort((a, b) => a.seq - b.seq).slice(-MESSAGES).map((m): MessageSnapshot => ({
    id: m.id, kind: m.kind, from: m.from, to: m.to, from_task: m.fromTask, to_task: m.toTask, in_reply_to: m.inReplyTo ?? null,
    text: m.text, priority: m.priority, sent_at: m.sentAt, seq: m.seq,
  }));
  const spent = [...v.sessions.values()].filter((x) => x.deviceId === local.deviceId && x.startedAt.slice(0, 10) === day).reduce((sum, x) => sum + costOf(v, x.id), 0);
  return {
    v: 1, project_id: v.projectId, head_seq: v.head, integration_mode: local.integrationMode, taken_at: new Date(now).toISOString(),
    device_id: local.deviceId, principal: local.principal, connection: local.connection,
    tasks, agents, devices: [...v.devices.entries()].map(([device_id, d]) => ({ device_id, online: d.online, at: d.at })),
    messages, waits: [...v.waits.values()].map(wait), lands: [...v.lands.values()].map(land),
    base_advances: v.baseAdvances.map((b) => ({ old_sha: b.oldSha, new_sha: b.newSha, changed_paths: [...b.changedPaths], at: b.at })),
    budget: { day, spent_usd: spent, daily_budget_usd: local.budget.dailyBudgetUsd, session_cap_usd: local.budget.sessionCapUsd },
  };
}
