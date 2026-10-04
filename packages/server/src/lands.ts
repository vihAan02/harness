// The local land step, server side (0B item 5; D-20, D-51, D-54; local-runtime.md §4). A human asks to land
// a finished task; the device that ran it merges it into the base branch in an integration worktree, runs
// the approved test command, and fast-forwards the base only if green. The server orders lands (one in
// flight per project), runs the fencing check, records the outcome, and, when a land completes, tells
// agents who read a changed file (stage landed, coordination.md §2).
//
// Flow: land.request (human) → land.requested → harnessd sends `land` with what it will merge → fencing
// check → land.accepted | land.rejected → land.report steps → land.complete (→ land.completed, task landed,
// landed notices) | land.fail (→ land.failed). A rejection is logged, not thrown: throwing would roll
// back the record of it (commands.ts).
import { randomUUID } from 'node:crypto';
import { normalizeFilePath, overlaps } from './claims.ts';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { lockInvalidation, noticeLanded } from './invalidation.ts';
import { lockLeases } from './leases.ts';
import { lockTask } from './tasks.ts';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const MAX_PATHS = 5000;
const STEPS = ['merged', 'setup', 'awaiting_approval', 'testing', 'tested'];
const FAIL_REASONS = ['conflict', 'tests', 'not_approved', 'base_moved', 'base_checkout_dirty', 'base_checkout_conflict', 'interrupted', 'error'];
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

type LandRow = { id: string; task_id: string; device_id: string; status: string; run_tests: boolean; base_sha: string | null; changed_paths: string[] | null };

const sha = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !SHA.test(v)) throw new CommandError('bad_request', `${name} must be a full commit id`);
  return v;
};
const paths = (v: unknown, name: string) => {
  if (!Array.isArray(v) || v.length > MAX_PATHS) throw new CommandError('bad_request', `${name} must be a list of up to ${MAX_PATHS} paths`);
  return [...new Set(v.map(normalizeFilePath))].sort();
};

function requireHumanCaller(ctx: HandlerContext, what: string): void {
  if (ctx.actor.onBehalfOf) throw new CommandError('forbidden', `only a human can ${what}`);
}

/** The land, locked, as seen by the device that must run it. */
async function deviceLand(ctx: HandlerContext, landId: unknown, statuses: string[]): Promise<LandRow> {
  if (!ctx.caller.deviceId || ctx.actor.onBehalfOf) throw new CommandError('forbidden', 'only harnessd reports a land, from its device');
  if (typeof landId !== 'string' || !/^land_[a-f0-9]{16}$/.test(landId)) throw new CommandError('bad_request', 'land_id is malformed');
  const land = (await ctx.tx.query<LandRow>(
    'SELECT id, task_id, device_id, status, run_tests, base_sha, changed_paths FROM lands WHERE id = $1 AND project_id = $2 FOR UPDATE', [landId, ctx.projectId])).rows[0];
  if (!land) throw new CommandError('not_found', `no land ${landId} in this project`);
  if (land.device_id !== ctx.caller.deviceId) throw new CommandError('forbidden', 'that land runs on another device');
  if (!statuses.includes(land.status)) throw new CommandError('conflict', `land ${landId} is ${land.status}`);
  return land;
}

/** `land.request { task_id, run_tests? }` → `land.requested`. Humans only; the task must be done. */
export async function requestLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  requireHumanCaller(ctx, 'land a task');
  // Serialize land requests per project, so the one-in-flight check can't race.
  await ctx.tx.query('SELECT id FROM projects WHERE id = $1 FOR UPDATE', [ctx.projectId]);
  const task = await lockTask(ctx, args.task_id);
  if (task.status !== 'done') throw new CommandError('conflict', `${task.id} is ${task.status}; only a finished task can land`);
  const runTests = args.run_tests === undefined ? true : args.run_tests;
  if (typeof runTests !== 'boolean') throw new CommandError('bad_request', 'run_tests must be true or false');
  const inFlight = (await ctx.tx.query<{ id: string; task_id: string }>(
    "SELECT id, task_id FROM lands WHERE project_id = $1 AND status IN ('requested', 'accepted')", [ctx.projectId])).rows[0];
  if (inFlight) throw new CommandError('conflict', `land ${inFlight.id} (${inFlight.task_id}) is still in progress; lands run one at a time`);
  const device = (await ctx.tx.query<{ device_id: string }>(
    'SELECT device_id FROM agent_sessions WHERE task_id = $1 ORDER BY started_at DESC LIMIT 1', [task.id])).rows[0]?.device_id;
  if (!device) throw new CommandError('bad_request', `${task.id} never ran on a device, so there's nothing to land`);
  const id = `land_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await ctx.tx.query(
    'INSERT INTO lands (id, project_id, task_id, device_id, requested_by, run_tests) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, ctx.projectId, task.id, device, ctx.actor.principal, runTests]);
  return {
    result: { land_id: id, device_id: device },
    events: [{ kind: 'land.requested', data: { land_id: id, task_id: task.id, device_id: device, requested_by: ctx.actor.principal, run_tests: runTests } }],
  };
}

export type FencingProblem = { path: string; reason: 'leased_by_other' | 'stale_token' | 'lease_not_current' | 'unknown_token'; lease_id?: string; token?: number; highest?: number };

/**
 * The fencing check (D-20, F-80, coordination.md §1), on the server's clock (F-84). For every changed path:
 * another task's current lease covering it rejects the land; and where this task holds leases covering
 * it, its best token must be the highest ever issued for that path, and that lease must still be current.
 * Tokens the device presents must be this task's.
 */
export async function fencingCheck(ctx: HandlerContext, taskId: string, changed: string[], presented: { lease_id: string; token: number }[]): Promise<FencingProblem[]> {
  const leases = (await ctx.tx.query<{ id: string; task_id: string; path: string; token: string; current: boolean }>(
    `SELECT id, task_id, path, token, (released_at IS NULL AND expires_at > now()) AS current FROM leases WHERE project_id = $1 ORDER BY token`,
    [ctx.projectId])).rows.map((l) => ({ ...l, token: Number(l.token) }));
  const problems: FencingProblem[] = [];
  for (const p of presented) {
    if (!leases.some((l) => l.id === p.lease_id && l.task_id === taskId && l.token === p.token)) problems.push({ path: '', reason: 'unknown_token', lease_id: p.lease_id, token: p.token });
  }
  for (const path of changed) {
    const covering = leases.filter((l) => overlaps(l.path, path));
    const other = covering.find((l) => l.task_id !== taskId && l.current);
    if (other) { problems.push({ path, reason: 'leased_by_other', lease_id: other.id, token: other.token }); continue; }
    const mine = covering.filter((l) => l.task_id === taskId);
    if (!mine.length) continue;
    const best = mine.reduce((a, b) => (b.token > a.token ? b : a));
    const highest = Math.max(...covering.map((l) => l.token));
    if (best.token < highest) problems.push({ path, reason: 'stale_token', lease_id: best.id, token: best.token, highest });
    else if (!best.current) problems.push({ path, reason: 'lease_not_current', lease_id: best.id, token: best.token });
  }
  return problems;
}

/** `land { land_id, base_branch, base_sha, merge_base_sha, head_sha, changed_paths[], lease_tokens[] }` → `land.accepted` | `land.rejected`. */
export async function startLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const land = await deviceLand(ctx, args.land_id, ['requested']);
  const task = await lockTask(ctx, land.task_id);
  if (task.status !== 'done') {
    await ctx.tx.query("UPDATE lands SET status = 'rejected', reason = 'task_not_done', finished_at = now() WHERE id = $1", [land.id]);
    return { result: { accepted: false, problems: [{ path: '', reason: 'task_not_done' }] }, events: [{ kind: 'land.rejected', data: { land_id: land.id, task_id: land.task_id, problems: [{ path: '', reason: 'task_not_done' }] } }] };
  }
  if (typeof args.base_branch !== 'string' || !BRANCH.test(args.base_branch)) throw new CommandError('bad_request', 'base_branch is malformed');
  const baseSha = sha(args.base_sha, 'base_sha');
  const mergeBase = sha(args.merge_base_sha, 'merge_base_sha');
  const head = sha(args.head_sha, 'head_sha');
  const changed = paths(args.changed_paths, 'changed_paths');
  const tokens = args.lease_tokens ?? [];
  if (!Array.isArray(tokens) || tokens.length > 1000 || !tokens.every((t) => typeof t?.lease_id === 'string' && Number.isSafeInteger(t?.token))) {
    throw new CommandError('bad_request', 'lease_tokens must be [{ lease_id, token }]');
  }
  const problems = await fencingCheck(ctx, land.task_id, changed, tokens as { lease_id: string; token: number }[]);
  const accepted = problems.length === 0;
  await ctx.tx.query(
    `UPDATE lands SET status = $2, base_branch = $3, base_sha = $4, merge_base_sha = $5, head_sha = $6, changed_paths = $7,
       reason = $8, finished_at = CASE WHEN $2 = 'rejected' THEN now() ELSE NULL END WHERE id = $1`,
    [land.id, accepted ? 'accepted' : 'rejected', args.base_branch, baseSha, mergeBase, head, changed, accepted ? null : 'fencing']);
  const base = { land_id: land.id, task_id: land.task_id, base_branch: args.base_branch, base_sha: baseSha, head_sha: head, changed_paths: changed };
  return accepted
    ? { result: { accepted: true }, events: [{ kind: 'land.accepted', data: { ...base, run_tests: land.run_tests } }] }
    : { result: { accepted: false, problems }, events: [{ kind: 'land.rejected', data: { ...base, problems } }] };
}

/** `land.report { land_id, step, detail? }` → `land.progress`, for the human watching `harness land`. */
export async function reportLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const land = await deviceLand(ctx, args.land_id, ['accepted']);
  if (typeof args.step !== 'string' || !STEPS.includes(args.step)) throw new CommandError('bad_request', `step must be one of ${STEPS.join(', ')}`);
  const detail = typeof args.detail === 'string' ? args.detail.replace(CONTROL, '').slice(0, 300) : undefined;
  return { result: null, events: [{ kind: 'land.progress', data: { land_id: land.id, task_id: land.task_id, step: args.step, ...(detail ? { detail } : {}) } }] };
}

/**
 * `land.complete { land_id, old_base_sha, new_base_sha, changed[{ path, new_hash }] }` → `land.completed`, the task
 * landed, landed notices. Accepted for a cancelled land too: if the device moved the base before it heard of the
 * cancel, the change is in the base, and readers must hear of it.
 */
export async function completeLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  await lockInvalidation(ctx); // first: see lockInvalidation
  await lockLeases(ctx); // then the lease lock: this releases the task's leases (D-97)
  const land = await deviceLand(ctx, args.land_id, ['accepted', 'cancelled']);
  const oldBase = sha(args.old_base_sha, 'old_base_sha');
  const newBase = sha(args.new_base_sha, 'new_base_sha');
  if (land.base_sha && oldBase !== land.base_sha) throw new CommandError('conflict', 'old_base_sha is not the base this land was accepted on');
  if (!Array.isArray(args.changed) || args.changed.length > MAX_PATHS) throw new CommandError('bad_request', `changed must be a list of up to ${MAX_PATHS}`);
  const changed = (args.changed as { path?: unknown; new_hash?: unknown }[]).map((c, i) => {
    const hash = c?.new_hash === null ? null : typeof c?.new_hash === 'string' && SHA.test(c.new_hash) ? c.new_hash : undefined;
    if (hash === undefined) throw new CommandError('bad_request', `changed[${i}].new_hash must be a Git blob id or null (deleted)`);
    return { path: normalizeFilePath(c?.path), newHash: hash };
  });
  const task = await lockTask(ctx, land.task_id);
  // The base has already moved on the device: record what happened, whatever the task's status says now.
  await ctx.tx.query("UPDATE lands SET status = 'completed', new_base_sha = $2, changed_blobs = $3, finished_at = now() WHERE id = $1",
    [land.id, newBase, JSON.stringify(Object.fromEntries(changed.map((c) => [c.path, c.newHash])))]);
  await ctx.tx.query("UPDATE tasks SET status = 'landed', landed_at = now() WHERE id = $1", [task.id]);
  const released = (await ctx.tx.query<{ id: string }>(
    'UPDATE leases SET released_at = now() WHERE task_id = $1 AND released_at IS NULL RETURNING id', [task.id])).rows.map((r) => r.id);
  const events: HandlerOutput['events'] = [
    { kind: 'land.completed', data: { land_id: land.id, task_id: task.id, old_base_sha: oldBase, new_base_sha: newBase, changed_paths: changed.map((c) => c.path) } },
    ...released.map((id) => ({ kind: 'lease.released', data: { lease_id: id, task_id: task.id, reason: 'landed' } })),
  ];
  // Stale context (0B item 2): everyone who read a file this land changed, and read different content, hears it.
  events.push(...await noticeLanded(ctx, { task: task.id, agent: task.assignee_agent_id, landId: land.id, newBase }, changed));
  return { result: null, events };
}

/** `land.fail { land_id, reason, detail?, conflict_paths? }` → `land.failed`. The task stays done; the human decides what's next. */
export async function failLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const land = await deviceLand(ctx, args.land_id, ['requested', 'accepted']);
  if (typeof args.reason !== 'string' || !FAIL_REASONS.includes(args.reason)) throw new CommandError('bad_request', `reason must be one of ${FAIL_REASONS.join(', ')}`);
  const detail = typeof args.detail === 'string' ? args.detail.replace(CONTROL, '').slice(0, 1000) : null;
  const conflicts = args.conflict_paths === undefined ? [] : paths(args.conflict_paths, 'conflict_paths');
  await ctx.tx.query("UPDATE lands SET status = 'failed', reason = $2, detail = $3, finished_at = now() WHERE id = $1", [land.id, args.reason, detail]);
  return {
    result: null,
    events: [{ kind: 'land.failed', data: { land_id: land.id, task_id: land.task_id, reason: args.reason, ...(detail ? { detail } : {}), ...(conflicts.length ? { conflict_paths: conflicts } : {}) } }],
  };
}

/**
 * `land.cancel { task_id }`: a human gives up on a land in flight, typically because its device is offline and
 * every other land waits behind it. If the device was mid-land, its next progress report or land.fail is refused,
 * which stops it; only a land.complete (the base already moved) is still recorded.
 */
export async function cancelLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  requireHumanCaller(ctx, 'cancel a land');
  if (typeof args.task_id !== 'string') throw new CommandError('bad_request', 'task_id is missing');
  const land = (await ctx.tx.query<{ id: string }>(
    "SELECT id FROM lands WHERE project_id = $1 AND task_id = $2 AND status IN ('requested', 'accepted') FOR UPDATE", [ctx.projectId, args.task_id])).rows[0];
  if (!land) throw new CommandError('conflict', `no land of ${args.task_id} is in flight`);
  await ctx.tx.query("UPDATE lands SET status = 'cancelled', reason = 'cancelled', finished_at = now() WHERE id = $1", [land.id]);
  return { result: null, events: [{ kind: 'land.failed', data: { land_id: land.id, task_id: args.task_id, reason: 'cancelled' } }] };
}
