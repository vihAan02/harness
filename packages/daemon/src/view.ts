// A project's current state, folded from its event log (protocol.md §3: clients learn about the world
// only from events). harnessd keeps one per project for routing and the agents' `harness_status`; the
// CLI builds one for `harness status` (coordination.md §8). Pure: no I/O.
import type { EventMessage } from '@harness/protocol';

export type AgentInfo = { id: string; name: string; vendor: string; humanId: string };
export type TaskInfo = {
  id: string; title: string; text: string; scope: string[]; ownerHumanId: string; priority: number;
  assignee: string | null; status: string; summary?: string;
  createdAt: string; assignedAt?: string; completedAt?: string;
};
export type SessionInfo = {
  id: string; agentId: string; taskId: string; deviceId: string; worktree: string; status: string; startedAt: string; endedAt?: string; endReason?: string;
  model?: string; provider?: string; // as configured (D-87); unset: the vendor's default
};
export type UsageInfo = {
  input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number;
  costBasis?: string; models: string[]; // where the cost came from, and the models the tokens went to (D-87)
  toolCalls: Record<string, number>; deniedCalls: number;
  hookCoverage?: { observed: number; missed: number; rejected: number }; // the missed-hook monitor (H-03)
  readCoverage?: Record<string, number>; // reads by source, and unparsed shell reads (H-03, D-88)
};
export type ReadInfo = { hash: string | null; source: string; confidence: string; stale: boolean; at: string };
export type LandInfo = {
  id: string; taskId: string; deviceId: string; status: 'requested' | 'accepted' | 'rejected' | 'completed' | 'failed';
  runTests: boolean; requestedAt: string; finishedAt?: string; reason?: string; detail?: string; changedPaths?: string[]; newBaseSha?: string;
};
export type MessageInfo = {
  id: string; kind: string; from: string; to: string | null; inReplyTo?: string; text: string; data: Record<string, unknown>;
  fromTask: string | null; toTask: string | null; priority: string; sentAt: string; seq: number;
  held?: boolean; deliveredAt?: string; delivery?: string; latencyMs?: number;
  supersededBy?: string; // a newer notice replaced it before delivery (coordination §2)
};
/** A hard claim (D-97). `expiresAt` is as last granted or renewed; the server's clock is authoritative (F-84). */
export type LeaseInfo = {
  id: string; taskId: string; path: string; token: number; expiresAt: string; grantedAt: string; by: string; force: boolean;
  /** Its TTL in seconds, as granted (absent on grants logged before it was carried; D-97 default 120). */
  ttlS?: number;
  releasedAt?: string; releaseReason?: string; expiredAt?: string;
};
/** An agent waiting for one thing, with a timeout (D-95). Exactly one outcome ends it. */
export type WaitInfo = {
  id: string; taskId: string; sessionId: string; agentId: string; on: { kind: string; id: string }; timeoutAt: string; startedAt: string;
  outcome: 'waiting' | 'resolved' | 'timed_out' | 'cancelled'; result?: Record<string, unknown>; reason?: string; finishedAt?: string;
};
export type OverlapInfo = { id: string; level: 'prospective' | 'observed'; paths: string[]; tasks: [string, string]; at: string };

const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export class ProjectView {
  projectId: string;
  head = 0;
  agents = new Map<string, AgentInfo>();
  tasks = new Map<string, TaskInfo>();
  sessions = new Map<string, SessionInfo>();
  devices = new Map<string, { online: boolean; at: string }>();
  /** Per task: prospective claims (its scope) and observed claims (paths it is changing). */
  claims = new Map<string, { prospective: Set<string>; observed: Set<string> }>();
  overlaps: OverlapInfo[] = [];
  messages = new Map<string, MessageInfo>();
  usage = new Map<string, UsageInfo>(); // by session: the vendor's running totals
  /** Per task: what its agent read (path → hash), as reported (0B item 1). */
  reads = new Map<string, Map<string, ReadInfo>>();
  lands = new Map<string, LandInfo>();
  leases = new Map<string, LeaseInfo>(); // hard claims, by lease id (D-97)
  waits = new Map<string, WaitInfo>(); // wait_for, by wait id (D-95)
  events: EventMessage[] = [];

  constructor(projectId: string) {
    this.projectId = projectId;
  }

  apply(e: EventMessage): void {
    if (e.project_id !== this.projectId || e.seq <= this.head) return;
    this.head = e.seq;
    this.events.push(e);
    const d = (e.data ?? {}) as Record<string, unknown>;
    const s = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : '');
    switch (e.kind) {
      case 'agent.created':
        this.agents.set(s('agent_id'), { id: s('agent_id'), name: s('name'), vendor: s('vendor'), humanId: s('accountable_human_id') });
        break;
      case 'task.created':
        this.tasks.set(s('task_id'), {
          id: s('task_id'), title: s('title'), text: s('text'), scope: asStrings(d.scope), ownerHumanId: s('owner_human_id'),
          priority: Number(d.priority ?? 0), assignee: null, status: 'open', createdAt: e.at,
        });
        this.claimsOf(s('task_id'));
        break;
      case 'task.assigned':
        this.patchTask(s('task_id'), { assignee: s('assignee_agent_id'), status: 'in_progress', assignedAt: e.at });
        break;
      case 'task.completed':
        this.patchTask(s('task_id'), { status: 'done', completedAt: e.at, ...(d.summary ? { summary: s('summary') } : {}) });
        this.claims.delete(s('task_id'));
        break;
      case 'task.abandoned':
        this.patchTask(s('task_id'), { status: 'abandoned', completedAt: e.at });
        this.claims.delete(s('task_id'));
        break;
      case 'device.online':
      case 'device.offline':
        this.devices.set(s('device_id'), { online: e.kind === 'device.online', at: e.at });
        break;
      case 'session.started':
        this.sessions.set(s('session_id'), {
          id: s('session_id'), agentId: s('agent_id'), taskId: s('task_id'), deviceId: s('device_id'), worktree: s('worktree'),
          status: s('status') || 'starting', startedAt: e.at, ...(d.model ? { model: s('model') } : {}), ...(d.provider ? { provider: s('provider') } : {}),
        });
        break;
      case 'session.status': {
        const sess = this.sessions.get(s('session_id'));
        if (sess) sess.status = s('status');
        break;
      }
      case 'session.ended': {
        const sess = this.sessions.get(s('session_id'));
        if (sess) Object.assign(sess, { status: 'ended', endedAt: e.at, ...(d.reason ? { endReason: s('reason') } : {}) });
        break;
      }
      case 'usage.reported': {
        const prev = this.usage.get(s('session_id'));
        this.usage.set(s('session_id'), {
          input: Number(d.input ?? prev?.input ?? 0), output: Number(d.output ?? prev?.output ?? 0), cacheRead: Number(d.cache_read ?? prev?.cacheRead ?? 0),
          cacheCreation: Number(d.cache_creation ?? prev?.cacheCreation ?? 0), costUsd: Number(d.cost_usd ?? prev?.costUsd ?? 0),
          ...((d.cost_basis ?? prev?.costBasis) ? { costBasis: String(d.cost_basis ?? prev?.costBasis) } : {}),
          models: d.models !== undefined ? asStrings(d.models) : prev?.models ?? [],
          ...((d.hook_coverage ?? prev?.hookCoverage) ? { hookCoverage: (d.hook_coverage ?? prev?.hookCoverage) as UsageInfo['hookCoverage'] } : {}),
          ...((d.read_coverage ?? prev?.readCoverage) ? { readCoverage: (d.read_coverage ?? prev?.readCoverage) as Record<string, number> } : {}),
          toolCalls: (d.tool_calls as Record<string, number> | undefined) ?? prev?.toolCalls ?? {},
          deniedCalls: Number(d.denied_calls ?? prev?.deniedCalls ?? 0),
        });
        break;
      }
      case 'claim.prospective':
        for (const p of asStrings(d.paths)) this.claimsOf(s('task_id')).prospective.add(p);
        break;
      case 'claim.observed':
        for (const p of asStrings(d.paths)) this.claimsOf(s('task_id')).observed.add(p);
        break;
      case 'claim.cleared': {
        const c = this.claims.get(s('task_id'));
        if (c) for (const p of asStrings(d.paths)) c[d.claim_kind === 'prospective' ? 'prospective' : 'observed'].delete(p);
        break;
      }
      case 'overlap.detected':
        this.overlaps.push({ id: s('overlap_id'), level: d.level === 'prospective' ? 'prospective' : 'observed', paths: asStrings(d.paths), tasks: asStrings(d.tasks) as [string, string], at: e.at });
        break;
      case 'message.sent':
        this.messages.set(s('message_id'), {
          id: s('message_id'), kind: s('kind'), from: s('from'), to: s('to') || null, ...(d.in_reply_to ? { inReplyTo: s('in_reply_to') } : {}),
          text: s('text'), data: d, fromTask: s('from_task_id') || null, toTask: s('to_task_id') || null, priority: s('priority') || 'normal',
          sentAt: e.at, seq: e.seq, ...(d.held ? { held: true } : {}),
        });
        break;
      case 'message.delivered': {
        const m = this.messages.get(s('message_id'));
        if (m) Object.assign(m, { deliveredAt: s('delivered_at') || e.at, delivery: s('delivery'), latencyMs: Number(d.latency_ms ?? 0) });
        break;
      }
      case 'message.superseded': {
        const m = this.messages.get(s('message_id'));
        if (m) m.supersededBy = s('by');
        break;
      }
      case 'readset.added': {
        const r = this.reads.get(s('task_id')) ?? new Map<string, ReadInfo>();
        this.reads.set(s('task_id'), r);
        for (const x of (Array.isArray(d.entries) ? d.entries : []) as Record<string, unknown>[]) {
          r.set(String(x.path), { hash: typeof x.hash === 'string' ? x.hash : null, source: String(x.source), confidence: String(x.confidence), stale: false, at: e.at });
        }
        break;
      }
      case 'worktree.synced': {
        const r = this.reads.get(s('task_id'));
        for (const p of asStrings(d.stale_paths)) { const x = r?.get(p); if (x) x.stale = true; }
        break;
      }
      case 'task.blocked':
        this.patchTask(s('task_id'), { status: 'blocked' });
        break;
      case 'task.unblocked':
        this.patchTask(s('task_id'), { status: 'in_progress' });
        break;
      case 'land.requested':
        this.lands.set(s('land_id'), { id: s('land_id'), taskId: s('task_id'), deviceId: s('device_id'), status: 'requested', runTests: d.run_tests !== false, requestedAt: e.at });
        break;
      case 'land.accepted':
      case 'land.rejected': {
        const l = this.lands.get(s('land_id'));
        if (l) Object.assign(l, { status: e.kind === 'land.accepted' ? 'accepted' : 'rejected', changedPaths: asStrings(d.changed_paths), ...(e.kind === 'land.rejected' ? { finishedAt: e.at, reason: 'fencing' } : {}) });
        break;
      }
      case 'land.completed': {
        const l = this.lands.get(s('land_id'));
        if (l) Object.assign(l, { status: 'completed', finishedAt: e.at, newBaseSha: s('new_base_sha'), changedPaths: asStrings(d.changed_paths) });
        this.patchTask(s('task_id'), { status: 'landed' });
        break;
      }
      case 'land.failed': {
        const l = this.lands.get(s('land_id'));
        if (l) Object.assign(l, { status: 'failed', finishedAt: e.at, reason: s('reason'), ...(d.detail ? { detail: s('detail') } : {}) });
        break;
      }
      case 'wait.started': {
        const on = (d.on ?? {}) as { kind?: unknown; id?: unknown };
        this.waits.set(s('wait_id'), {
          id: s('wait_id'), taskId: s('task_id'), sessionId: s('session_id'), agentId: s('agent_id'),
          on: { kind: typeof on.kind === 'string' ? on.kind : '', id: typeof on.id === 'string' ? on.id : '' },
          timeoutAt: s('timeout_at'), startedAt: e.at, outcome: 'waiting',
        });
        break;
      }
      case 'wait.resolved':
      case 'wait.timed_out':
      case 'wait.cancelled': {
        const w = this.waits.get(s('wait_id'));
        if (w) {
          Object.assign(w, { outcome: e.kind.slice('wait.'.length), finishedAt: e.at });
          if (typeof d.result === 'object' && d.result) w.result = d.result as Record<string, unknown>;
          if (d.reason) w.reason = s('reason');
        }
        break;
      }
      case 'lease.granted':
        this.leases.set(s('lease_id'), {
          id: s('lease_id'), taskId: s('task_id'), path: s('path'), token: Number(d.token), expiresAt: s('expires_at'), grantedAt: e.at,
          by: s('by'), force: d.force === true, ...(Number.isInteger(d.ttl_s) ? { ttlS: d.ttl_s as number } : {}),
        });
        break;
      case 'lease.renewed':
        for (const r of Array.isArray(d.leases) ? d.leases as { lease_id?: unknown; expires_at?: unknown }[] : []) {
          const l = typeof r?.lease_id === 'string' ? this.leases.get(r.lease_id) : undefined;
          if (l && typeof r.expires_at === 'string') l.expiresAt = r.expires_at;
        }
        break;
      case 'lease.expired': {
        const l = this.leases.get(s('lease_id'));
        if (l) l.expiredAt = e.at;
        break;
      }
      case 'lease.released': {
        const l = this.leases.get(s('lease_id'));
        if (l) Object.assign(l, { releasedAt: e.at, releaseReason: s('reason') });
        break;
      }
    }
  }

  claimsOf(taskId: string) {
    let c = this.claims.get(taskId);
    if (!c) this.claims.set(taskId, (c = { prospective: new Set(), observed: new Set() }));
    return c;
  }

  patchTask(id: string, patch: Partial<TaskInfo>): void {
    const t = this.tasks.get(id);
    if (t) Object.assign(t, patch);
  }

  // ---------- queries ----------

  agentName(id: string | null): string {
    if (!id) return '(nobody)';
    if (id === 'harness') return 'harness';
    return this.agents.get(id)?.name ?? id;
  }

  /** The agent's live session, if any. */
  liveSession(agentId: string): SessionInfo | undefined {
    return [...this.sessions.values()].reverse().find((s) => s.agentId === agentId && s.status !== 'ended');
  }

  /** The agent's active task (in progress, or blocked on a sync conflict), if any. */
  activeTask(agentId: string): TaskInfo | undefined {
    return [...this.tasks.values()].reverse().find((t) => t.assignee === agentId && (t.status === 'in_progress' || t.status === 'blocked'));
  }

  /** The task's wait that hasn't ended yet, if any (one at a time, D-95). */
  openWait(taskId: string): WaitInfo | undefined {
    return [...this.waits.values()].find((w) => w.taskId === taskId && w.outcome === 'waiting');
  }

  /** The task's leases that are neither released nor past expiry, as far as this view knows (the server decides, D-97). */
  currentLeases(taskId: string, now = Date.now()): LeaseInfo[] {
    return [...this.leases.values()].filter((l) => l.taskId === taskId && !l.releasedAt && !l.expiredAt && Date.parse(l.expiresAt) > now);
  }

  /** Questions to this principal that have no answer yet. */
  openQuestionsFor(principal: string): MessageInfo[] {
    const answered = new Set([...this.messages.values()].filter((m) => m.kind === 'answer' && m.inReplyTo).map((m) => m.inReplyTo!));
    return [...this.messages.values()].filter((m) => m.kind === 'question' && m.to === principal && !answered.has(m.id));
  }

  /** Questions this principal asked that have no answer yet. */
  openQuestionsFrom(principal: string): MessageInfo[] {
    const answered = new Set([...this.messages.values()].filter((m) => m.kind === 'answer' && m.inReplyTo).map((m) => m.inReplyTo!));
    return [...this.messages.values()].filter((m) => m.kind === 'question' && m.from === principal && !answered.has(m.id));
  }
}
