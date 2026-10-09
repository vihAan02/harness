// The task lifecycle (D-54; protocol.md §4). Humans write and assign tasks (D-08, principle 9); the
// assignee agent or a human marks one done. open → in_progress (assigned) → done → landed (0B), or abandoned.
// For the pilot, only the task's owner or its agent's human acts on it, and with device keys each lifecycle
// command carries a signed dispatch whose event names the one device that acts (D-112, D-113; protocol.md §11).
import { DISPATCH_KINDS, isNonce } from '@harness/protocol/signing';
import type { DispatchKind } from '@harness/protocol';
import { claimScope, clearTaskClaims } from './claims.ts';
import { checkDispatch, dispatchRequired, loadAgent, type DispatchAgent } from './dispatches.ts';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { lockLeases, releaseAbandoned } from './leases.ts';

export const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/; // T-1, T-2, … from task.create
const MAX_TITLE = 200;
const MAX_TEXT = 8000;
const MAX_SCOPE = 50;

/**
 * A scope entry is a folder prefix (`src/api/`, also written `src/api/**`) or an exact file (D-21).
 * Repo-relative and normalized; no globs beyond a trailing `/**` (coordination §1).
 */
export function normalizeScopePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new CommandError('bad_request', 'scope entries must be strings');
  let p = raw.trim();
  if (p.endsWith('/**')) p = p.slice(0, -2);
  if (!p || p.length > 500 || p.startsWith('/') || /[*?[\]{}\\\u0000-\u001f\u007f]/.test(p)) throw new CommandError('bad_request', `bad scope entry ${JSON.stringify(raw)}: use a folder like src/api/ or a file like src/types.ts`);
  const parts = p.split('/');
  const folder = p.endsWith('/');
  if (folder) parts.pop();
  if (parts.some((s) => s === '' || s === '.' || s === '..')) throw new CommandError('bad_request', `bad scope entry ${JSON.stringify(raw)}: not a normalized relative path`);
  return parts.join('/') + (folder ? '/' : '');
}

function text(v: unknown, name: string, max: number, optional = false): string | undefined {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw new CommandError('bad_request', `${name} must be 1 to ${max} characters`);
  return v.trim();
}

function requireHuman(ctx: HandlerContext, what: string): void {
  if (ctx.actor.onBehalfOf) throw new CommandError('forbidden', `agents cannot ${what}; task decomposition stays human-led (principle 9)`);
}

async function requireAgent(ctx: HandlerContext, agentId: unknown): Promise<DispatchAgent> {
  if (typeof agentId !== 'string') throw new CommandError('bad_request', 'assignee_agent_id is required');
  return loadAgent(ctx, agentId);
}

/** Only the task's owner or the agent's accountable human acts on a task (D-112). An agent acts for its own human. */
function requireAuthority(ctx: HandlerContext, task: TaskRow, agent: DispatchAgent | null, what: string): void {
  if (ctx.caller.principal === task.owner_human_id || (agent && ctx.caller.principal === agent.accountable_human_id)) return;
  throw new CommandError('forbidden', `only ${task.id}'s owner or its agent's human can ${what} it`);
}

/**
 * An agent works on one task at a time: messages, budgets and its config dir all assume it (D-80). So a
 * task can't be given to an agent that has one in progress or blocked.
 */
async function requireFree(ctx: HandlerContext, agentId: string): Promise<void> {
  // Two concurrent assignments to one agent serialize here, so both can't see it free (write skew).
  await ctx.tx.query('SELECT id FROM agent_principals WHERE id = $1 FOR NO KEY UPDATE', [agentId]);
  const busy = (await ctx.tx.query<{ id: string }>(
    "SELECT id FROM tasks WHERE project_id = $1 AND assignee_agent_id = $2 AND status IN ('in_progress', 'blocked') LIMIT 1", [ctx.projectId, agentId])).rows[0];
  if (busy) throw new CommandError('conflict', `that agent is already working on ${busy.id}; finish or abandon it first`);
}

export type TaskRow = { id: string; status: string; assignee_agent_id: string | null; owner_human_id: string; scope: string[]; title: string; text: string };

export async function lockTask(ctx: HandlerContext, taskId: unknown): Promise<TaskRow> {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new CommandError('bad_request', 'task_id is missing or malformed');
  const row = (await ctx.tx.query<TaskRow>(
    'SELECT id, status, assignee_agent_id, owner_human_id, scope, title, text FROM tasks WHERE id = $1 AND project_id = $2 FOR NO KEY UPDATE', [taskId, ctx.projectId])).rows[0];
  if (!row) throw new CommandError('not_found', `no task ${taskId} in this project`);
  return row;
}

/** `task.create { title, text, scope[], assignee_agent_id?, priority? }` → `task.created` (+ `task.assigned`). */
export async function createTask(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  requireHuman(ctx, 'create tasks');
  const title = text(args.title, 'title', MAX_TITLE)!;
  const body = text(args.text, 'text', MAX_TEXT)!;
  if (!Array.isArray(args.scope) || args.scope.length > MAX_SCOPE) throw new CommandError('bad_request', `scope must be a list of up to ${MAX_SCOPE} paths`);
  const scope = [...new Set(args.scope.map(normalizeScopePath))];
  const priority = args.priority ?? 0;
  if (!Number.isSafeInteger(priority) || (priority as number) < 0 || (priority as number) > 100) throw new CommandError('bad_request', 'priority must be 0 to 100');
  const agent = args.assignee_agent_id === undefined ? null : await requireAgent(ctx, args.assignee_agent_id);
  // A start dispatch names its task, and the server picks the id: with dispatches, create first, then assign.
  if (agent && (args.dispatch !== undefined || await dispatchRequired(ctx))) {
    throw new CommandError('bad_request', 'with signed dispatch, create the task without an assignee, then assign it (task.assign with a start dispatch)');
  }
  const assignee = agent?.id ?? null;
  if (assignee) await requireFree(ctx, assignee);
  const id = `T-${(await ctx.tx.query<{ n: string }>("SELECT nextval('task_numbers') AS n")).rows[0]!.n}`;
  await ctx.tx.query(
    `INSERT INTO tasks (id, project_id, title, text, scope, priority, owner_human_id, assignee_agent_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, ctx.projectId, title, body, scope, priority, ctx.caller.principal, assignee, assignee ? 'in_progress' : 'open']);
  const events: HandlerOutput['events'] = [
    { kind: 'task.created', data: { task_id: id, title, text: body, scope, priority, owner_human_id: ctx.caller.principal } },
  ];
  if (agent) events.push({ kind: 'task.assigned', data: { task_id: id, assignee_agent_id: agent.id, ...(agent.device_id ? { target_device_id: agent.device_id } : {}) } });
  // Prospective claims, and any overlap of this scope with other tasks' claims, for the human to fix now (coordination §1).
  const claimed = await claimScope(ctx, id, scope);
  events.push(...claimed.events);
  return { result: { task_id: id, overlaps: claimed.overlaps }, events };
}

/** `task.assign { task_id, assignee_agent_id }` → `task.assigned`. harnessd on the assignee's device starts a session (D-54). */
export async function assignTask(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  requireHuman(ctx, 'assign tasks');
  const task = await lockTask(ctx, args.task_id);
  const agent = await requireAgent(ctx, args.assignee_agent_id);
  requireAuthority(ctx, task, agent, 'assign');
  if (task.status !== 'open') throw new CommandError('conflict', `${task.id} is ${task.status}; only open tasks can be assigned in 0A`);
  await requireFree(ctx, agent.id);
  const routed = await checkDispatch(ctx, args.dispatch, { kind: 'start', task, agent });
  await ctx.tx.query("UPDATE tasks SET assignee_agent_id = $2, status = 'in_progress' WHERE id = $1", [task.id, agent.id]);
  return { result: null, events: [{ kind: 'task.assigned', data: { task_id: task.id, assignee_agent_id: agent.id, ...routed } }] };
}

/** `task.complete { task_id, summary? }` → `task.completed`. From the assignee's `report_done`, or a human (D-54). */
export async function completeTask(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const task = await lockTask(ctx, args.task_id);
  const summary = text(args.summary, 'summary', 500, true);
  if (ctx.actor.onBehalfOf && task.assignee_agent_id !== ctx.actor.principal) throw new CommandError('forbidden', `${task.id} isn't assigned to this agent`);
  const agent = task.assignee_agent_id ? await loadAgent(ctx, task.assignee_agent_id) : null;
  requireAuthority(ctx, task, agent, 'complete');
  if (task.status !== 'in_progress' && task.status !== 'open') throw new CommandError('conflict', `${task.id} is already ${task.status}`);
  // The agent's own report_done comes from its device (harnessd); a human's complete is dispatched to that device.
  const routed = agent && !ctx.actor.onBehalfOf ? await checkDispatch(ctx, args.dispatch, { kind: 'complete', task, agent }) : {};
  await ctx.tx.query("UPDATE tasks SET status = 'done', summary = $2, completed_at = now() WHERE id = $1", [task.id, summary ?? null]);
  return {
    result: null,
    events: [{ kind: 'task.completed', data: { task_id: task.id, ...(summary ? { summary } : {}), by: ctx.actor.principal, ...routed } }, ...await clearTaskClaims(ctx, task.id)],
  };
}

/**
 * `task.reopen { task_id, text }` → `task.reopened`: a human sends a done task that hasn't landed back to its
 * agent, with a message (what a failed land said, say). harnessd starts a new session on the task's branch,
 * which has its work; the old conversation isn't resumed (that's Phase 1, D-40), so the message must say what
 * to fix (D-107). Not while a land of it is in flight, nor while its agent works on another task. Humans only.
 */
export async function reopenTask(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  requireHuman(ctx, 'reopen tasks');
  const task = await lockTask(ctx, args.task_id);
  const body = text(args.text, 'text', MAX_TEXT)!;
  if (task.status !== 'done') throw new CommandError('conflict', `${task.id} is ${task.status}; only a done task that hasn't landed can be reopened`);
  if (!task.assignee_agent_id) throw new CommandError('conflict', `${task.id} has no agent to reopen it to`);
  const agent = await loadAgent(ctx, task.assignee_agent_id);
  requireAuthority(ctx, task, agent, 'reopen');
  const landing = (await ctx.tx.query("SELECT id FROM lands WHERE task_id = $1 AND status IN ('requested', 'accepted')", [task.id])).rows[0];
  if (landing) throw new CommandError('conflict', `${task.id} is being landed; cancel the land first (harness land --cancel ${task.id})`);
  await requireFree(ctx, agent.id);
  const routed = await checkDispatch(ctx, args.dispatch, { kind: 'reopen', task, agent, message: body });
  await ctx.tx.query("UPDATE tasks SET status = 'in_progress', completed_at = NULL WHERE id = $1", [task.id]);
  // Its prospective claims again, as at creation: they were cleared when it was done (coordination §1).
  const claimed = await claimScope(ctx, task.id, task.scope);
  return {
    result: { overlaps: claimed.overlaps },
    events: [{ kind: 'task.reopened', data: { task_id: task.id, assignee_agent_id: agent.id, text: body, by: ctx.caller.principal, ...routed } }, ...claimed.events],
  };
}

/** `task.abandon { task_id, reason }` → `task.abandoned`, and its leases released (D-97). Humans only. */
export async function abandonTask(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  requireHuman(ctx, 'abandon tasks');
  await lockLeases(ctx); // before the task's row lock: one lock order for lease writers (D-97)
  const task = await lockTask(ctx, args.task_id);
  const reason = text(args.reason, 'reason', 500)!;
  const agent = task.assignee_agent_id ? await loadAgent(ctx, task.assignee_agent_id) : null;
  requireAuthority(ctx, task, agent, 'abandon');
  if (task.status === 'landed' || task.status === 'abandoned') throw new CommandError('conflict', `${task.id} is already ${task.status}`);
  const landing = (await ctx.tx.query("SELECT id FROM lands WHERE task_id = $1 AND status IN ('requested', 'accepted')", [task.id])).rows[0];
  if (landing) throw new CommandError('conflict', `${task.id} is being landed; cancel the land first (harness land --cancel ${task.id})`);
  // An unassigned task has no agent or device to dispatch to.
  const routed = agent ? await checkDispatch(ctx, args.dispatch, { kind: 'abandon', task, agent }) : {};
  await ctx.tx.query("UPDATE tasks SET status = 'abandoned', completed_at = now() WHERE id = $1", [task.id]);
  return { result: null, events: [{ kind: 'task.abandoned', data: { task_id: task.id, reason, ...routed } }, ...await clearTaskClaims(ctx, task.id), ...await releaseAbandoned(ctx, task.id)] };
}

/**
 * `task.resume { task_id, text?, dispatch }` → `task.resumed`: a human restarts a stopped task, one in progress whose
 * session ended (a crash, a restart, a provider failure). harnessd on the agent's device starts a new session in the
 * preserved worktree, with a handoff and the optional message (D-113).
 */
export async function resumeTask(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  requireHuman(ctx, 'resume tasks');
  const task = await lockTask(ctx, args.task_id);
  const body = text(args.text, 'text', MAX_TEXT, true);
  if (task.status !== 'in_progress') throw new CommandError('conflict', `${task.id} is ${task.status}; only a task in progress whose session ended can be resumed`);
  if (!task.assignee_agent_id) throw new CommandError('conflict', `${task.id} has no agent to resume it`);
  const agent = await loadAgent(ctx, task.assignee_agent_id);
  requireAuthority(ctx, task, agent, 'resume');
  const live = (await ctx.tx.query<{ id: string; device_id: string }>(
    "SELECT id, device_id FROM agent_sessions WHERE task_id = $1 AND status <> 'ended' LIMIT 1", [task.id])).rows[0];
  if (live) throw new CommandError('conflict', `live_session_exists: ${live.id} on ${live.device_id}`);
  const routed = await checkDispatch(ctx, args.dispatch, { kind: 'resume', task, agent, ...(body === undefined ? {} : { message: body }) });
  return {
    result: null,
    events: [{ kind: 'task.resumed', data: { task_id: task.id, assignee_agent_id: agent.id, ...(body === undefined ? {} : { text: body }), by: ctx.caller.principal, ...routed } }],
  };
}

const REJECT_REASONS = ['missing', 'malformed', 'policy_widening', 'unknown_issuer', 'issuer_mismatch', 'bad_signature', 'lifetime', 'not_yet_valid',
  'expired', 'wrong_kind', 'wrong_target', 'wrong_epoch', 'content_mismatch', 'replayed', 'approval_expired', 'approval_denied'];
const START_FAILED_REASONS = ['aborted', 'approval_expired', 'approval_denied', 'setup_failed', 'capacity', 'no_adapter', 'budget', 'error'];
/** Refusals that mean someone forged or replayed a dispatch, not just that it went stale. */
const ALERTS = ['bad_signature', 'content_mismatch', 'replayed'];

/** `dispatch.rejected { task_id, nonce?, kind?, reason, detail? }`: the target harnessd refused a lifecycle event's dispatch. */
export function rejectDispatch(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  return settleDispatch(ctx, args, 'rejected');
}

/** `task.start_failed { task_id, nonce, reason, detail? }`: a start, reopen or resume ended before a session began. */
export function startFailed(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  return settleDispatch(ctx, args, 'start_failed');
}

/**
 * From the dispatch's target harnessd only, once per nonce. It frees the agent: a start's task goes back to open
 * and unassigned, a reopen's back to done, and a resume's stays in progress with no session (stopped). A refusal
 * of a dispatch the server never accepted (a forged event, T-3) changes nothing here; both are logged.
 */
async function settleDispatch(ctx: HandlerContext, args: Record<string, unknown>, outcome: 'rejected' | 'start_failed'): Promise<HandlerOutput> {
  const deviceId = ctx.caller.deviceId;
  if (!deviceId) throw new CommandError('forbidden', 'only harnessd reports this, from the dispatch\'s target device');
  const reasons = outcome === 'rejected' ? REJECT_REASONS : START_FAILED_REASONS;
  if (typeof args.reason !== 'string' || !reasons.includes(args.reason)) throw new CommandError('bad_request', `reason must be one of ${reasons.join(', ')}`);
  const reason = args.reason;
  const detail = text(args.detail, 'detail', 500, true);
  const nonce = args.nonce;
  if (nonce !== undefined && !isNonce(nonce)) throw new CommandError('bad_request', 'nonce is malformed');
  if (outcome === 'start_failed' && nonce === undefined) throw new CommandError('bad_request', 'a failed start names its dispatch nonce');
  if (args.kind !== undefined && !DISPATCH_KINDS.includes(args.kind as DispatchKind)) throw new CommandError('bad_request', `kind must be one of ${DISPATCH_KINDS.join(', ')}`);
  const task = await lockTask(ctx, args.task_id);
  const eventKind = outcome === 'rejected' ? 'task.dispatch_rejected' : 'task.start_failed';
  const report = { task_id: task.id, ...(nonce === undefined ? {} : { nonce }), reason, ...(detail ? { detail } : {}), device_id: deviceId };
  const alert = outcome === 'rejected' && ALERTS.includes(reason) ? [{ kind: 'security.alert', data: { ...report, what: 'dispatch_rejected' } }] : [];
  const stored = nonce === undefined ? undefined : (await ctx.tx.query<{ kind: DispatchKind; task_id: string; target_device_id: string; agent_id: string; outcome: string | null }>(
    "SELECT kind, task_id, target_device_id, envelope ->> 'agent_id' AS agent_id, outcome FROM dispatches WHERE nonce = $1 AND project_id = $2 FOR UPDATE",
    [nonce, ctx.projectId])).rows[0];
  if (!stored) {
    if (outcome === 'start_failed') throw new CommandError('not_found', `no dispatch ${String(nonce)} was accepted for ${task.id}`);
    // Nothing the server accepted to undo: only the agent's own device may say so, for the humans to see.
    const agent = task.assignee_agent_id ? await loadAgent(ctx, task.assignee_agent_id) : null;
    const ownDevice = agent && (agent.device_id ? agent.device_id === deviceId : agent.accountable_human_id === ctx.caller.principal);
    if (!ownDevice) throw new CommandError('forbidden', `only ${task.id}'s agent's device reports on its dispatches`);
    return { result: { status: task.status }, events: [{ kind: eventKind, data: { ...report, ...(args.kind ? { kind: args.kind } : {}) } }, ...alert] };
  }
  if (stored.task_id !== task.id) throw new CommandError('bad_request', `dispatch ${String(nonce)} is for ${stored.task_id}, not ${task.id}`);
  if (stored.target_device_id !== deviceId) throw new CommandError('forbidden', `dispatch ${String(nonce)} targets ${stored.target_device_id}; only it reports on it`);
  if (stored.outcome) return { result: { status: task.status, duplicate: true }, events: [] };
  const starts = ['start', 'reopen', 'resume'];
  if (outcome === 'start_failed' && !starts.includes(stored.kind)) throw new CommandError('bad_request', `a ${stored.kind} dispatch doesn't start a session`);
  if (starts.includes(stored.kind)) {
    const live = (await ctx.tx.query<{ id: string }>("SELECT id FROM agent_sessions WHERE task_id = $1 AND status <> 'ended' LIMIT 1", [task.id])).rows[0];
    if (live) throw new CommandError('conflict', `session ${live.id} is live for ${task.id}; end it before reporting that the start failed`);
  }
  await ctx.tx.query('UPDATE dispatches SET outcome = $2, outcome_at = now() WHERE nonce = $1', [nonce, outcome]);
  const events: HandlerOutput['events'] = [];
  let status = task.status;
  if (stored.kind === 'start' && task.status === 'in_progress' && task.assignee_agent_id === stored.agent_id) {
    status = 'open';
    await ctx.tx.query("UPDATE tasks SET status = 'open', assignee_agent_id = NULL WHERE id = $1", [task.id]);
  } else if (stored.kind === 'reopen' && task.status === 'in_progress') {
    status = 'done';
    await ctx.tx.query("UPDATE tasks SET status = 'done', completed_at = now() WHERE id = $1", [task.id]);
    events.push(...await clearTaskClaims(ctx, task.id));
  }
  return { result: { status }, events: [{ kind: eventKind, data: { ...report, kind: stored.kind, status } }, ...alert, ...events] };
}
