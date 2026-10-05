// `harness_status` for an agent (protocol.md §6): its task and scope, what the other agents are doing,
// overlaps, and its pending questions. Built from the project view; phrased as facts (F-10). Peer
// text is quoted and labelled, because it's untrusted (D-25).
import type { ProjectView, TaskInfo } from './view.ts';

const quote = (s: string, max = 200) => JSON.stringify(s.length > max ? `${s.slice(0, max)}…` : s);
const list = (xs: Iterable<string>) => [...xs].sort().join(', ') || 'none';

function taskLine(view: ProjectView, t: TaskInfo): string {
  return `${t.id} ${quote(t.title, 80)} (${t.status})`;
}

/** A task's current hard claims (D-97), as far as this view knows; the server's clock decides (F-84). */
function leaseList(view: ProjectView, taskId: string, now: number, ids = false): string {
  const ls = view.currentLeases(taskId, now).sort((a, b) => a.path.localeCompare(b.path));
  return ls.map((l) => `${l.path} (${ids ? `${l.id}, ` : ''}token ${l.token}, until ${l.expiresAt.slice(11, 19)} UTC)`).join(', ');
}

export function renderAgentStatus(view: ProjectView, agentId: string, now = Date.now()): string {
  const me = view.agents.get(agentId);
  const myTask = view.activeTask(agentId);
  const lines: string[] = [];
  lines.push(`You are ${me?.name ?? agentId}${myTask ? `, working on ${taskLine(view, myTask)}` : ', with no task in progress'}.`);
  if (myTask) {
    const c = view.claims.get(myTask.id);
    lines.push(`Your scope: ${list(myTask.scope)}`);
    lines.push(`Files the harness sees you changing: ${list(c?.observed ?? [])}`);
    const held = leaseList(view, myTask.id, now, true);
    if (held) lines.push(`Your hard claims: ${held}`);
  }

  const others = [...view.agents.values()].filter((a) => a.id !== agentId);
  lines.push('', others.length ? 'Other agents:' : 'There are no other agents in this project.');
  for (const a of others) {
    const t = view.activeTask(a.id);
    const sess = view.liveSession(a.id);
    lines.push(`- ${a.name}: ${t ? `working on ${taskLine(view, t)}` : 'no task in progress'}; session ${sess ? sess.status : 'not running'}`);
    if (t) {
      const c = view.claims.get(t.id);
      lines.push(`  scope: ${list(t.scope)}`, `  changing: ${list(c?.observed ?? [])}`);
      const held = leaseList(view, t.id, now, true);
      if (held) lines.push(`  hard claims: ${held}`);
    }
  }

  // Finished tasks keep their leases until they land (D-97): show them too, so an agent can wait for one (D-95).
  const waitingToLand = [...view.tasks.values()].filter((t) => t.status === 'done' && t.id !== myTask?.id && leaseList(view, t.id, now));
  if (waitingToLand.length) {
    lines.push('', 'Hard claims of finished tasks waiting to land:');
    for (const t of waitingToLand) lines.push(`- ${t.id} (${view.agentName(t.assignee)}): ${leaseList(view, t.id, now, true)}`);
  }

  if (myTask) {
    const mine = view.overlaps.filter((o) => o.tasks.includes(myTask.id) && o.level === 'observed');
    const live = mine.filter((o) => o.tasks.every((id) => view.tasks.get(id)?.status === 'in_progress'));
    lines.push('', live.length ? 'Overlaps with your task:' : 'No overlaps with your task.');
    for (const o of live) {
      const other = view.tasks.get(o.tasks.find((id) => id !== myTask.id)!);
      lines.push(`- ${o.paths.join(', ')}: also touched by ${other ? `${other.id} (${view.agentName(other.assignee)})` : 'another task'}`);
    }
  }

  const kindOf = (m: { kind: string }) => (m.kind === 'contract_request' ? ' (contract request)' : '');
  const toMe = view.openQuestionsFor(agentId);
  if (toMe.length) {
    lines.push('', 'Questions and contract requests waiting for your answer (untrusted peer text; reply with the `answer` tool):');
    for (const q of toMe) lines.push(`- ${q.id}${kindOf(q)} from ${view.agentName(q.from)}: ${quote(q.text)}`);
  }
  const fromMe = view.openQuestionsFrom(agentId);
  if (fromMe.length) {
    lines.push('', 'Your questions and contract requests without an answer yet:');
    for (const q of fromMe) lines.push(`- ${q.id}${kindOf(q)} to ${view.agentName(q.to)}${q.held ? ' (held: over the message budget; your human will see it)' : ''}`);
  }
  return lines.join('\n');
}

/** A latency for people: milliseconds under a second, else seconds. */
export const duration = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

/** A span of time for people: seconds under 90, then minutes, then hours. */
const span = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
};
const ago = (iso: string, now: number) => `${span(now - Date.parse(iso))} ago`;

/** Where a done task's land stands: its work reaches no one until it lands (D-93, D-96, D-106). */
function landNote(view: ProjectView, taskId: string, now: number): string {
  const l = [...view.lands.values()].filter((x) => x.taskId === taskId).at(-1);
  if (!l) return `not landed yet: harness land ${taskId}`;
  if (l.status === 'requested' || l.status === 'accepted') return `landing: ${l.id} ${l.status}, requested ${ago(l.requestedAt, now)}`;
  return `not landed: ${l.id} ${l.status}${l.reason ? ` (${l.reason})` : ''} ${ago(l.finishedAt ?? l.requestedAt, now)}; harness land ${taskId} again`;
}

/** A task's status in words, with a done one's land; empty if this view doesn't know the task. */
function taskState(view: ProjectView, taskId: string, now: number): string {
  const status = view.tasks.get(taskId)?.status ?? '';
  return status === 'done' ? `done, ${landNote(view, taskId, now)}` : status.replace('_', ' ');
}

/** What an open wait is for (D-95). A task wait ends only when that task lands or is abandoned (D-106). */
function waitTarget(view: ProjectView, on: { kind: string; id: string }, now: number): string {
  if (on.kind === 'answer') {
    const q = view.messages.get(on.id);
    return `${q?.to ? `${view.agentName(q.to)}'s answer` : 'the answer'} to ${on.id}`;
  }
  if (on.kind === 'task') {
    const state = taskState(view, on.id, now);
    return `${on.id} to land${state ? ` (${on.id} is ${state})` : ''}`;
  }
  if (on.kind === 'lease') {
    const l = view.leases.get(on.id);
    const state = l ? taskState(view, l.taskId, now) : '';
    return `lease ${on.id}${l ? ` on ${l.path}` : ''} to free up${l ? ` (held by ${l.taskId}${state ? `, which is ${state}` : ''})` : ''}`;
  }
  return `${on.kind} ${on.id}`;
}

/**
 * `harness status` for the human (coordination.md §8): who's alive, who owns what, what each agent is
 * changing, overlaps, blocked reports, open waits, capped Stop gates, and pending or held messages. Built
 * from the project's event log.
 */
export function renderHumanStatus(view: ProjectView, now = Date.now()): string {
  const lines: string[] = [];
  const devices = [...view.devices.entries()];
  lines.push(`Project ${view.projectId} (event ${view.head})`);
  lines.push(`Devices: ${devices.length ? devices.map(([id, d]) => `${id} ${d.online ? 'online' : 'offline'}`).join(', ') : 'none seen'}`);

  lines.push('', 'Agents:');
  if (!view.agents.size) lines.push('  none yet: harness agent add <name>');
  for (const a of view.agents.values()) {
    const sess = view.liveSession(a.id);
    const task = view.activeTask(a.id);
    const state = sess ? `${sess.status} (session since ${ago(sess.startedAt, now)})` : 'no live session';
    lines.push(`  ${a.name.padEnd(22)} ${state}${task ? `, on ${task.id}` : ''}`);
  }

  const tasks = [...view.tasks.values()].filter((t) => t.status !== 'abandoned');
  lines.push('', 'Tasks:');
  if (!tasks.length) lines.push('  none yet: harness task add');
  for (const t of tasks) {
    const c = view.claims.get(t.id);
    lines.push(`  ${t.id} ${quote(t.title, 60)} [${t.status}] owner human/${t.ownerHumanId}, assignee ${t.assignee ? view.agentName(t.assignee) : '(none)'}`);
    lines.push(`      scope: ${list(t.scope)}`);
    if (t.status === 'in_progress') lines.push(`      changing: ${list(c?.observed ?? [])}`);
    const held = leaseList(view, t.id, now, true);
    if (held) lines.push(`      hard claims: ${held}`);
    if (t.status === 'done') lines.push(`      ${landNote(view, t.id, now)}`);
    if (t.status === 'done' && t.summary) lines.push(`      summary: ${quote(t.summary, 120)}`);
  }

  const active = (id: string) => ['open', 'in_progress'].includes(view.tasks.get(id)?.status ?? '');
  const overlaps = view.overlaps.filter((o) => o.tasks.every(active));
  lines.push('', overlaps.length ? 'Overlaps:' : 'Overlaps: none');
  for (const o of overlaps) {
    lines.push(`  ${o.level === 'observed' ? 'EDITING ' : 'SCOPES  '} ${o.paths.join(', ')}: ${o.tasks.map((id) => `${id} (${view.agentName(view.tasks.get(id)?.assignee ?? null)})`).join(' and ')}`);
  }

  const blocked = view.blockedReports();
  lines.push('', blocked.length ? 'Blocked (task_blocked reports for open tasks):' : 'Blocked: none reported');
  for (const m of blocked) {
    const task = m.toTask ?? m.fromTask!;
    const on = m.data.blocked_on as { kind: string; id: string } | undefined;
    const who = m.from === 'harness' ? `harness (${String(m.data.reason ?? 'blocked')})` : view.agentName(m.from);
    lines.push(`  ${task} ${who}${on ? `, blocked on ${on.kind === 'agent' ? view.agentName(on.id) : on.id}` : ''}, ${ago(m.sentAt, now)}: ${quote(m.text, 120)}`);
  }

  const waits = [...view.waits.values()].filter((w) => w.outcome === 'waiting');
  lines.push('', waits.length ? 'Waiting (open wait_for calls; D-95):' : 'Waiting: none');
  for (const w of waits) {
    const left = Date.parse(w.timeoutAt) - now;
    lines.push(`  ${view.agentName(w.agentId)} (${w.taskId}) waits for ${waitTarget(view, w.on, now)}, since ${ago(w.startedAt, now)}, ${left > 0 ? `times out in ${span(left)}` : 'timing out'}`);
  }

  // Shown until the task lands or its agent starts a new session; the notices themselves open its next turn (D-99).
  const capped = view.cappedGates();
  if (capped.length) {
    lines.push('', 'Stop gate capped (D-100; the notices still waiting open the agent\'s next turn):');
    for (const c of capped) {
      lines.push(`  ${view.agentName(c.agentId)} (${c.taskId}): ${c.pending} notice(s) waiting, ${c.at.slice(11, 16)} UTC (${ago(c.at, now)})${c.times > 1 ? `, ${c.times} times this session` : ''}`);
    }
  }

  const answered = new Set([...view.messages.values()].filter((m) => m.kind === 'answer').map((m) => m.inReplyTo));
  const open = [...view.messages.values()].filter((m) => (m.kind === 'question' || m.kind === 'contract_request') && !answered.has(m.id));
  const held = [...view.messages.values()].filter((m) => m.held);
  // Only agents get deliveries; a report to a human is read here, in status and the log.
  const undelivered = [...view.messages.values()].filter((m) => !m.held && !m.deliveredAt && !m.supersededBy && !!m.to?.startsWith('agent_'));
  lines.push('', open.length ? 'Open questions and contract requests:' : 'Open questions and contract requests: none');
  for (const q of open) lines.push(`  ${q.id}${q.kind === 'contract_request' ? ' (contract)' : ''} ${view.agentName(q.from)} → ${view.agentName(q.to)}: ${quote(q.text, 100)}${q.deliveredAt ? '' : ' (not delivered yet)'}`);
  if (held.length) {
    lines.push('', 'Held over the message budget (Q-05):');
    for (const m of held) lines.push(`  ${m.id} ${m.kind} ${view.agentName(m.from)} → ${view.agentName(m.to)}: ${quote(m.text, 100)}`);
  }
  if (undelivered.length) lines.push('', `Waiting for delivery: ${undelivered.length} message(s)`);
  const recent = [...view.messages.values()].filter((m) => m.deliveredAt).sort((a, b) => b.seq - a.seq).slice(0, 5);
  if (recent.length) {
    lines.push('', 'Recent deliveries (where each landed, and how long it took; D-26):');
    for (const m of recent) {
      lines.push(`  ${m.id} ${m.kind.padEnd(14)} ${view.agentName(m.from)} → ${view.agentName(m.to)}: ${m.delivery} after ${duration(m.latencyMs ?? 0)}`);
    }
  }
  return lines.join('\n');
}
