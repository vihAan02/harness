// Hard claims: lease commands (0B item 5; D-20, D-21, D-89; contract D-97, protocol.md §3/§4).
// A lease is a time-limited, exclusive claim on a path with a fencing token. Nothing here stops an edit:
// the land step's fencing check (lands.ts) is where a lease is enforced (D-20).
// - Acquire: first come, first served. A request overlapping another task's current lease is refused as a
//   whole; an agent hears why (claim_conflict), a human gets the conflicts back. A human's `force` revokes
//   the overlapping leases and grants newer tokens, unless one of their tasks is being landed.
// - Renew: harnessd only, for the device that ran the task; a lost lease is never revived.
// - Expiry is lazy (F-84): "current" is decided on the server's clock, read once per command under the lease
//   lock (D-97), and `lease.expired` is logged the first time a lease command sees one. A lease once seen
//   expired is never renewed.
// - A task re-claiming a path it holds keeps that lease and its token, and its own TTL unless a new one is
//   given; a re-claim never moves an expiry earlier. A task holds at most MAX_HELD current leases.
// - Every lease.renewed entry carries the lease's ttl_s, so harnessd can reschedule its renewals (D-97).
import { randomUUID } from 'node:crypto';
import { serverClock } from './db.ts';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { newMessageId } from './messages.ts';
import { requireAgentOnDevice } from './sessions.ts';
import { lockTask, normalizeScopePath } from './tasks.ts';
import { overlaps } from './claims.ts';

const MAX_PATHS = 50;
const MAX_IDS = 200;
/** Current leases one task may hold: one lease.renew can renew them all (MAX_IDS). */
export const MAX_HELD = 200;
export const TTL = { default: 120, min: 10, max: 3600 };
const LEASE_ID = /^ls_[0-9a-f]{16}$/;

type Events = HandlerOutput['events'];
type LeaseRow = {
  id: string; task_id: string; path: string; token: string; expires_at: Date; released_at: Date | null; release_reason: string | null;
  ttl_s: number; current: boolean; assignee_agent_id: string | null;
};

/**
 * The project's lease lock (D-97). Every command that grants, renews, releases or revokes leases takes it
 * first, before any row lock (`land.complete` takes it right after the invalidation lock), so first come,
 * first served holds even when no lease rows exist yet, and lease writers share one lock order.
 * Returns the server's clock read under the lock, as text (microseconds kept): the one time a command judges
 * expiry by. `now()` is the transaction's start, which can be earlier than another command that already saw
 * a lease expire (D-97, settled in the B5 review).
 */
export async function lockLeases(ctx: HandlerContext): Promise<string> {
  await ctx.tx.query("SELECT pg_advisory_xact_lock(hashtext('harness.leases:' || $1))", [ctx.projectId]);
  return serverClock(ctx.tx);
}

const iso = (d: Date) => d.toISOString();
const isAgent = (ctx: HandlerContext) => ctx.actor.onBehalfOf !== null;

function ttlOf(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (!Number.isInteger(v) || (v as number) < TTL.min || (v as number) > TTL.max) throw new CommandError('bad_request', `ttl_s must be a whole number from ${TTL.min} to ${TTL.max}`);
  return v as number;
}

function leaseIds(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || v.length > MAX_IDS || !v.every((x) => typeof x === 'string' && LEASE_ID.test(x))) {
    throw new CommandError('bad_request', `lease_ids must be a list of 1 to ${MAX_IDS} lease ids`);
  }
  return [...new Set(v as string[])];
}

/**
 * The project's leases, with whether each is current at `at` (the command's clock, from lockLeases), and its
 * task's agent. In `where`, $1 is the project and $2 is `at`; extra params start at $3. A lease already logged
 * as expired is never current again.
 */
async function projectLeases(ctx: HandlerContext, at: string, where = 'TRUE', params: unknown[] = []): Promise<LeaseRow[]> {
  return (await ctx.tx.query<LeaseRow>(
    `SELECT l.id, l.task_id, l.path, l.token, l.expires_at, l.released_at, l.release_reason, l.ttl_s,
            (l.released_at IS NULL AND l.expired_logged_at IS NULL AND l.expires_at > $2::timestamptz) AS current, t.assignee_agent_id
     FROM leases l JOIN tasks t ON t.id = l.task_id WHERE l.project_id = $1 AND (${where}) ORDER BY l.token`,
    [ctx.projectId, at, ...params])).rows;
}

/** Logs `lease.expired` for leases that ran out unnoticed: once each, the first time a lease command looks (D-97). */
async function noticeExpired(ctx: HandlerContext, at: string): Promise<Events> {
  const rows = (await ctx.tx.query<{ id: string; task_id: string }>(
    `UPDATE leases SET expired_logged_at = $2::timestamptz
     WHERE project_id = $1 AND released_at IS NULL AND expires_at <= $2::timestamptz AND expired_logged_at IS NULL RETURNING id, task_id`,
    [ctx.projectId, at])).rows;
  return rows.sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({ kind: 'lease.expired', data: { lease_id: r.id, task_id: r.task_id } }));
}

async function agentNames(ctx: HandlerContext): Promise<Map<string, string>> {
  return new Map((await ctx.tx.query<{ id: string; name: string }>('SELECT id, name FROM agent_principals WHERE project_id = $1', [ctx.projectId])).rows.map((r) => [r.id, r.name]));
}

/** A claim_conflict from the harness to an agent: a fact, not an instruction (F-10). */
async function tellAgent(ctx: HandlerContext, to: string, toTask: string, text: string, data: Record<string, unknown>): Promise<Events> {
  const id = newMessageId();
  await ctx.tx.query(
    `INSERT INTO messages (id, project_id, kind, from_principal, to_principal, text, data, priority, from_task_id, to_task_id)
     VALUES ($1, $2, 'claim_conflict', 'harness', $3, $4, $5, 'high', NULL, $6)`,
    [id, ctx.projectId, to, text, JSON.stringify(data), toTask]);
  return [{ kind: 'message.sent', data: { message_id: id, kind: 'claim_conflict', from: 'harness', to, text, ...data, priority: 'high', from_task_id: null, to_task_id: toTask } }];
}

const holderOf = (names: Map<string, string>, l: LeaseRow) => (l.assignee_agent_id ? `${names.get(l.assignee_agent_id) ?? l.assignee_agent_id} (task ${l.task_id})` : `task ${l.task_id}`);

/** Tasks with a land requested or accepted: a revoke or a release can't stop a land past its fencing check (D-97). */
async function landing(ctx: HandlerContext, taskIds: string[]): Promise<string[]> {
  if (!taskIds.length) return [];
  return (await ctx.tx.query<{ task_id: string }>(
    "SELECT DISTINCT task_id FROM lands WHERE project_id = $1 AND task_id = ANY($2) AND status IN ('requested', 'accepted') ORDER BY task_id", [ctx.projectId, taskIds])).rows.map((r) => r.task_id);
}

/** `lease.acquire { task_id, paths[], ttl_s?, force? }` → `{ granted[], conflicts[] }` (D-97). */
export async function acquireLease(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const at = await lockLeases(ctx); // first: see lockLeases
  const task = await lockTask(ctx, args.task_id);
  if (isAgent(ctx)) {
    requireAgentOnDevice(ctx);
    if (task.assignee_agent_id !== ctx.actor.principal) throw new CommandError('forbidden', `${task.id} is not your task`);
  }
  const force = args.force === undefined ? false : args.force;
  if (typeof force !== 'boolean') throw new CommandError('bad_request', 'force must be true or false');
  if (force && isAgent(ctx)) throw new CommandError('forbidden', 'only a human can take a lease over (force)');
  if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > MAX_PATHS) throw new CommandError('bad_request', `paths must be a list of 1 to ${MAX_PATHS} folders or files`);
  const paths = [...new Set(args.paths.map(normalizeScopePath))].sort();
  const asked = ttlOf(args.ttl_s);
  const ttl = asked ?? TTL.default;
  if (task.status !== 'in_progress' && task.status !== 'blocked') throw new CommandError('conflict', `${task.id} is ${task.status}; only a task in progress or blocked can take a lease`);

  const events = await noticeExpired(ctx, at);
  // A path the task already holds keeps its lease and token (pushed out by this ttl); only new paths add rows.
  const mine = (await projectLeases(ctx, at, 'l.task_id = $3', [task.id])).filter((l) => l.current);
  const held = new Map(mine.map((l) => [l.path, l]));
  const fresh = paths.filter((p) => !held.has(p));
  if (mine.length + fresh.length > MAX_HELD) throw new CommandError('conflict', `${task.id} would hold more than ${MAX_HELD} leases; release some first`);
  const others = (await projectLeases(ctx, at, 'l.task_id <> $3', [task.id])).filter((l) => l.current && paths.some((p) => overlaps(p, l.path)));
  const conflicts = others.flatMap((l) => paths.filter((p) => overlaps(p, l.path)).map((p) => ({ path: p, lease_id: l.id, task_id: l.task_id, expires_at: iso(l.expires_at) })));
  const names = others.length ? await agentNames(ctx) : new Map<string, string>();

  if (others.length && !force) {
    // Refused as a whole (D-89). An agent hears why; a human gets the conflicts in the result only.
    if (isAgent(ctx)) {
      const holders = [...new Map(others.map((l) => [l.task_id, l])).values()];
      const shown = others.slice(0, 5).map((l) => `${holderOf(names, l)} holds a hard claim on ${l.path} (lease ${l.id}) until ${iso(l.expires_at).slice(11, 19)} UTC`);
      if (others.length > 5) shown.push(`and ${others.length - 5} more lease(s), in harness_status`);
      const refused = [...new Set(conflicts.map((c) => c.path))];
      const text = `${refused.slice(0, 10).join(', ')}${refused.length > 10 ? ', …' : ''}: ${shown.join('; ')}. Your claim was not granted.`;
      events.push(...await tellAgent(ctx, ctx.actor.principal, task.id, text, { paths, other_tasks: holders.map((l) => l.task_id), lease_ids: others.map((l) => l.id), level: 'lease', refused: true }));
    }
    return { result: { granted: [], conflicts }, events };
  }

  if (others.length) {
    // force: a revoke can't stop a land already past its fencing check, so the human cancels that land first.
    const busy = await landing(ctx, [...new Set(others.map((l) => l.task_id))]);
    if (busy.length) throw new CommandError('conflict', `${busy.join(', ')} is being landed; cancel that land first (harness land --cancel <task>)`);
    await ctx.tx.query("UPDATE leases SET released_at = $2::timestamptz, release_reason = 'revoked' WHERE id = ANY($1)", [others.map((l) => l.id), at]);
    for (const l of others) events.push({ kind: 'lease.released', data: { lease_id: l.id, task_id: l.task_id, reason: 'revoked', by: ctx.actor.principal } });
    for (const [taskId, ls] of Object.entries(Object.groupBy(others, (l) => l.task_id))) {
      const l = ls![0]!;
      if (!l.assignee_agent_id) continue;
      const lost = ls!.map((x) => x.path).sort();
      const text = `${lost.join(', ')}: your hard claim was taken over by ${ctx.actor.principal} for task ${task.id}. A land of these paths from task ${taskId} will be rejected.`;
      events.push(...await tellAgent(ctx, l.assignee_agent_id, taskId, text, { paths: lost, other_task: task.id, level: 'lease', revoked: true }));
    }
  }

  const granted: { lease_id: string; path: string; token: number; expires_at: string }[] = [];
  const kept: { lease_id: string; expires_at: string; ttl_s: number }[] = [];
  for (const path of paths) {
    const own = held.get(path);
    if (own) {
      // Its own TTL unless the claim names one, and never an earlier expiry than it already had.
      const keep = asked ?? own.ttl_s;
      const exp = (await ctx.tx.query<{ expires_at: Date }>(
        "UPDATE leases SET expires_at = GREATEST(expires_at, $2::timestamptz + $3::int * interval '1 second'), ttl_s = $3::int WHERE id = $1 RETURNING expires_at",
        [own.id, at, keep])).rows[0]!.expires_at;
      granted.push({ lease_id: own.id, path, token: Number(own.token), expires_at: iso(exp) });
      kept.push({ lease_id: own.id, expires_at: iso(exp), ttl_s: keep });
      continue;
    }
    const token = Number((await ctx.tx.query<{ t: string }>(
      'UPDATE projects SET next_fencing_token = next_fencing_token + 1 WHERE id = $1 RETURNING next_fencing_token AS t', [ctx.projectId])).rows[0]!.t);
    const id = `ls_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
    const row = (await ctx.tx.query<{ expires_at: Date }>(
      `INSERT INTO leases (id, project_id, task_id, path, token, granted_at, expires_at, ttl_s, granted_by, force)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + $7::int * interval '1 second', $7::int, $8, $9) RETURNING expires_at`,
      [id, ctx.projectId, task.id, path, token, at, ttl, ctx.actor.principal, force])).rows[0]!;
    granted.push({ lease_id: id, path, token, expires_at: iso(row.expires_at) });
    events.push({ kind: 'lease.granted', data: { lease_id: id, task_id: task.id, path, token, expires_at: iso(row.expires_at), ttl_s: ttl, by: ctx.actor.principal, force } });
  }
  if (kept.length) events.push({ kind: 'lease.renewed', data: { task_id: task.id, leases: kept } });
  return { result: { granted, conflicts: [] }, events };
}

/** `lease.renew { lease_ids[], ttl_s? }` → `{ renewed[], lost[] }`. harnessd only, from the device that ran the task (D-97). */
export async function renewLeases(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const { agentId, deviceId } = requireAgentOnDevice(ctx);
  const at = await lockLeases(ctx);
  const ids = leaseIds(args.lease_ids);
  const ttl = ttlOf(args.ttl_s);
  const events = await noticeExpired(ctx, at);
  const rows = await projectLeases(ctx, at, 'l.id = ANY($3)', [ids]);
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new CommandError('not_found', `no lease ${missing.join(', ')} in this project`);
  for (const taskId of new Set(rows.map((r) => r.task_id))) {
    const row = rows.find((r) => r.task_id === taskId)!;
    if (row.assignee_agent_id !== agentId) throw new CommandError('forbidden', `lease ${row.id} belongs to another agent's task`);
    const device = (await ctx.tx.query<{ device_id: string }>(
      'SELECT device_id FROM agent_sessions WHERE task_id = $1 ORDER BY started_at DESC LIMIT 1', [taskId])).rows[0]?.device_id;
    if (device !== deviceId) throw new CommandError('forbidden', `${taskId} ran on another device; only that device renews its leases`);
  }
  const renewed: { lease_id: string; expires_at: string; ttl_s: number }[] = [];
  const lost: { lease_id: string; reason: 'expired' | 'released' | 'revoked' }[] = [];
  const byTask = new Map<string, { lease_id: string; expires_at: string; ttl_s: number }[]>();
  for (const r of rows) {
    if (!r.current) { // never revived: released, past its expiry at this command's clock, or already seen expired
      lost.push({ lease_id: r.id, reason: r.released_at ? (r.release_reason === 'revoked' ? 'revoked' : 'released') : 'expired' });
      continue;
    }
    const keep = ttl ?? r.ttl_s;
    const exp = (await ctx.tx.query<{ expires_at: Date }>(
      "UPDATE leases SET expires_at = GREATEST(expires_at, $2::timestamptz + $3::int * interval '1 second'), ttl_s = $3::int WHERE id = $1 RETURNING expires_at",
      [r.id, at, keep])).rows[0]!.expires_at;
    const one = { lease_id: r.id, expires_at: iso(exp), ttl_s: keep };
    renewed.push(one);
    byTask.set(r.task_id, [...(byTask.get(r.task_id) ?? []), one]);
  }
  for (const [taskId, leases] of byTask) events.push({ kind: 'lease.renewed', data: { task_id: taskId, leases } });
  return { result: { renewed, lost }, events };
}

/**
 * `lease.release { lease_ids[] }` → `{ released[] }`. The task's agent, or a human (D-97). Refused while a lease's
 * task is being landed, like `force`: the land is past its fencing check, so freeing the path would let another
 * task claim it while the land still moves the base.
 */
export async function releaseLeases(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  if (isAgent(ctx)) requireAgentOnDevice(ctx);
  const at = await lockLeases(ctx);
  const ids = leaseIds(args.lease_ids);
  const events = await noticeExpired(ctx, at);
  const rows = await projectLeases(ctx, at, 'l.id = ANY($3)', [ids]);
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new CommandError('not_found', `no lease ${missing.join(', ')} in this project`);
  if (isAgent(ctx)) {
    const foreign = rows.find((r) => r.assignee_agent_id !== ctx.actor.principal);
    if (foreign) throw new CommandError('forbidden', `lease ${foreign.id} belongs to another agent's task`);
  }
  // Only current leases are released: one that has already expired stays expired (and was logged so above).
  const open = rows.filter((r) => r.current);
  const busy = await landing(ctx, [...new Set(open.map((r) => r.task_id))]);
  if (busy.length) throw new CommandError('conflict', `${busy.join(', ')} is being landed; cancel that land first (harness land --cancel <task>)`);
  if (open.length) await ctx.tx.query("UPDATE leases SET released_at = $2::timestamptz, release_reason = 'released' WHERE id = ANY($1)", [open.map((r) => r.id), at]);
  for (const r of open) events.push({ kind: 'lease.released', data: { lease_id: r.id, task_id: r.task_id, reason: 'released', by: ctx.actor.principal } });
  return { result: { released: open.map((r) => r.id) }, events };
}

/** An abandoned task gives up its leases (D-97). The caller has taken the lease lock first. */
export async function releaseAbandoned(ctx: HandlerContext, taskId: string): Promise<Events> {
  const ids = (await ctx.tx.query<{ id: string }>(
    "UPDATE leases SET released_at = now(), release_reason = 'abandoned' WHERE task_id = $1 AND released_at IS NULL RETURNING id", [taskId])).rows.map((r) => r.id).sort();
  return ids.map((id) => ({ kind: 'lease.released', data: { lease_id: id, task_id: taskId, reason: 'abandoned', by: ctx.actor.principal } }));
}
