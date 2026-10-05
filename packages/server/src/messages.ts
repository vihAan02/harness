// Typed peer messages (D-24; coordination.md §3; protocol.md §4). No free-form channel: every message
// has a kind, short capped text, and a recorded sender and recipient. The server stores and logs it;
// the recipient's harnessd delivers it at a safe boundary (D-26).
import { randomUUID } from 'node:crypto';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { normalizeScopePath } from './tasks.ts';

/**
 * Kinds an agent or human may send (D-24). claim_conflict and dependency_changed come only from the harness
 * itself. 0B adds contract_request (agent to agent, answered like a question) and task_blocked (an agent
 * reporting its own task blocked, to the task's owner) (D-105).
 */
export const SENDABLE_KINDS = ['question', 'answer', 'contract_request', 'task_blocked'];
/** What `answer` may reply to: each gets at most one answer. */
export const ANSWERABLE_KINDS = ['question', 'contract_request'];
/** What a task_blocked report may say it's blocked on (coordination.md §3). */
const BLOCKED_ON = ['agent', 'task', 'question'];
/** The text cap (Q-05 proposal, the 0A default). */
export const TEXT_CAP = 500;
/** Peer messages per task, each way (Q-05 proposal, the 0A default). Harness notices don't count. */
export const BUDGET = { sent: 10, received: 10 };
const DELIVERY_POINTS = ['between_tools', 'new_turn', 'stop_hook'];
const MAX_ABOUT_PATHS = 20;

export const newMessageId = () => `msg_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

/** The agent's active task (in progress, or blocked on a sync conflict), if any. An agent has at most one (tasks.ts). */
export async function activeTaskOf(ctx: HandlerContext, principal: string): Promise<string | null> {
  if (!principal.startsWith('agent_')) return null;
  const r = await ctx.tx.query<{ id: string }>(
    "SELECT id FROM tasks WHERE project_id = $1 AND assignee_agent_id = $2 AND status IN ('in_progress', 'blocked') ORDER BY created_at DESC LIMIT 1", [ctx.projectId, principal]);
  return r.rows[0]?.id ?? null;
}

/** An agent in this project, by id or by name (`agent/frontend`). */
async function resolveAgent(ctx: HandlerContext, ref: unknown): Promise<string> {
  if (typeof ref !== 'string' || !ref || ref.length > 100) throw new CommandError('bad_request', '`to` must name an agent, like agent/frontend');
  const r = await ctx.tx.query<{ id: string }>('SELECT id FROM agent_principals WHERE project_id = $1 AND (id = $2 OR name = $2)', [ctx.projectId, ref]);
  if (!r.rows[0]) throw new CommandError('not_found', `no agent ${ref} in this project`);
  return r.rows[0].id;
}

/**
 * `message.send { kind, to?, in_reply_to?, blocked_on?, text, about_paths? }` → `message.sent`.
 * - `question` and `contract_request`: `to` an agent, by name or id.
 * - `answer`: `in_reply_to` a question or contract request asked of the sender.
 * - `task_blocked`: from an agent about its own task; the server sends it to the task's owner (D-105).
 */
export async function sendMessage(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const from = ctx.actor.principal;
  const kind = args.kind;
  if (typeof kind !== 'string' || !SENDABLE_KINDS.includes(kind)) throw new CommandError('bad_request', `kind must be one of ${SENDABLE_KINDS.join(', ')} (D-24)`);
  const text = args.text;
  if (typeof text !== 'string' || !text.trim()) throw new CommandError('bad_request', 'text is required');
  if (text.length > TEXT_CAP) throw new CommandError('bad_request', `text is ${text.length} characters; the cap is ${TEXT_CAP} (Q-05)`);
  let aboutPaths: string[] | undefined;
  if (args.about_paths !== undefined) {
    if (!Array.isArray(args.about_paths) || args.about_paths.length > MAX_ABOUT_PATHS) throw new CommandError('bad_request', `about_paths must be up to ${MAX_ABOUT_PATHS} paths`);
    aboutPaths = args.about_paths.map(normalizeScopePath); // folders or files, repo-relative, no control characters
  }

  let to: string;
  let inReplyTo: string | null = null;
  const fromTask = await activeTaskOf(ctx, from);
  let toTask: string | null;
  let data: Record<string, unknown> = aboutPaths ? { about_paths: aboutPaths } : {};
  if (kind === 'question' || kind === 'contract_request') {
    to = await resolveAgent(ctx, args.to);
    if (to === from) throw new CommandError('bad_request', `an agent cannot send a ${kind} to itself`);
    toTask = await activeTaskOf(ctx, to);
  } else if (kind === 'answer') {
    if (typeof args.in_reply_to !== 'string') throw new CommandError('bad_request', 'an answer needs in_reply_to: the question or contract request id');
    const q = (await ctx.tx.query<{ kind: string; from_principal: string; to_principal: string | null }>(
      'SELECT kind, from_principal, to_principal FROM messages WHERE id = $1 AND project_id = $2 FOR UPDATE', [args.in_reply_to, ctx.projectId])).rows[0];
    if (!q || !ANSWERABLE_KINDS.includes(q.kind)) throw new CommandError('not_found', `no question or contract request ${args.in_reply_to}`);
    if (q.to_principal !== from) throw new CommandError('forbidden', `${q.kind === 'question' ? 'question' : 'contract request'} ${args.in_reply_to} wasn't sent to you`);
    const answered = await ctx.tx.query("SELECT 1 FROM messages WHERE in_reply_to = $1 AND kind = 'answer'", [args.in_reply_to]);
    if (answered.rowCount) throw new CommandError('conflict', `${args.in_reply_to} already has an answer`);
    to = q.from_principal;
    inReplyTo = args.in_reply_to;
    toTask = await activeTaskOf(ctx, to);
  } else {
    // task_blocked: an agent says its own task can't go on. Its human decides what happens next, so the
    // report goes to the task's owner, never to a peer (D-105; the harness's own task_blocked does the same).
    if (!fromTask) throw new CommandError('bad_request', 'task_blocked comes from an agent about the task it is working on');
    if (args.to !== undefined) throw new CommandError('bad_request', "task_blocked goes to the task's owner; leave `to` out");
    to = (await ctx.tx.query<{ owner_human_id: string }>('SELECT owner_human_id FROM tasks WHERE id = $1', [fromTask])).rows[0]!.owner_human_id;
    toTask = fromTask; // the task the report is about, as for the harness's own task_blocked
    data = { ...data, reason: 'agent_report', ...(args.blocked_on !== undefined ? { blocked_on: await blockedOn(ctx, args.blocked_on) } : {}) };
  }

  const id = newMessageId();
  const events: HandlerOutput['events'] = [];
  // Budgets (D-24, Q-05): per task, sent by the sender's task and received by the recipient's. A blocked
  // report counts only as sent: the task it's about is the sender's own.
  const receiver = kind === 'task_blocked' ? null : toTask;
  const over = await overBudget(ctx, fromTask, receiver);
  for (const o of over) events.push({ kind: 'budget.exceeded', data: { task_id: o.task, direction: o.direction, limit: BUDGET[o.direction], message_id: id } });
  const held = over.length > 0;
  if (!held) await countMessage(ctx, fromTask, receiver);
  await ctx.tx.query(
    `INSERT INTO messages (id, project_id, kind, from_principal, to_principal, in_reply_to, text, data, priority, from_task_id, to_task_id, held)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'normal', $9, $10, $11)`,
    [id, ctx.projectId, kind, from, to, inReplyTo, text, JSON.stringify(data), fromTask, toTask, held]);
  events.unshift({
    kind: 'message.sent',
    data: {
      message_id: id, kind, from, to, ...(inReplyTo ? { in_reply_to: inReplyTo } : {}), text, ...data, priority: 'normal',
      from_task_id: fromTask, to_task_id: toTask, ...(held ? { held: true } : {}),
    },
  });
  return { result: { message_id: id, ...(held ? { held: true } : {}) }, events };
}

/** `blocked_on: { kind: agent | task | question, id }`, checked against this project; agents are stored by id. */
async function blockedOn(ctx: HandlerContext, v: unknown): Promise<{ kind: string; id: string }> {
  const o = v as { kind?: unknown; id?: unknown } | null;
  if (!o || typeof o !== 'object' || typeof o.kind !== 'string' || !BLOCKED_ON.includes(o.kind) || typeof o.id !== 'string' || !o.id || o.id.length > 100) {
    throw new CommandError('bad_request', `blocked_on must be { kind: ${BLOCKED_ON.join(' | ')}, id }`);
  }
  if (o.kind === 'agent') return { kind: 'agent', id: await resolveAgent(ctx, o.id) };
  const found = o.kind === 'task'
    ? await ctx.tx.query('SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [o.id, ctx.projectId])
    : await ctx.tx.query('SELECT 1 FROM messages WHERE id = $1 AND project_id = $2 AND kind = ANY($3)', [o.id, ctx.projectId, ANSWERABLE_KINDS]);
  if (!found.rowCount) throw new CommandError('not_found', `no ${o.kind} ${o.id}`);
  return { kind: o.kind, id: o.id };
}

async function overBudget(ctx: HandlerContext, fromTask: string | null, toTask: string | null): Promise<{ task: string; direction: 'sent' | 'received' }[]> {
  const over: { task: string; direction: 'sent' | 'received' }[] = [];
  const counts = async (task: string) => (await ctx.tx.query<{ messages_sent: number; messages_received: number }>(
    'SELECT messages_sent, messages_received FROM budgets WHERE task_id = $1 FOR UPDATE', [task])).rows[0] ?? { messages_sent: 0, messages_received: 0 };
  if (fromTask && (await counts(fromTask)).messages_sent >= BUDGET.sent) over.push({ task: fromTask, direction: 'sent' });
  if (toTask && (await counts(toTask)).messages_received >= BUDGET.received) over.push({ task: toTask, direction: 'received' });
  return over;
}

async function countMessage(ctx: HandlerContext, fromTask: string | null, toTask: string | null): Promise<void> {
  if (fromTask) await ctx.tx.query('INSERT INTO budgets (task_id, messages_sent) VALUES ($1, 1) ON CONFLICT (task_id) DO UPDATE SET messages_sent = budgets.messages_sent + 1', [fromTask]);
  if (toTask) await ctx.tx.query('INSERT INTO budgets (task_id, messages_received) VALUES ($1, 1) ON CONFLICT (task_id) DO UPDATE SET messages_received = budgets.messages_received + 1', [toTask]);
}

/**
 * `message.ack { message_id, delivered_at, delivery, est_tokens }` → `message.delivered`. harnessd, for the
 * recipient agent, once the vendor confirms the message reached the model (D-26). Records where it landed
 * and how long it took, and adds its estimated tokens (characters ÷ 4) to the recipient task's
 * coordination-token count (Q-05: measured, not budgeted).
 */
export async function ackMessage(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  if (!ctx.caller.deviceId || !ctx.actor.onBehalfOf) throw new CommandError('forbidden', 'only harnessd acknowledges deliveries, for the recipient agent');
  const delivery = args.delivery;
  if (typeof delivery !== 'string' || !DELIVERY_POINTS.includes(delivery)) throw new CommandError('bad_request', `delivery must be one of ${DELIVERY_POINTS.join(', ')}`);
  const tokens = args.est_tokens;
  if (!Number.isSafeInteger(tokens) || (tokens as number) < 0 || (tokens as number) > 1_000_000) throw new CommandError('bad_request', 'est_tokens must be a non-negative integer');
  const at = typeof args.delivered_at === 'string' ? new Date(args.delivered_at) : null;
  if (!at || Number.isNaN(at.getTime())) throw new CommandError('bad_request', 'delivered_at must be an ISO timestamp');
  const m = (await ctx.tx.query<{ kind: string; to_principal: string | null; to_task_id: string | null; held: boolean; delivered_at: Date | null; created_at: Date; now: Date }>(
    'SELECT kind, to_principal, to_task_id, held, delivered_at, created_at, now() AS now FROM messages WHERE id = $1 AND project_id = $2 FOR UPDATE',
    [args.message_id, ctx.projectId])).rows[0];
  if (!m) throw new CommandError('not_found', `no message ${String(args.message_id)}`);
  if (m.to_principal !== ctx.actor.principal) throw new CommandError('forbidden', 'that message is for another agent');
  if (m.held) throw new CommandError('conflict', 'a held message is never delivered');
  if (m.delivered_at) return { result: { already: true }, events: [] };
  // One machine in 0A, so harnessd's clock and the server's agree closely; clamp to keep latency sane.
  const deliveredAt = new Date(Math.min(Math.max(at.getTime(), m.created_at.getTime()), m.now.getTime()));
  await ctx.tx.query('UPDATE messages SET delivered_at = $2, delivery = $3 WHERE id = $1', [args.message_id, deliveredAt, delivery]);
  if (m.to_task_id) {
    await ctx.tx.query('INSERT INTO budgets (task_id, coord_tokens_est) VALUES ($1, $2) ON CONFLICT (task_id) DO UPDATE SET coord_tokens_est = budgets.coord_tokens_est + $2', [m.to_task_id, tokens]);
  }
  return {
    result: null,
    events: [{
      kind: 'message.delivered',
      data: {
        message_id: args.message_id, kind: m.kind, to: m.to_principal, to_task_id: m.to_task_id, delivery,
        delivered_at: deliveredAt.toISOString(), latency_ms: deliveredAt.getTime() - m.created_at.getTime(), est_tokens: tokens,
      },
    }],
  };
}
