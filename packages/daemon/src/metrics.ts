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
  /**
   * M1: from the first assignment until every assigned task is finished. Once the run has used the land step
   * (0B), finished means landed with its tests green, or abandoned; before that (the 0A form), done and committed.
   */
  completionMs: number | null;
  /** M1's form: 'landed' when the run used the land step, else 'committed'. */
  completionForm: 'landed' | 'committed';
  tasks: TaskMetrics[];
  /** M5: human actions to agents beyond the initial task assignment. */
  interventions: { total: number; byKind: Record<string, number>; events: { seq: number; kind: string; detail: string }[] };
  /** M5b: tool calls the shared allow list denied. */
  deniedToolCalls: number;
  /** M5c: human integration actions (`harness land`, cancelling a land, unblocking a sync conflict), apart from M5. */
  integrationActions: { total: number; byKind: Record<string, number> };
  /** M7: messages by kind and by who talked to whom. */
  messages: { total: number; byKind: Record<string, number>; agentToAgent: number; humanToAgent: number; harnessNotices: number; held: number };
  /**
   * M8: the vendors' running totals, summed over every session. `models` are the models the tokens went to;
   * `configured` the models sessions were started with (D-87: an A/B run holds one, so more than one is a
   * warning); `costBasis` where the cost figures came from (configured prices, list prices, or a guess).
   */
  tokens: {
    input: number; output: number; cacheRead: number; cacheCreation: number; costUsd: number; sessions: number;
    models: string[]; configured: string[]; costBasis: string[];
  };
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
  /** The land step (0B): lands by outcome; M3 conflicting edits (land or sync conflicts); M9 test failures at a task's first land. */
  lands: { completed: number; rejected: number; failed: Record<string, number>; conflicts: number; firstLandTestFailures: number };
  /**
   * Stale-context notices (0B; P1 diagnostic): how many of each stage were sent and delivered, and how many
   * landed notices reached their reader before its task finished.
   */
  notices: { inProgress: { sent: number; delivered: number }; landed: { sent: number; delivered: number; beforeReaderFinished: number }; superseded: number };
  /**
   * H-03, capture coverage: tool calls a hook saw, missed, or never reached (denied or failed); reads by how
   * they were captured; and file edits only a worktree diff found (the hooks missed them, D-70).
   */
  coverage: { hooks: { observed: number; missed: number; rejected: number }; reads: Record<string, number>; editsOnlyByDiff: number };
  /** H-04: delivered stale-context notices, and how many were followed by a re-read of a file they named. */
  reReads: { notices: number; reReadAfter: number };
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

  const landed = new Map<string, EventMessage>();
  for (const e of events) if (e.kind === 'land.completed') landed.set(String(data(e).task_id), e);
  const landForm = events.some((e) => e.kind === 'land.requested');
  const tasks: TaskMetrics[] = [...assigned.keys()].map((id) => {
    const t = view.tasks.get(id);
    const a = assigned.get(id)!;
    // 0A form: a done task counts as finished once harnessd has committed it (or found nothing to commit).
    // 0B form: only once it has landed (its tests green), or been abandoned.
    const f = finished.get(id);
    const committed = f?.kind === 'task.completed' ? events.find((e) => e.seq > f.seq && e.kind === 'worktree.committed' && data(e).task_id === id) ?? f : f;
    const fin = landForm && f?.kind === 'task.completed' ? landed.get(id) : committed;
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

  // M5c: integration is a human action in both arms, counted apart from coordination (validation.md §3).
  const integrationActions: RunMetrics['integrationActions'] = { total: 0, byKind: {} };
  for (const e of events) {
    const d = data(e);
    const human = (who: unknown) => isHuman(String(who ?? e.actor?.principal ?? ''));
    const counted = (e.kind === 'land.requested' && human(d.requested_by)) || (e.kind === 'task.unblocked' && human(d.by))
      || (e.kind === 'land.failed' && d.reason === 'cancelled' && human(undefined));
    if (!counted) continue;
    integrationActions.total++;
    bump(integrationActions.byKind, e.kind === 'land.failed' ? 'land.cancelled' : e.kind);
  }

  const lands: RunMetrics['lands'] = { completed: 0, rejected: 0, failed: {}, conflicts: 0, firstLandTestFailures: 0 };
  const firstLand = new Map<string, string>(); // task → outcome of its first land
  for (const e of events) {
    const d = data(e);
    const task = String(d.task_id ?? '');
    if (e.kind === 'land.completed') { lands.completed++; if (!firstLand.has(task)) firstLand.set(task, 'completed'); }
    if (e.kind === 'land.rejected') lands.rejected++;
    if (e.kind === 'land.failed') {
      bump(lands.failed, String(d.reason));
      if (d.reason === 'conflict') lands.conflicts++;
      if (d.reason !== 'cancelled' && !firstLand.has(task)) firstLand.set(task, String(d.reason));
    }
    if (e.kind === 'worktree.sync_conflict') lands.conflicts++;
  }
  lands.firstLandTestFailures = [...firstLand.values()].filter((r) => r === 'tests').length;

  const notices: RunMetrics['notices'] = { inProgress: { sent: 0, delivered: 0 }, landed: { sent: 0, delivered: 0, beforeReaderFinished: 0 }, superseded: 0 };
  for (const m of view.messages.values()) {
    if (m.kind !== 'dependency_changed') continue;
    if (m.supersededBy) notices.superseded++;
    const bucket = m.data.stage === 'landed' ? notices.landed : notices.inProgress;
    bucket.sent++;
    if (!m.deliveredAt) continue;
    bucket.delivered++;
    const readerDone = m.toTask ? finished.get(m.toTask) : undefined;
    if (m.data.stage === 'landed' && (!readerDone || Date.parse(m.deliveredAt) <= Date.parse(readerDone.at))) notices.landed.beforeReaderFinished++;
  }

  // H-04: after a notice reached its reader, did the reader read any file it named again?
  const reReads: RunMetrics['reReads'] = { notices: 0, reReadAfter: 0 };
  for (const m of view.messages.values()) {
    if (m.kind !== 'dependency_changed' || !m.deliveredAt || !m.toTask) continue;
    reReads.notices++;
    const named = new Set(Array.isArray(m.data.paths) ? (m.data.paths as unknown[]).map(String) : []);
    const after = Date.parse(m.deliveredAt);
    if (events.some((e) => e.kind === 'readset.added' && data(e).task_id === m.toTask && Date.parse(e.at) >= after
      && (data(e).entries as { path?: unknown }[] | undefined ?? []).some((x) => named.has(String(x.path))))) reReads.reReadAfter++;
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

  const tokens: RunMetrics['tokens'] = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, costUsd: 0, sessions: view.usage.size, models: [], configured: [], costBasis: [] };
  const models = new Set<string>();
  const bases = new Set<string>();
  const configured = new Set([...view.sessions.values()].map((s) => s.model ? `${s.model}${s.provider ? ` (${s.provider})` : ''}` : 'vendor default'));
  let denied = 0;
  const coverage: RunMetrics['coverage'] = { hooks: { observed: 0, missed: 0, rejected: 0 }, reads: {}, editsOnlyByDiff: 0 };
  for (const e of events) if (e.kind === 'claim.observed' && data(e).source === 'diff') coverage.editsOnlyByDiff += (data(e).paths as unknown[] | undefined ?? []).length;
  const shimCalls: RunMetrics['shimCalls'] = {};
  for (const [sessionId, u] of view.usage) {
    tokens.input += u.input;
    tokens.output += u.output;
    tokens.cacheRead += u.cacheRead;
    tokens.cacheCreation += u.cacheCreation;
    tokens.costUsd += u.costUsd;
    for (const m of u.models) models.add(m);
    if (u.costBasis) bases.add(u.costBasis);
    denied += u.deniedCalls;
    if (u.hookCoverage) for (const k of ['observed', 'missed', 'rejected'] as const) coverage.hooks[k] += u.hookCoverage[k] ?? 0;
    for (const [k, n] of Object.entries(u.readCoverage ?? {})) bump(coverage.reads, k, n);
    const agent = view.agentName(view.sessions.get(sessionId)?.agentId ?? null);
    for (const [tool, n] of Object.entries(u.toolCalls)) {
      if (!tool.startsWith('mcp__harness__')) continue;
      shimCalls[agent] ??= {};
      bump(shimCalls[agent]!, tool.slice('mcp__harness__'.length), n);
    }
  }
  tokens.costUsd = Math.round(tokens.costUsd * 1e6) / 1e6;
  tokens.models = [...models].sort();
  tokens.configured = view.sessions.size ? [...configured].sort() : [];
  tokens.costBasis = [...bases].sort();

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
    completionForm: landForm ? 'landed' : 'committed',
    tasks,
    interventions,
    deniedToolCalls: denied,
    integrationActions,
    messages,
    tokens,
    coordinationTokensEst,
    delivery: { count: delivered.length, byPoint, latencyMs: { median: median(latencies), max: latencies.length ? Math.max(...latencies) : null }, questionRoundTripsMs: roundTrips },
    shimCalls,
    overlaps: { observed: view.overlaps.filter((o) => o.level === 'observed').length, prospective: view.overlaps.filter((o) => o.level === 'prospective').length },
    lands,
    notices,
    coverage,
    reReads,
    notComputed: {
      M2: 'duplicated work: post-run diff review against the rubric (0B)',
      M4: 'semantic rework after integration: post-integration log (0B)',
      M6: 'stale-context incidents reaching integration: hidden checks plus diff review (0B A/B setup)',
      M10: 'human coordination time: the coordinator\'s timer, same method in both arms',
      ...(landForm ? {} : { M3: 'conflicting edits: from the land step, once the run lands tasks', M9: 'failed tests at first integration: from the land step, once the run lands tasks' }),
    },
  };
}

const secs = (ms: number | null) => (ms === null ? '—' : duration(ms));

export function renderMetrics(m: RunMetrics): string {
  const lines = [
    `Metrics for ${m.project} (harness arm; docs/validation.md §4)`,
    `M1  completion time: ${m.window.complete ? secs(m.completionMs) : 'still running'}, until every task is ${m.completionForm === 'landed' ? 'landed (tests green) or abandoned' : 'done and committed, or abandoned'} (first assignment ${m.window.start ?? '—'}${m.window.end ? `, last task finished ${m.window.end}` : ''})`,
  ];
  for (const t of m.tasks) lines.push(`      ${t.id} ${t.agent ?? '(no agent)'} [${t.status}] ${secs(t.durationMs)}${t.commit ? ` commit ${t.commit.slice(0, 12)}` : ''}`);
  lines.push(`M5  human interventions: ${m.interventions.total}${m.interventions.events.length ? ` (${m.interventions.events.map((e) => e.detail).join('; ')})` : ''}`);
  lines.push(`M5b denied tool calls: ${m.deniedToolCalls}`);
  lines.push(`M5c human integration actions: ${m.integrationActions.total}${m.integrationActions.total ? ` (${Object.entries(m.integrationActions.byKind).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`);
  lines.push(`M7  messages: ${m.messages.total} (${Object.entries(m.messages.byKind).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}); agent↔agent ${m.messages.agentToAgent}, human↔agent ${m.messages.humanToAgent}, harness notices ${m.messages.harnessNotices}, held ${m.messages.held}`);
  lines.push(`M8  tokens: input ${m.tokens.input}, output ${m.tokens.output}, cache read ${m.tokens.cacheRead}, cache write ${m.tokens.cacheCreation}; est. cost $${m.tokens.costUsd.toFixed(4)} over ${m.tokens.sessions} session(s)${m.tokens.costBasis.length ? ` (${m.tokens.costBasis.join(' + ')} prices)` : ''}`);
  lines.push(`    models: ${m.tokens.models.join(', ') || '—'}; configured: ${m.tokens.configured.join(', ') || '—'}`);
  if (m.tokens.configured.length > 1) lines.push('    ⚠ sessions were configured with different models: an A/B run must hold one model and configuration (D-87)');
  lines.push(`    coordination tokens (est.): ${m.coordinationTokensEst}`);
  lines.push(`    deliveries: ${m.delivery.count} (${Object.entries(m.delivery.byPoint).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}); latency median ${secs(m.delivery.latencyMs.median)}, max ${secs(m.delivery.latencyMs.max)}`);
  if (m.delivery.questionRoundTripsMs.length) lines.push(`    question → answer round trips: ${m.delivery.questionRoundTripsMs.map((x) => secs(x)).join(', ')}`);
  lines.push(`H-07 harness tool use: ${Object.entries(m.shimCalls).map(([a, c]) => `${a}: ${Object.entries(c).map(([k, n]) => `${k} ${n}`).join(', ')}`).join('; ') || 'none'}`);
  lines.push(`    overlaps: ${m.overlaps.observed} while editing, ${m.overlaps.prospective} between scopes`);
  if (m.completionForm === 'landed') {
    lines.push(`M3  conflicting edits: ${m.lands.conflicts} (land or sync conflicts)`);
    lines.push(`M9  failed tests at first integration: ${m.lands.firstLandTestFailures}`);
    lines.push(`    lands: ${m.lands.completed} landed, ${m.lands.rejected} rejected by the fencing check, ${Object.entries(m.lands.failed).map(([k, n]) => `${n} failed (${k})`).join(', ') || '0 failed'}`);
  }
  const n = m.notices;
  if (n.inProgress.sent || n.landed.sent) {
    lines.push(`    stale-context notices: in progress ${n.inProgress.delivered}/${n.inProgress.sent} delivered; landed ${n.landed.delivered}/${n.landed.sent} delivered, ${n.landed.beforeReaderFinished} before the reader finished (P1); ${n.superseded} superseded`);
  }
  const h = m.coverage.hooks;
  if (h.observed + h.missed + h.rejected || m.coverage.editsOnlyByDiff) {
    lines.push(`H-03 capture: hooks saw ${h.observed} tool call(s), missed ${h.missed}, never reached ${h.rejected}; edits found only by a worktree diff ${m.coverage.editsOnlyByDiff}`);
    if (Object.keys(m.coverage.reads).length) lines.push(`    reads by source: ${Object.entries(m.coverage.reads).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  if (m.reReads.notices) lines.push(`H-04 re-reads: after ${m.reReads.reReadAfter} of ${m.reReads.notices} delivered notice(s), the reader read a named file again`);
  lines.push('Not computed from the log:', ...Object.entries(m.notComputed).map(([k, v]) => `  ${k} ${v}`));
  return lines.join('\n');
}
