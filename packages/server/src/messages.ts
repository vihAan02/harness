// Typed peer messages (D-24; coordination.md §3; protocol.md §4). No free-form channel: every message
// has a kind, short capped text, and a recorded sender and recipient. The server stores and logs it;
// the recipient's harnessd delivers it at a safe boundary (D-26).
import { randomUUID } from 'node:crypto';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';

/** Kinds an agent or human may send in 0A. claim_conflict comes only from the harness itself; 0B adds contract_request and task_blocked. */
export const SENDABLE_KINDS = ['question', 'answer'];
/** The text cap (Q-05 proposal, the 0A default). */
export const TEXT_CAP = 500;
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
    if (!Array.isArray(args.about_paths) || args.about_paths.length > MAX_ABOUT_PATHS || !args.about_paths.every((p) => typeof p === 'string' && p.length > 0 && p.length <= 500)) {
      throw new CommandError('bad_request', `about_paths must be up to ${MAX_ABOUT_PATHS} paths`);
    }
    aboutPaths = args.about_paths as string[];
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
  await ctx.tx.query(
    `INSERT INTO messages (id, project_id, kind, from_principal, to_principal, in_reply_to, text, data, priority, from_task_id, to_task_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'normal', $9, $10)`,
    [id, ctx.projectId, kind, from, to, inReplyTo, text, JSON.stringify(data), fromTask, toTask]);
  return {
    result: { message_id: id },
    events: [{
      kind: 'message.sent',
      data: { message_id: id, kind, from, to, ...(inReplyTo ? { in_reply_to: inReplyTo } : {}), text, ...data, priority: 'normal', from_task_id: fromTask, to_task_id: toTask },
    }],
  };
}
