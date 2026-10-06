// wait_for (0B item 4; D-27, D-95; protocol.md §3/§4). An agent waits for one thing: the answer to a
// question it asked, another task finishing, or a lease freeing up, always with a timeout. Every wait
// ends in exactly one outcome:
//  - resolved: what it waited for happened (checked at once when the wait starts, then by the sweep);
//  - timed_out: the timeout passed first, and the task's owner gets a task_blocked message;
//  - cancelled: the waiting task ended (done, landed or abandoned) first.
// The sweep resolves waits from current state, so no other command has to know about waits. harnessd
// pushes the outcome to the waiter as a new turn (D-95).
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { inTransaction, serverClock } from './db.ts';
import { appendEvents, notifyProject, type NewEvent } from './events.ts';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { lockLeases } from './leases.ts';
import { ANSWERABLE_KINDS, newMessageId } from './messages.ts';
import { requireAgentOnDevice } from './sessions.ts';

export const WAIT_KINDS = ['answer', 'task', 'lease'] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];
const TIMEOUT = { min: 10, max: 3600, default: 600 };
const ACTIVE = ['in_progress', 'blocked'];
const ID = /^[A-Za-z0-9_-]{1,64}$/;

type WaitRow = { id: string; project_id: string; task_id: string; agent_id: string; on_kind: WaitKind; on_id: string; timed_out: boolean; task_status: string };

/**
 * What a wait is waiting for, if it has happened: the result to hand the waiter, else null. For a lease, the
 * caller holds the lease lock, so its expiry is judged as the lease commands judge it (D-97).
 */
async function happened(tx: pg.ClientBase, projectId: string, kind: WaitKind, id: string): Promise<Record<string, unknown> | null> {
  if (kind === 'answer') {
    const a = (await tx.query<{ id: string }>(
      "SELECT id FROM messages WHERE project_id = $1 AND kind = 'answer' AND in_reply_to = $2 ORDER BY created_at LIMIT 1", [projectId, id])).rows[0];
    return a ? { answer_id: a.id } : null;
  }
  if (kind === 'task') {
    const t = (await tx.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1 AND project_id = $2', [id, projectId])).rows[0];
    return t && ['done', 'landed', 'abandoned'].includes(t.status) ? { status: t.status } : null;
  }
  const l = (await tx.query<{ released: boolean; expired: boolean }>(
    'SELECT released_at IS NOT NULL AS released, expires_at <= $3::timestamptz AS expired FROM leases WHERE id = $1 AND project_id = $2',
    [id, projectId, await serverClock(tx)])).rows[0];
  if (!l) return null;
  return l.released ? { lease: 'released' } : l.expired ? { lease: 'expired' } : null;
}

/** Settles one open wait if it can be settled now. Returns its events (none if it's still waiting). */
async function settle(tx: pg.ClientBase, w: WaitRow): Promise<NewEvent[]> {
  const on = { kind: w.on_kind, id: w.on_id };
  const base = { wait_id: w.id, task_id: w.task_id, agent_id: w.agent_id, on };
  const finish = (outcome: string, result: Record<string, unknown> | null) =>
    tx.query('UPDATE waits SET outcome = $2, result = $3, finished_at = now() WHERE id = $1', [w.id, outcome, result ? JSON.stringify(result) : null]);
  if (!ACTIVE.includes(w.task_status)) {
    await finish('cancelled', null);
    return [{ kind: 'wait.cancelled', actor: 'harness', data: { ...base, reason: `task_${w.task_status}` } }];
  }
  const result = await happened(tx, w.project_id, w.on_kind, w.on_id);
  if (result) {
    await finish('resolved', result);
    return [{ kind: 'wait.resolved', actor: 'harness', data: { ...base, result } }];
  }
  if (!w.timed_out) return [];
  await finish('timed_out', null);
  // The human hears that the agent gave up waiting (coordination.md §5): a task_blocked to the task's owner.
  const task = (await tx.query<{ owner_human_id: string }>('SELECT owner_human_id FROM tasks WHERE id = $1', [w.task_id])).rows[0]!;
  const id = newMessageId();
  const text = `${w.task_id}'s agent stopped waiting for ${on.kind} ${on.id}: it didn't happen before the timeout. It carries on without it; check on it with harness status.`;
  const data = { reason: 'wait_timed_out', task: w.task_id, wait_id: w.id, on };
  await tx.query(
    `INSERT INTO messages (id, project_id, kind, from_principal, to_principal, text, data, priority, from_task_id, to_task_id)
     VALUES ($1, $2, 'task_blocked', 'harness', $3, $4, $5, 'high', NULL, $6)`,
    [id, w.project_id, task.owner_human_id, text, JSON.stringify(data), w.task_id]);
  return [
    { kind: 'wait.timed_out', actor: 'harness', data: base },
    { kind: 'message.sent', actor: 'harness', data: { message_id: id, kind: 'task_blocked', from: 'harness', to: task.owner_human_id, text, ...data, priority: 'high', from_task_id: null, to_task_id: w.task_id } },
  ];
}

const OPEN_WAITS = `SELECT w.id, w.project_id, w.task_id, w.agent_id, w.on_kind, w.on_id, w.timeout_at <= now() AS timed_out, t.status AS task_status
  FROM waits w JOIN tasks t ON t.id = w.task_id WHERE w.outcome IS NULL`;

/** `wait.start { session_id, on: { kind: answer | task | lease, id }, timeout_s? }` → `{ wait_id, outcome, result? }` (D-95). */
export async function startWait(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const { agentId, deviceId } = requireAgentOnDevice(ctx);
  const on = args.on as { kind?: unknown; id?: unknown } | undefined;
  if (typeof on?.kind !== 'string' || !(WAIT_KINDS as readonly string[]).includes(on.kind)) throw new CommandError('bad_request', `on.kind must be one of ${WAIT_KINDS.join(', ')}`);
  if (typeof on.id !== 'string' || !ID.test(on.id)) throw new CommandError('bad_request', 'on.id is missing or malformed');
  const kind = on.kind as WaitKind;
  if (kind === 'lease') await lockLeases(ctx); // before any row lock (D-97); see happened()
  const timeout = args.timeout_s === undefined ? TIMEOUT.default : args.timeout_s;
  if (!Number.isInteger(timeout) || (timeout as number) < TIMEOUT.min || (timeout as number) > TIMEOUT.max) {
    throw new CommandError('bad_request', `timeout_s must be a whole number of seconds from ${TIMEOUT.min} to ${TIMEOUT.max}`);
  }
  const sess = (await ctx.tx.query<{ task_id: string; agent_id: string; device_id: string }>(
    'SELECT s.task_id, s.agent_id, s.device_id FROM agent_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = $1 AND t.project_id = $2',
    [args.session_id, ctx.projectId])).rows[0];
  if (!sess) throw new CommandError('not_found', `no session ${String(args.session_id)} in this project`);
  if (sess.agent_id !== agentId || sess.device_id !== deviceId) throw new CommandError('forbidden', 'that session belongs to another agent or device');
  // One wait at a time per task: serialize on the task row.
  const task = (await ctx.tx.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1 FOR NO KEY UPDATE', [sess.task_id])).rows[0]!;
  if (!ACTIVE.includes(task.status)) throw new CommandError('conflict', `${sess.task_id} is ${task.status}; only an active task waits`);

  // What it waits on must exist, and be something it can wait for.
  if (kind === 'answer') {
    const q = (await ctx.tx.query<{ from_principal: string; kind: string }>('SELECT from_principal, kind FROM messages WHERE id = $1 AND project_id = $2', [on.id, ctx.projectId])).rows[0];
    // A contract request is answered like a question (D-105).
    if (!q || !ANSWERABLE_KINDS.includes(q.kind)) throw new CommandError('not_found', `no question or contract request ${on.id}`);
    if (q.from_principal !== agentId) throw new CommandError('forbidden', `${on.id} wasn't asked by you`);
  } else if (kind === 'task') {
    if (on.id === sess.task_id) throw new CommandError('bad_request', 'a task cannot wait for itself');
    if (!(await ctx.tx.query('SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [on.id, ctx.projectId])).rowCount) throw new CommandError('not_found', `no task ${on.id}`);
  } else if (!(await ctx.tx.query('SELECT 1 FROM leases WHERE id = $1 AND project_id = $2', [on.id, ctx.projectId])).rowCount) {
    throw new CommandError('not_found', `no lease ${on.id}`);
  }
  const open = (await ctx.tx.query<{ id: string; on_kind: string; on_id: string }>('SELECT id, on_kind, on_id FROM waits WHERE task_id = $1 AND outcome IS NULL', [sess.task_id])).rows[0];
  if (open) throw new CommandError('conflict', `${sess.task_id} is already waiting for ${open.on_kind} ${open.on_id} (${open.id}); one wait at a time`);

  const id = `wait_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const timeoutAt = (await ctx.tx.query<{ at: Date }>(
    `INSERT INTO waits (id, project_id, task_id, session_id, agent_id, on_kind, on_id, timeout_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8)) RETURNING timeout_at AS at`,
    [id, ctx.projectId, sess.task_id, args.session_id, agentId, kind, on.id, timeout])).rows[0]!.at;
  const events: HandlerOutput['events'] = [{
    kind: 'wait.started', data: { wait_id: id, task_id: sess.task_id, session_id: args.session_id, agent_id: agentId, on: { kind, id: on.id }, timeout_at: timeoutAt.toISOString() },
  }];
  // Already happened: resolved at once, in the same transaction.
  const row = (await ctx.tx.query<WaitRow>(`${OPEN_WAITS} AND w.id = $1`, [id])).rows[0]!;
  const settled = await settle(ctx.tx, row);
  events.push(...settled.map((e) => ({ kind: e.kind, data: e.data })));
  const done = (await ctx.tx.query<{ outcome: string | null; result: unknown }>('SELECT outcome, result FROM waits WHERE id = $1', [id])).rows[0]!;
  return { result: { wait_id: id, outcome: done.outcome ?? 'waiting', ...(done.result ? { result: done.result } : {}) }, events };
}

/**
 * The sweep (every second or so): settles every open wait that can be settled now. Each in its own
 * transaction, under the wait's row lock, skipping one another process holds, so two servers never
 * settle the same wait twice. A wait for a lease takes the project's lease lock first (D-97).
 */
export async function sweepWaits(pool: pg.Pool): Promise<number> {
  const open = (await pool.query<{ id: string; project_id: string; on_kind: WaitKind }>('SELECT id, project_id, on_kind FROM waits WHERE outcome IS NULL ORDER BY created_at')).rows;
  let settled = 0;
  for (const w of open) {
    await inTransaction(pool, async (tx) => {
      if (w.on_kind === 'lease') await lockLeases({ tx, projectId: w.project_id } as HandlerContext);
      const row = (await tx.query<WaitRow>(`${OPEN_WAITS} AND w.id = $1 FOR UPDATE OF w SKIP LOCKED`, [w.id])).rows[0];
      if (!row) return; // settled meanwhile, or another sweep has it
      const events = await settle(tx, row);
      if (!events.length) return;
      await appendEvents(tx, w.project_id, events);
      await notifyProject(tx, w.project_id);
      settled++;
    });
  }
  return settled;
}
