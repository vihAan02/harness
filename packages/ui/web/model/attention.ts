// The attention queue's model (D-117): what needs this human first, then what waits on others. Pure: no DOM, no fetch;
// the clock enters as `now`. Every string from the snapshot, an approval or the health reply is untrusted: this module
// only builds plain words and route strings, never markup.
import type { PendingApproval, ProjectSnapshot } from '@harness/protocol';

export type AttentionItem = {
  key: string;
  group: 'you' | 'others';
  level: 'act' | 'warn' | 'info';
  title: string;
  detail: string | null;
  route: string | null;
};

/** The circuit the snapshot carries, else the health reply's (each is { kind, reason } or null). */
function circuit(snap: ProjectSnapshot, health: { provider_circuit: { kind: string; reason: string } | null } | null) {
  return snap.provider.circuit ?? health?.provider_circuit ?? null;
}

/** The `taskId`s whose agent is this human's. */
function myAgentTaskIds(snap: ProjectSnapshot): Set<string> {
  const mine = new Set<string>();
  for (const a of snap.agents) {
    if (a.human_id === snap.principal && a.active_task_id !== null) mine.add(a.active_task_id);
  }
  return mine;
}

/** "until HH:MM" from an ISO string, in UTC and without a locale (the string is the source of truth). */
function until(timestamp: string): string {
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return timestamp;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** The approval's title words, by kind. `command` is the fallback when `details` is null. */
function approvalTitle(a: PendingApproval, taskTitle: (id: string) => string): string {
  const task = taskTitle(a.task_id);
  switch (a.kind) {
    case 'setup': return `Approve the setup command for ${task}`;
    case 'test': return `Approve the test command for landing ${task}`;
    case 'publish': return `Approve publishing ${task} as a PR`;
    case 'agent_session': {
      const d = a.details;
      if (d !== null) return `${d.issuer_human_id} asks to ${d.kind} ${d.agent_name} on ${task}`;
      return `Another human's request for ${task}`;
    }
    case 'security_review': return `A held message for ${task}: review it`;
  }
}

/**
 * The attention queue: "you" first (approvals, the circuit, the budget, my broken tasks, my questions), then "others".
 * `approvals` and `health` may be null when they haven't loaded yet.
 */
export function attention(
  snap: ProjectSnapshot,
  approvals: PendingApproval[] | null,
  health: { provider_circuit: { kind: string; reason: string } | null } | null,
  now: number,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const titleOf = (id: string): string => snap.tasks.find((t) => t.id === id)?.title ?? id;
  const agentById = new Map(snap.agents.map((a) => [a.id, a]));
  const mineAgentIds = new Set(snap.agents.filter((a) => a.human_id === snap.principal).map((a) => a.id));
  const replied = new Set(snap.messages.filter((m) => m.in_reply_to !== null).map((m) => m.in_reply_to as string));

  // --- "you" -----------------------------------------------------------------------------------------------------
  for (const a of approvals ?? []) {
    items.push({ key: `approval:${a.id}`, group: 'you', level: 'act', title: approvalTitle(a, titleOf), detail: a.command, route: `#/approval/${a.id}` });
  }

  const c = circuit(snap, health);
  if (c !== null) {
    items.push({
      key: `circuit:${c.kind}`, group: 'you', level: 'act',
      title: `No agent can start on this Mac: the provider refused (${c.kind})`, detail: c.reason, route: '#/integration',
    });
  }

  const { spent_usd: spent, daily_budget_usd: daily, day } = snap.budget;
  if (daily !== null && daily > 0 && spent >= daily) {
    items.push({
      key: 'budget:over', group: 'you', level: 'act', title: "Today's budget is used up",
      detail: `$${spent.toFixed(2)} of $${daily.toFixed(2)} (UTC day ${day}). New sessions start tomorrow.`, route: null,
    });
  } else if (daily !== null && daily > 0 && spent / daily >= 0.8) {
    items.push({ key: 'budget:warn', group: 'you', level: 'warn', title: "Most of today's budget is used", detail: null, route: null });
  }

  for (const t of snap.tasks) {
    const agent = t.assignee_agent_id !== null ? agentById.get(t.assignee_agent_id) ?? null : null;
    const mine = t.owner_human_id === snap.principal || (agent?.human_id ?? null) === snap.principal;
    if (!mine) continue;
    switch (t.state) {
      case 'stopped':
        items.push({ key: `stopped:${t.id}`, group: 'you', level: 'act', title: `${t.id} stopped (${t.state_detail ?? 'its session ended'}): resume it`, detail: null, route: `#/task/${t.id}` });
        break;
      case 'blocked':
        items.push({ key: `blocked:${t.id}`, group: 'you', level: 'act', title: `${t.id} is blocked: fix the conflict in its worktree, then unblock it`, detail: null, route: `#/task/${t.id}` });
        break;
      case 'publish_blocked':
        items.push({ key: `publish_blocked:${t.id}`, group: 'you', level: 'act', title: `${t.id} can't be published: ${t.state_detail ?? 'a rule held it'}`, detail: null, route: `#/task/${t.id}` });
        break;
      case 'pr_open': {
        const checks = t.pr !== null ? Object.values(t.pr.checks) : [];
        const failed = t.pr !== null ? Object.entries(t.pr.checks).filter(([, v]) => v === 'failure').map(([k]) => k) : [];
        const landInFlight = t.land !== null && t.land.status !== 'failed' && t.land.status !== 'completed' && t.land.status !== 'rejected';
        if (failed.length > 0) {
          items.push({ key: `checks:${t.id}`, group: 'you', level: 'act', title: `${t.id}'s checks failed: ${failed.join(', ')}`, detail: null, route: `#/task/${t.id}` });
        } else if (checks.length > 0 && checks.every((v) => v === 'success') && !landInFlight && (agent?.human_id ?? null) === snap.principal) {
          items.push({ key: `ready:${t.id}`, group: 'you', level: 'act', title: `${t.id} is ready to integrate`, detail: null, route: '#/integration' });
        }
        break;
      }
      case 'open':
        if (t.assignee_agent_id === null) {
          items.push({ key: `unassigned:${t.id}`, group: 'you', level: 'info', title: `${t.id} isn't started: assign an agent`, detail: null, route: `#/task/${t.id}` });
        }
        break;
      default:
        break;
    }
    if (t.stale_reads.length > 0 && (t.state === 'starting' || t.state === 'running' || t.state === 'stopped')) {
      items.push({
        key: `stale:${t.id}`, group: 'you', level: 'warn',
        title: `${t.id}'s agent read files that changed since: ${t.stale_reads.join(', ')}`,
        detail: 'harnessd syncs its branch and tells the agent at its next turn end', route: `#/task/${t.id}`,
      });
    }
  }

  for (const m of snap.messages) {
    if (m.kind !== 'question' && m.kind !== 'contract_request') continue;
    if (m.to === null || !mineAgentIds.has(m.to)) continue;
    if (replied.has(m.id)) continue;
    const name = agentById.get(m.to)?.name ?? m.to;
    const short = m.text.length > 120 ? m.text.slice(0, 120) : m.text;
    items.push({ key: `question:${m.id}`, group: 'you', level: 'info', title: `${name} was asked: ${short}`, detail: null, route: m.to_task !== null ? `#/task/${m.to_task}` : null });
  }

  // --- "others" --------------------------------------------------------------------------------------------------
  for (const t of snap.tasks) {
    const agent = t.assignee_agent_id !== null ? agentById.get(t.assignee_agent_id) ?? null : null;
    const mine = t.owner_human_id === snap.principal || (agent?.human_id ?? null) === snap.principal;
    if (t.state === 'awaiting_approval') {
      const agent = t.assignee_agent_id !== null ? agentById.get(t.assignee_agent_id) ?? null : null;
      const human = agent?.human_id ?? null;
      if (human !== null && human !== snap.principal) {
        items.push({ key: `awaiting:${t.id}`, group: 'others', level: 'info', title: `${t.id} waits for ${human} to approve its start`, detail: t.state_detail, route: `#/task/${t.id}` });
      }
    }
    switch (t.state) {
      case 'integrating':
        items.push({ key: `integrating:${t.id}`, group: 'others', level: 'info', title: `${t.id} is integrating (${t.state_detail ?? 'in progress'})`, detail: null, route: `#/task/${t.id}` });
        break;
      case 'outcome_unknown':
        items.push({ key: `outcome:${t.id}`, group: 'others', level: 'warn', title: `${t.id}: GitHub's answer to the merge was lost`, detail: "harnessd is asking GitHub again. Don't merge or close the PR by hand.", route: `#/task/${t.id}` });
        break;
      case 'fetch_pending':
        items.push({ key: `fetch:${t.id}`, group: 'others', level: 'warn', title: `${t.id}: harnessd couldn't fetch the base`, detail: 'it retries', route: `#/task/${t.id}` });
        break;
      default:
        break;
    }
    if (t.open_wait !== null && mine) {
      items.push({
        key: `wait:${t.id}`, group: 'others', level: 'info',
        title: `${t.id}'s agent waits for ${t.open_wait.on.kind} ${t.open_wait.on.id}`,
        detail: `until ${until(t.open_wait.timeout_at)}`, route: `#/task/${t.id}`,
      });
    }
  }

  for (const d of snap.devices) {
    if (d.online) continue;
    const agent = snap.agents.find((a) => a.device_id === d.device_id && a.active_task_id !== null) ?? null;
    if (agent === null || agent.active_task_id === null) continue;
    items.push({ key: `offline:${d.device_id}:${agent.active_task_id}`, group: 'others', level: 'warn', title: `${d.device_id} is offline`, detail: `${agent.name} on ${agent.active_task_id} can't report until it's back`, route: null });
  }

  void now;
  return items;
}
