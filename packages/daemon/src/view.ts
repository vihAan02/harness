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
export type SessionInfo = { id: string; agentId: string; taskId: string; deviceId: string; worktree: string; status: string; startedAt: string; endedAt?: string; endReason?: string };
export type UsageInfo = { input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number };
export type MessageInfo = {
  id: string; kind: string; from: string; to: string | null; inReplyTo?: string; text: string; data: Record<string, unknown>;
  fromTask: string | null; toTask: string | null; priority: string; sentAt: string; seq: number;
  held?: boolean; deliveredAt?: string; delivery?: string; latencyMs?: number;
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
          status: s('status') || 'starting', startedAt: e.at,
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
      case 'usage.reported':
        this.usage.set(s('session_id'), {
          input: Number(d.input ?? 0), output: Number(d.output ?? 0), cacheRead: Number(d.cache_read ?? 0),
          cacheCreation: Number(d.cache_creation ?? 0), costUsd: Number(d.cost_usd ?? 0),
        });
        break;
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
      case 'message.released': {
        const m = this.messages.get(s('message_id'));
        if (m) m.held = false;
        break;
      }
      case 'message.delivered': {
        const m = this.messages.get(s('message_id'));
        if (m) Object.assign(m, { deliveredAt: s('delivered_at') || e.at, delivery: s('delivery'), latencyMs: Number(d.latency_ms ?? 0) });
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

  /** The agent's task in progress, if any. */
  activeTask(agentId: string): TaskInfo | undefined {
    return [...this.tasks.values()].reverse().find((t) => t.assignee === agentId && t.status === 'in_progress');
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
