// `harness status` for the pilot (PB3; D-113 to D-117): one project as this Mac's harnessd sees it (its
// ProjectSnapshot, over the uirpc socket), in words a human acts on. It shows the connection, both Macs and their
// agents, what needs you and what to do about it, what's working and waiting, local approvals, the integration in
// flight, PRs and checks, and today's budget. Every string from a task, an agent, a peer, the server or GitHub is
// printed through untrustedText: no terminal escapes, no control characters, bounded.
import { untrustedText } from '@harness/daemon';
import type { DerivedTaskState, ProjectSnapshot, TaskSnapshot } from '@harness/protocol';

const u = (v: unknown, max = 160) => untrustedText(v, max);

/** The state in plain words, and, where the human acts, what to do. */
const STATES: Record<DerivedTaskState, { label: string; todo?: (t: TaskSnapshot) => string }> = {
  open: { label: 'not started', todo: (t) => `assign it: harness task assign ${t.id} <agent>` },
  awaiting_approval: { label: 'waiting for a local approval', todo: () => 'approve it on the Mac that runs the agent: harness approve' },
  starting: { label: 'starting' },
  running: { label: 'working' },
  stopped: { label: 'stopped: its session ended', todo: (t) => `resume it with the work so far: harness task resume ${t.id} [--text <message>]` },
  blocked: { label: 'blocked by a sync conflict', todo: (t) => `fix the conflict in its worktree, then: harness task unblock ${t.id}` },
  done: { label: 'done, not yet published' },
  publish_pending_approval: { label: 'ready to publish, waiting for your approval', todo: () => 'review the head and PR text, then: harness approve' },
  publishing: { label: 'publishing to GitHub' },
  publish_blocked: { label: 'not published: the gate found something', todo: (t) => `fix what the gate names, then: harness task reopen ${t.id} --text <what to fix>` },
  pr_open: { label: 'PR open' },
  integrating: { label: 'integrating: the one merge in flight' },
  outcome_unknown: { label: 'merge outcome unknown', todo: () => 'harnessd is asking GitHub again; don\'t merge or close the PR by hand' },
  fetch_pending: { label: 'waiting to fetch the base', todo: () => 'harnessd retries; check the network and gh auth (harness doctor)' },
  landed: { label: 'landed' },
  abandoned: { label: 'abandoned' },
};
const NEEDS_YOU: DerivedTaskState[] = ['awaiting_approval', 'stopped', 'blocked', 'publish_pending_approval', 'publish_blocked', 'outcome_unknown', 'fetch_pending'];
const WORKING: DerivedTaskState[] = ['starting', 'running'];
const REVIEW: DerivedTaskState[] = ['done', 'publishing', 'pr_open', 'integrating'];

const CONNECTION: Record<string, string> = {
  connected: 'connected to the coordinator',
  connecting: 'reconnecting to the coordinator; actions wait',
  server_identity_mismatch: 'the coordinator did NOT prove its key: nothing from it is trusted. Check the tunnel and the pinned key (harness doctor)',
  replaced: 'another harnessd took over this device: only one runs per device',
  refused: 'the coordinator refused this device: has the operator applied its key? (harness doctor)',
  coordinator_changed: 'a NEW coordinator database: harnessd won\'t mix its state with it. See the runbook before accepting it',
};

const money = (n: number | null) => (n === null ? '?' : `$${n.toFixed(2)}`);
const ago = (iso: string, now: number) => { const m = Math.round((now - Date.parse(iso)) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

/** One task's line: id, title, state, who, and the detail the snapshot gives. */
function line(s: ProjectSnapshot, t: TaskSnapshot): string {
  const agent = s.agents.find((a) => a.id === t.assignee_agent_id);
  const who = agent ? ` · ${u(agent.name, 60)}${agent.device_id ? ` on ${u(agent.device_id, 40)}` : ''}` : '';
  const detail = t.state_detail ? ` (${u(t.state_detail)})` : '';
  return `  ${t.id.padEnd(6)} ${u(t.title, 70)} — ${STATES[t.state].label}${detail}${who}`;
}

export function renderSnapshot(s: ProjectSnapshot, o: { now?: number; pendingApprovals?: number } = {}): string {
  const now = o.now ?? Date.parse(s.taken_at);
  const out: string[] = [];
  out.push(`${u(s.project_id, 64)} · ${s.integration_mode} integration · this Mac: ${u(s.device_id, 64)} (${u(s.principal, 64)})`);
  out.push(`${s.connection === 'connected' ? 'ok  ' : 'WARN'} ${CONNECTION[s.connection] ?? u(s.connection, 40)}`);

  out.push('', 'Macs and agents:');
  for (const d of s.devices) out.push(`  ${d.online ? '● online ' : '○ offline'} ${u(d.device_id, 64)}${d.device_id === s.device_id ? ' (this Mac)' : ''}, since ${ago(d.at, now)}`);
  for (const a of s.agents) {
    out.push(`  ${u(a.name, 60)} (${u(a.human_id, 40)}) on ${a.device_id ? u(a.device_id, 40) : 'no device yet'}: ${a.active_task_id ? `working on ${u(a.active_task_id, 20)}` : 'free'}${a.online === false ? ', its Mac is offline' : ''}`);
  }
  if (!s.agents.length) out.push('  no agents yet');

  /** A group of tasks, each followed by its own extra lines: what to do, waits, stale reads, its PR. */
  const group = (title: string, states: DerivedTaskState[], extra: (t: TaskSnapshot) => (string | undefined)[]) => {
    const ts = s.tasks.filter((t) => states.includes(t.state));
    out.push('', `${title}: ${ts.length || 'none'}`);
    for (const t of ts) {
      out.push(line(s, t));
      for (const x of extra(t)) if (x) out.push(`         ${x}`);
    }
  };
  group('Needs you', NEEDS_YOU, (t) => [
    STATES[t.state].todo ? `→ ${STATES[t.state].todo!(t)}` : undefined,
    ...(t.state === 'publish_blocked' ? (t.publish_blocked ?? []).map((b) => `· ${u(b.rule, 60)}${b.path ? ` in ${u(b.path, 120)}` : ''}`) : []),
  ]);
  group('Working', WORKING, (t) => [
    t.open_wait ? `waiting for ${u(t.open_wait.on.kind, 20)} ${u(t.open_wait.on.id, 40)} since ${ago(t.open_wait.started_at, now)}; times out ${ago(t.open_wait.timeout_at, now).replace(' ago', ' from now')}` : undefined,
    t.stale_reads.length ? `stale: its agent read ${t.stale_reads.map((p) => u(p, 120)).join(', ')}, changed since` : undefined,
  ]);
  group('In review', REVIEW, (t) => {
    if (!t.pr) return [];
    const checks = Object.entries(t.pr.checks).map(([n, c]) => `${u(n, 40)} ${c === 'success' ? '✓' : c === 'failure' ? '✗' : '…'} ${u(c, 20)}`).join(', ');
    return [`PR #${t.pr.number}: ${t.pr.state}${t.pr.merged ? ', merged' : ''}; ${checks || 'no checks yet'}`];
  });
  const landed = s.tasks.filter((t) => t.state === 'landed').length;
  const open = s.tasks.filter((t) => t.state === 'open').length;
  out.push('', `Not started: ${open} · Landed: ${landed} · Abandoned: ${s.tasks.filter((t) => t.state === 'abandoned').length}`);

  const inFlight = s.lands.find((l) => l.status === 'requested' || l.status === 'accepted');
  out.push('', inFlight ? `Integration in flight: ${u(inFlight.task_id, 20)}${inFlight.pr_number ? ` (PR #${inFlight.pr_number})` : ''}, ${u(inFlight.step ?? inFlight.status, 40)}` : 'No integration in flight.');
  if (s.base_advances.length) out.push(`Merged outside the harness: ${s.base_advances.map((b) => `${b.new_sha.slice(0, 12)} (${b.changed_paths.length} file${b.changed_paths.length === 1 ? '' : 's'})`).join(', ')}`);
  if (o.pendingApprovals) out.push(`Local approvals waiting on this Mac: ${o.pendingApprovals} (harness approve)`);

  const { spent_usd: spent, daily_budget_usd: daily, session_cap_usd: cap } = s.budget;
  const frac = daily ? spent / daily : 0;
  const level = !daily ? '' : frac >= 1 ? ' — OVER: new sessions won\'t start today' : frac >= 0.8 ? ' — WARNING: near today\'s limit' : '';
  out.push('', `Budget ${s.budget.day}: ${money(spent)} of ${money(daily)} on this Mac (${daily ? Math.round(frac * 100) : 0}%), sessions capped at ${money(cap)}${level}`);
  return out.join('\n');
}
