// Typed peer messages (D-24; coordination.md §3; protocol.md §4). No free-form channel: every message
// has a kind, short capped text, and a recorded sender and recipient. The server stores and logs it;
// the recipient's harnessd delivers it at a safe boundary (D-26).
import { randomUUID } from 'node:crypto';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { normalizeScopePath } from './tasks.ts';

/** Kinds an agent or human may send in 0A. claim_conflict comes only from the harness itself; 0B adds contract_request and task_blocked. */
export const SENDABLE_KINDS = ['question', 'answer'];
/** The text cap (Q-05 proposal, the 0A default). */
export const TEXT_CAP = 500;
/** Peer messages per task, each way (Q-05 proposal, the 0A default). Harness notices don't count. */
export const BUDGET = { sent: 10, received: 10 };
const DELIVERY_POINTS = ['between_tools', 'new_turn', 'stop_hook'];
const MAX_ABOUT_PATHS = 20;

export const newMessageId = () => `msg_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

/** The agent's task in progress, if any. An agent works on at most one task at a time in 0A. */
export async function activeTaskOf(ctx: HandlerContext, principal: string): Promise<string | null> {
  if (!principal.startsWith('agent_')) return null;
  const r = await ctx.tx.query<{ id: string }>(
    "SELECT id FROM tasks WHERE project_id = $1 AND assignee_agent_id = $2 AND status = 'in_progress' ORDER BY created_at DESC LIMIT 1", [ctx.projectId, principal]);
  return r.rows[0]?.id ?? null;
}

/** An agent in this project, by id or by name (`agent/frontend`). */
async function resolveAgent(ctx: HandlerContext, ref: unknown): Promise<string> {
  if (typeof ref !== 'string' || !ref || ref.length > 100) throw new CommandError('bad_request', '`to` must name an agent, like agent/frontend');
  const r = await ctx.tx.query<{ id: string }>('SELECT id FROM agent_principals WHERE project_id = $1 AND (id = $2 OR name = $2)', [ctx.projectId, ref]);
  if (!r.rows[0]) throw new CommandError('not_found', `no agent ${ref} in this project`);
  return r.rows[0].id;
}

/** `message.send { kind: question | answer, to?, in_reply_to?, text, about_paths? }` → `message.sent`. */
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
  if (kind === 'question') {
    to = await resolveAgent(ctx, args.to);
    if (to === from) throw new CommandError('bad_request', 'an agent cannot ask itself');
  } else {
    if (typeof args.in_reply_to !== 'string') throw new CommandError('bad_request', 'an answer needs in_reply_to: the question id');
    const q = (await ctx.tx.query<{ kind: string; from_principal: string; to_principal: string | null }>(
      'SELECT kind, from_principal, to_principal FROM messages WHERE id = $1 AND project_id = $2 FOR UPDATE', [args.in_reply_to, ctx.projectId])).rows[0];
    if (!q || q.kind !== 'question') throw new CommandError('not_found', `no question ${args.in_reply_to}`);
    if (q.to_principal !== from) throw new CommandError('forbidden', `question ${args.in_reply_to} wasn't asked of you`);
    const answered = await ctx.tx.query("SELECT 1 FROM messages WHERE in_reply_to = $1 AND kind = 'answer'", [args.in_reply_to]);
    if (answered.rowCount) throw new CommandError('conflict', `question ${args.in_reply_to} already has an answer`);
    to = q.from_principal;
    inReplyTo = args.in_reply_to;
  }

  const id = newMessageId();
  const fromTask = await activeTaskOf(ctx, from);
  const toTask = await activeTaskOf(ctx, to);
  const data = aboutPaths ? { about_paths: aboutPaths } : {};
  const events: HandlerOutput['events'] = [];
  // Budgets (D-24, Q-05): per task, sent by the sender's task and received by the recipient's.
  const over = await overBudget(ctx, fromTask, toTask);
  for (const o of over) events.push({ kind: 'budget.exceeded', data: { task_id: o.task, direction: o.direction, limit: BUDGET[o.direction], message_id: id } });
  const held = over.length > 0;
  if (!held) await countMessage(ctx, fromTask, toTask);
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
