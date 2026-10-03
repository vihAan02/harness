// A/B metrics for the harness arm, computed from the project's event log (docs/validation.md §4; 0A
// item 10). Everything here comes from events, so a run can be scored after the fact from its log.
// Metrics that need a diff review, the land step's tests or a human timer (M2, M3, M4, M6, M9, M10)
// aren't computed here; they're listed so a report shows what's still to be scored.
import type { EventMessage } from '@harness/protocol';
import { duration } from './status.ts';
import type { ProjectView } from './view.ts';

export type TaskMetrics = {
  id: string; title: string; agent: string | null; status: string;
  assignedAt: string | null; finishedAt: string | null; durationMs: number | null; commit: string | null;
};
export type RunMetrics = {
  project: string;
  window: { start: string | null; end: string | null; complete: boolean };
  /** M1 (0A form): from the first assignment until every assigned task is done and committed, or abandoned. Land and tests are added in 0B. */
  completionMs: number | null;
  tasks: TaskMetrics[];
  /** M5: human actions to agents beyond the initial task assignment. */
  interventions: { total: number; byKind: Record<string, number>; events: { seq: number; kind: string; detail: string }[] };
  /** M5b: tool calls the shared allow list denied. */
  deniedToolCalls: number;
  /** M7: messages by kind and by who talked to whom. */
  messages: { total: number; byKind: Record<string, number>; agentToAgent: number; humanToAgent: number; harnessNotices: number; held: number };
  /** M8: the vendors' running totals, summed over every session. */
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number; sessions: number };
  /** Estimated tokens of everything the harness injected (characters ÷ 4; Q-05: measured, not budgeted). */
  coordinationTokensEst: number;
  /** 0A loop latency: where messages landed and how long they took (D-26). */
  delivery: {
    count: number; byPoint: Record<string, number>; latencyMs: { median: number | null; max: number | null };
    questionRoundTripsMs: number[]; // question sent → its answer delivered to the asker
  };
  /** H-07: harness tools each agent used (unprompted use of ask/answer is the hypothesis). */
  shimCalls: Record<string, Record<string, number>>;
  overlaps: { observed: number; prospective: number };
  notComputed: Record<string, string>;
};

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};
const bump = (o: Record<string, number>, k: string, n = 1) => { o[k] = (o[k] ?? 0) + n; };
const isHuman = (p: string) => p.startsWith('human_');
const data = (e: EventMessage) => (e.data ?? {}) as Record<string, unknown>;

export function computeMetrics(view: ProjectView): RunMetrics {
  const events = view.events;
  const assigned = new Map<string, EventMessage>();
  const finished = new Map<string, EventMessage>();
  const commits = new Map<string, string>();
  for (const e of events) {
    const task = String(data(e).task_id ?? '');
    if (e.kind === 'task.assigned' && !assigned.has(task)) assigned.set(task, e);
    if (e.kind === 'task.completed' || e.kind === 'task.abandoned') finished.set(task, e);
    if (e.kind === 'worktree.committed') commits.set(task, String(data(e).commit));
  }

  const tasks: TaskMetrics[] = [...assigned.keys()].map((id) => {
    const t = view.tasks.get(id);
    const a = assigned.get(id)!;
    // A done task counts as finished once harnessd has committed it (or found nothing to commit).
    const f = finished.get(id);
    const fin = f?.kind === 'task.completed' ? events.find((e) => e.seq > f.seq && e.kind === 'worktree.committed' && data(e).task_id === id) ?? f : f;
    return {
      id, title: t?.title ?? id, agent: t?.assignee ? view.agentName(t.assignee) : null, status: t?.status ?? 'unknown',
      assignedAt: a.at, finishedAt: fin?.at ?? null, durationMs: fin ? Date.parse(fin.at) - Date.parse(a.at) : null, commit: commits.get(id) ?? null,
    };
  });
  const starts = tasks.map((t) => t.assignedAt).filter((x): x is string => !!x).sort();
  const ends = tasks.map((t) => t.finishedAt);
  const complete = tasks.length > 0 && ends.every((x) => x !== null);
  const end = complete ? (ends as string[]).sort().at(-1)! : null;

  // M5: human actions after the initial assignments. In 0A a task can only be assigned once, so every
  // task.created / task.assigned is part of the setup, not an intervention.
  const interventions: RunMetrics['interventions'] = { total: 0, byKind: {}, events: [] };
  for (const e of events) {
    const d = data(e);
    let detail: string | null = null;
    if (e.kind === 'message.sent' && isHuman(String(d.from))) detail = `${String(d.kind)} to ${view.agentName(String(d.to))}`;
    else if (e.kind === 'task.completed' && isHuman(String(d.by))) detail = `marked ${String(d.task_id)} done`;
    else if (e.kind === 'task.abandoned') detail = `abandoned ${String(d.task_id)}`;
    if (detail === null) continue;
    interventions.total++;
    bump(interventions.byKind, e.kind);
    interventions.events.push({ seq: e.seq, kind: e.kind, detail });
  }

  const messages: RunMetrics['messages'] = { total: 0, byKind: {}, agentToAgent: 0, humanToAgent: 0, harnessNotices: 0, held: 0 };
  for (const m of view.messages.values()) {
    messages.total++;
    bump(messages.byKind, m.kind);
    if (m.held) messages.held++;
    if (m.from === 'harness') messages.harnessNotices++;
    else if (isHuman(m.from) || (m.to && isHuman(m.to))) messages.humanToAgent++;
    else messages.agentToAgent++;
  }

  const tokens: RunMetrics['tokens'] = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, sessions: view.usage.size };
  let denied = 0;
  const shimCalls: RunMetrics['shimCalls'] = {};
  for (const [sessionId, u] of view.usage) {
    tokens.input += u.input;
    tokens.output += u.output;
    tokens.cacheRead += u.cacheRead;
    tokens.cacheCreation += u.cacheCreation;
    tokens.costUsd += u.costUsd;
    denied += u.deniedCalls;
    const agent = view.agentName(view.sessions.get(sessionId)?.agentId ?? null);
    for (const [tool, n] of Object.entries(u.toolCalls)) {
      if (!tool.startsWith('mcp__harness__')) continue;
      shimCalls[agent] ??= {};
      bump(shimCalls[agent]!, tool.slice('mcp__harness__'.length), n);
    }
  }
  tokens.costUsd = Math.round(tokens.costUsd * 1e6) / 1e6;

  const delivered = [...view.messages.values()].filter((m) => m.deliveredAt);
  const byPoint: Record<string, number> = {};
  for (const m of delivered) bump(byPoint, m.delivery ?? 'unknown');
  const latencies = delivered.map((m) => m.latencyMs ?? 0);
  const roundTrips: number[] = [];
  for (const q of view.messages.values()) {
    if (q.kind !== 'question') continue;
    const a = [...view.messages.values()].find((m) => m.kind === 'answer' && m.inReplyTo === q.id && m.deliveredAt);
    if (a) roundTrips.push(Date.parse(a.deliveredAt!) - Date.parse(q.sentAt));
  }
  const coordinationTokensEst = events.filter((e) => e.kind === 'message.delivered').reduce((n, e) => n + Number(data(e).est_tokens ?? 0), 0);

  return {
    project: view.projectId,
    window: { start: starts[0] ?? null, end, complete },
    completionMs: complete && starts[0] && end ? Date.parse(end) - Date.parse(starts[0]) : null,
    tasks,
    interventions,
    deniedToolCalls: denied,
    messages,
    tokens,
    coordinationTokensEst,
    delivery: { count: delivered.length, byPoint, latencyMs: { median: median(latencies), max: latencies.length ? Math.max(...latencies) : null }, questionRoundTripsMs: roundTrips },
    shimCalls,
    overlaps: { observed: view.overlaps.filter((o) => o.level === 'observed').length, prospective: view.overlaps.filter((o) => o.level === 'prospective').length },
    notComputed: {
      M2: 'duplicated work: post-run diff review against the rubric (0B)',
      M3: 'conflicting edits: the land step and Git (0B)',
      M4: 'semantic rework after integration: post-integration log (0B)',
      M6: 'stale-context incidents: event log plus diff review (0B)',
      M9: 'failed tests at first integration: the land step\'s test run (0B)',
      M10: 'human coordination time: the coordinator\'s timer, same method in both arms',
    },
  };
}

const secs = (ms: number | null) => (ms === null ? '—' : duration(ms));

export function renderMetrics(m: RunMetrics): string {
  const lines = [
    `Metrics for ${m.project} (harness arm; docs/validation.md §4)`,
    `M1  completion time: ${m.window.complete ? secs(m.completionMs) : 'still running'} (first assignment ${m.window.start ?? '—'}${m.window.end ? `, last task finished ${m.window.end}` : ''})`,
  ];
  for (const t of m.tasks) lines.push(`      ${t.id} ${t.agent ?? '(no agent)'} [${t.status}] ${secs(t.durationMs)}${t.commit ? ` commit ${t.commit.slice(0, 12)}` : ''}`);
  lines.push(`M5  human interventions: ${m.interventions.total}${m.interventions.events.length ? ` (${m.interventions.events.map((e) => e.detail).join('; ')})` : ''}`);
  lines.push(`M5b denied tool calls: ${m.deniedToolCalls}`);
  lines.push(`M7  messages: ${m.messages.total} (${Object.entries(m.messages.byKind).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}); agent↔agent ${m.messages.agentToAgent}, human↔agent ${m.messages.humanToAgent}, harness notices ${m.messages.harnessNotices}, held ${m.messages.held}`);
  lines.push(`M8  tokens: input ${m.tokens.input}, output ${m.tokens.output}, cache read ${m.tokens.cacheRead}, cache write ${m.tokens.cacheCreation}; est. cost $${m.tokens.costUsd.toFixed(4)} over ${m.tokens.sessions} session(s)`);
  lines.push(`    coordination tokens (est.): ${m.coordinationTokensEst}`);
  lines.push(`    deliveries: ${m.delivery.count} (${Object.entries(m.delivery.byPoint).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}); latency median ${secs(m.delivery.latencyMs.median)}, max ${secs(m.delivery.latencyMs.max)}`);
  if (m.delivery.questionRoundTripsMs.length) lines.push(`    question → answer round trips: ${m.delivery.questionRoundTripsMs.map((x) => secs(x)).join(', ')}`);
  lines.push(`H-07 harness tool use: ${Object.entries(m.shimCalls).map(([a, c]) => `${a}: ${Object.entries(c).map(([k, n]) => `${k} ${n}`).join(', ')}`).join('; ') || 'none'}`);
  lines.push(`    overlaps: ${m.overlaps.observed} while editing, ${m.overlaps.prospective} between scopes`);
  lines.push('Not computed from the log:', ...Object.entries(m.notComputed).map(([k, v]) => `  ${k} ${v}`));
  return lines.join('\n');
}
