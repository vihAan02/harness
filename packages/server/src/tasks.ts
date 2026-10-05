// The task lifecycle (D-54; protocol.md §4). Humans write and assign tasks (D-08, principle 9); the
// assignee agent or a human marks one done. open → in_progress (assigned) → done → landed (0B), or abandoned.
import { claimScope, clearTaskClaims } from './claims.ts';
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

async function requireAgent(ctx: HandlerContext, agentId: unknown): Promise<string> {
  if (typeof agentId !== 'string') throw new CommandError('bad_request', 'assignee_agent_id is required');
  const found = await ctx.tx.query('SELECT 1 FROM agent_principals WHERE id = $1 AND project_id = $2', [agentId, ctx.projectId]);
  if (!found.rowCount) throw new CommandError('not_found', `no agent ${agentId} in this project`);
  return agentId;
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

export type TaskRow = { id: string; status: string; assignee_agent_id: string | null; owner_human_id: string; scope: string[]; title: string };

export async function lockTask(ctx: HandlerContext, taskId: unknown): Promise<TaskRow> {
  if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) throw new CommandError('bad_request', 'task_id is missing or malformed');
  const row = (await ctx.tx.query<TaskRow>(
    'SELECT id, status, assignee_agent_id, owner_human_id, scope, title FROM tasks WHERE id = $1 AND project_id = $2 FOR NO KEY UPDATE', [taskId, ctx.projectId])).rows[0];
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
  const assignee = args.assignee_agent_id === undefined ? null : await requireAgent(ctx, args.assignee_agent_id);
  if (assignee) await requireFree(ctx, assignee);
  const id = `T-${(await ctx.tx.query<{ n: string }>("SELECT nextval('task_numbers') AS n")).rows[0]!.n}`;
  await ctx.tx.query(
    `INSERT INTO tasks (id, project_id, title, text, scope, priority, owner_human_id, assignee_agent_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, ctx.projectId, title, body, scope, priority, ctx.caller.principal, assignee, assignee ? 'in_progress' : 'open']);
  const events: HandlerOutput['events'] = [
    { kind: 'task.created', data: { task_id: id, title, text: body, scope, priority, owner_human_id: ctx.caller.principal } },
  ];
  if (assignee) events.push({ kind: 'task.assigned', data: { task_id: id, assignee_agent_id: assignee } });
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
  if (task.status !== 'open') throw new CommandError('conflict', `${task.id} is ${task.status}; only open tasks can be assigned in 0A`);
  await requireFree(ctx, agent);
  await ctx.tx.query("UPDATE tasks SET assignee_agent_id = $2, status = 'in_progress' WHERE id = $1", [task.id, agent]);
  return { result: null, events: [{ kind: 'task.assigned', data: { task_id: task.id, assignee_agent_id: agent } }] };
}

/** `task.complete { task_id, summary? }` → `task.completed`. From the assignee's `report_done`, or a human (D-54). */
export async function completeTask(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const task = await lockTask(ctx, args.task_id);
  const summary = text(args.summary, 'summary', 500, true);
  if (ctx.actor.onBehalfOf && task.assignee_agent_id !== ctx.actor.principal) throw new CommandError('forbidden', `${task.id} isn't assigned to this agent`);
  if (task.status !== 'in_progress' && task.status !== 'open') throw new CommandError('conflict', `${task.id} is already ${task.status}`);
  await ctx.tx.query("UPDATE tasks SET status = 'done', summary = $2, completed_at = now() WHERE id = $1", [task.id, summary ?? null]);
  return {
    result: null,
    events: [{ kind: 'task.completed', data: { task_id: task.id, ...(summary ? { summary } : {}), by: ctx.actor.principal } }, ...await clearTaskClaims(ctx, task.id)],
  };
}

/** `task.abandon { task_id, reason }` → `task.abandoned`, and its leases released (D-97). Humans only. */
export async function abandonTask(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  requireHuman(ctx, 'abandon tasks');
  await lockLeases(ctx); // before the task's row lock: one lock order for lease writers (D-97)
  const task = await lockTask(ctx, args.task_id);
  const reason = text(args.reason, 'reason', 500)!;
  if (task.status === 'landed' || task.status === 'abandoned') throw new CommandError('conflict', `${task.id} is already ${task.status}`);
  const landing = (await ctx.tx.query("SELECT id FROM lands WHERE task_id = $1 AND status IN ('requested', 'accepted')", [task.id])).rows[0];
  if (landing) throw new CommandError('conflict', `${task.id} is being landed; cancel the land first (harness land --cancel ${task.id})`);
  await ctx.tx.query("UPDATE tasks SET status = 'abandoned', completed_at = now() WHERE id = $1", [task.id]);
  return { result: null, events: [{ kind: 'task.abandoned', data: { task_id: task.id, reason } }, ...await clearTaskClaims(ctx, task.id), ...await releaseAbandoned(ctx, task.id)] };
}
