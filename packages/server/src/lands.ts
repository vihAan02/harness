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
import { checkDispatch, loadAgent } from './dispatches.ts';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const BRANCH = /^[A-Za-z0-9._/-]{1,200}$/;
const MAX_PATHS = 5000;
const STEPS = ['merged', 'setup', 'awaiting_approval', 'testing', 'tested'];
/** A GitHub-mode land's steps (D-115): `merge_requested` comes only from land.arm; these are reported. */
const GITHUB_STEPS = ['checking', 'outcome_unknown'];
const FAIL_REASONS = ['conflict', 'tests', 'not_approved', 'base_moved', 'base_checkout_dirty', 'base_checkout_conflict', 'interrupted', 'error'];
const GITHUB_FAIL_REASONS = ['head_changed', 'head_behind', 'wrong_base', 'checks_failed', 'not_mergeable', 'pr_closed', 'review_required', 'ci_busy', 'protection_missing', 'verification_failed', 'dispatch_rejected'];
/** Once a GitHub land is armed, it fails only on GitHub's evidence that nothing was merged (D-115). */
const ARMED_FAIL_REASONS = ['head_changed', 'pr_closed', 'not_mergeable', 'base_moved'];
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

type LandRow = {
  id: string; task_id: string; device_id: string; status: string; run_tests: boolean; base_sha: string | null; changed_paths: string[] | null;
  mode: 'local' | 'github' | 'external'; pr_number: number | null; approved_head_sha: string | null; approved_base_sha: string | null; merge_requested_at: Date | null;
};

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
    `SELECT id, task_id, device_id, status, run_tests, base_sha, changed_paths, mode, pr_number, approved_head_sha, approved_base_sha, merge_requested_at
     FROM lands WHERE id = $1 AND project_id = $2 FOR UPDATE`, [landId, ctx.projectId])).rows[0];
  if (!land) throw new CommandError('not_found', `no land ${landId} in this project`);
  if (land.device_id !== ctx.caller.deviceId) throw new CommandError('forbidden', 'that land runs on another device');
  if (!statuses.includes(land.status)) throw new CommandError('conflict', `land ${landId} is ${land.status}`);
  return land;
}

/** `land.request { task_id, run_tests? }` → `land.requested`. Humans only; the task must be done. */
export async function requestLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  requireHumanCaller(ctx, 'land a task');
  // Serialize land requests per project, so the one-in-flight check can't race.
  const mode = (await ctx.tx.query<{ integration_mode: string }>('SELECT integration_mode FROM projects WHERE id = $1 FOR UPDATE', [ctx.projectId])).rows[0]?.integration_mode;
  // A GitHub project lands through its PR (D-114, D-115): the local land, --no-tests included, is refused.
  if (mode === 'github' && args.mode !== 'github') throw new CommandError('conflict', 'this project integrates through GitHub; land it with `harness integrate` (D-114)');
  if (mode !== 'github' && args.mode !== undefined && args.mode !== 'local') throw new CommandError('conflict', 'this project lands locally');
  if (mode === 'github') return requestGithubLand(ctx, args);
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

/**
 * `land.request { task_id, mode: "github", pr_number, head_sha, base_sha }` → `land.requested { mode: "github", … }` (D-115).
 * The human approving it is the agent's accountable human (the merge runs with their own GitHub login), and the land
 * runs on their own device. Head and base are what they approved: a land never merges anything else.
 */
async function requestGithubLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const device = ctx.caller.authDeviceId ?? ctx.caller.deviceId;
  if (!device) throw new CommandError('forbidden', 'integrating runs on your own device: connect with your device key (D-111)');
  const task = await lockTask(ctx, args.task_id);
  if (task.status !== 'done') throw new CommandError('conflict', `${task.id} is ${task.status}; only a finished task can land`);
  const owner = (await ctx.tx.query<{ accountable_human_id: string }>('SELECT accountable_human_id FROM agent_principals WHERE id = $1', [task.assignee_agent_id])).rows[0]?.accountable_human_id;
  if (owner !== ctx.caller.principal) throw new CommandError('forbidden', `only ${owner ?? 'the agent\'s human'} can integrate ${task.id}: the merge runs with their GitHub login (D-112)`);
  const head = sha(args.head_sha, 'head_sha');
  const base = sha(args.base_sha, 'base_sha');
  if (!Number.isSafeInteger(args.pr_number)) throw new CommandError('bad_request', 'pr_number is missing');
  const pr = (await ctx.tx.query<{ pr_number: number; head_sha: string; state: string }>('SELECT pr_number, head_sha, state FROM task_prs WHERE task_id = $1', [task.id])).rows[0];
  if (!pr || pr.pr_number !== args.pr_number || pr.state !== 'open') throw new CommandError('conflict', `${task.id} has no open PR #${String(args.pr_number)}`);
  if (pr.head_sha !== head) throw new CommandError('conflict', `PR #${pr.pr_number}'s head is ${pr.head_sha.slice(0, 12)}, not ${head.slice(0, 12)}: approve the head it has`);
  const inFlight = (await ctx.tx.query<{ id: string; task_id: string }>(
    "SELECT id, task_id FROM lands WHERE project_id = $1 AND status IN ('requested', 'accepted')", [ctx.projectId])).rows[0];
  if (inFlight) throw new CommandError('conflict', `land ${inFlight.id} (${inFlight.task_id}) is still in progress; one integration at a time (D-115)`);
  // The integrate dispatch (D-112), signed by the approver's own device: it names this PR, this head and this base.
  // The changed paths it covers are checked by the device that merges, which has the commits.
  const routed = await checkDispatch(ctx, args.dispatch, { kind: 'integrate', task, agent: await loadAgent(ctx, task.assignee_agent_id!) });
  const signed = routed.dispatch?.envelope.integrate;
  if (routed.dispatch && (signed?.pr_number !== pr.pr_number || signed.head_sha !== head || signed.base_sha !== base)) {
    throw new CommandError('forbidden', 'dispatch refused (content_mismatch): the integrate dispatch names another PR, head or base');
  }
  const id = `land_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await ctx.tx.query(
    `INSERT INTO lands (id, project_id, task_id, device_id, requested_by, run_tests, mode, pr_number, approved_head_sha, approved_base_sha, dispatch_nonce)
     VALUES ($1, $2, $3, $4, $5, false, 'github', $6, $7, $8, $9)`, [id, ctx.projectId, task.id, device, ctx.actor.principal, pr.pr_number, head, base, routed.dispatch?.envelope.nonce ?? null]);
  return {
    result: { land_id: id, device_id: device },
    events: [{ kind: 'land.requested', data: {
      land_id: id, task_id: task.id, device_id: device, requested_by: ctx.actor.principal, run_tests: false, mode: 'github', pr_number: pr.pr_number, head_sha: head, base_sha: base,
      ...(routed.dispatch ? { dispatch: routed.dispatch } : {}),
    } }],
  };
}

/**
 * Paths an accepted GitHub land reserves (D-115): no other task may take a lease that overlaps them, force included,
 * and even after the reserving task's own lease expired, until GitHub's outcome is known. Called by lease.acquire
 * under the lease lock.
 */
export async function reservedBy(ctx: HandlerContext, taskId: string, paths: string[]): Promise<{ landId: string; taskId: string; paths: string[] } | null> {
  const lands = (await ctx.tx.query<{ id: string; task_id: string; changed_paths: string[] | null }>(
    "SELECT id, task_id, changed_paths FROM lands WHERE project_id = $1 AND mode = 'github' AND status = 'accepted' AND task_id <> $2", [ctx.projectId, taskId])).rows;
  for (const l of lands) {
    const hit = paths.filter((p) => (l.changed_paths ?? []).some((c) => overlaps(p, c)));
    if (hit.length) return { landId: l.id, taskId: l.task_id, paths: hit };
  }
  return null;
}

/**
 * `land.arm { land_id, head_sha, base_sha }` (the reserving harnessd, synchronously, before its merge request): the
 * coordinator's last word before the merge (D-115). It re-runs the fencing check and refuses if the base moved; once
 * armed, the land can't be cancelled, and it fails only on GitHub's evidence. Arming again (a re-issued merge after
 * outcome_unknown) is allowed.
 */
export async function armLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  await lockInvalidation(ctx);
  const at = await lockLeases(ctx);
  const land = await deviceLand(ctx, args.land_id, ['accepted']);
  if (land.mode !== 'github') throw new CommandError('conflict', `land ${land.id} is a local land`);
  if (args.head_sha !== land.approved_head_sha || args.base_sha !== land.approved_base_sha) throw new CommandError('conflict', 'head_sha and base_sha must be the approved ones');
  const tip = (await ctx.tx.query<{ tip_sha: string }>('SELECT tip_sha FROM project_bases WHERE project_id = $1', [ctx.projectId])).rows[0]?.tip_sha;
  if (tip && tip !== land.approved_base_sha) throw new CommandError('conflict', `base_moved: the base is at ${tip.slice(0, 12)} now`);
  const problems = await fencingCheck(ctx, land.task_id, land.changed_paths ?? [], [], at);
  if (problems.length) throw new CommandError('conflict', `fencing: ${JSON.stringify(problems)}`);
  const again = land.merge_requested_at !== null;
  await ctx.tx.query("UPDATE lands SET step = 'merge_requested', merge_requested_at = coalesce(merge_requested_at, now()) WHERE id = $1", [land.id]);
  return { result: { armed: true, again }, events: [{ kind: 'land.progress', data: { land_id: land.id, task_id: land.task_id, step: 'merge_requested', ...(again ? { detail: 'merge requested again' } : {}) } }] };
}

export type FencingProblem = { path: string; reason: 'leased_by_other' | 'stale_token' | 'unknown_token'; lease_id?: string; token?: number; highest?: number };

/**
 * The fencing check (D-20, F-80, coordination.md §1), on the server's clock (F-84). For every changed path:
 * another task's current lease covering it rejects the land; and where this task has held leases covering
 * it, its best token must be the highest ever issued for that path, or another task has taken the path
 * since (`stale_token`, T-2). The task's own lease that it released, or that expired while nobody else took
 * the path, doesn't block it (D-103). Tokens the device presents must be this task's. "Current" is judged at
 * `at`, the server's clock read under the lease lock, exactly as the lease commands judge it: a lease already
 * logged as expired is never current again (D-97).
 */
export async function fencingCheck(ctx: HandlerContext, taskId: string, changed: string[], presented: { lease_id: string; token: number }[], at: string): Promise<FencingProblem[]> {
  const leases = (await ctx.tx.query<{ id: string; task_id: string; path: string; token: string; current: boolean }>(
    `SELECT id, task_id, path, token, (released_at IS NULL AND expired_logged_at IS NULL AND expires_at > $2::timestamptz) AS current
     FROM leases WHERE project_id = $1 ORDER BY token`,
    [ctx.projectId, at])).rows.map((l) => ({ ...l, token: Number(l.token) }));
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
  }
  return problems;
}

/** `land { land_id, base_branch, base_sha, merge_base_sha, head_sha, changed_paths[], lease_tokens[] }` → `land.accepted` | `land.rejected`. */
export async function startLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  // First: no lease is granted between the fencing check and the land's acceptance. Its clock, read under the
  // lock, not at the transaction's start: a lease another command saw expire stays expired (D-97).
  const at = await lockLeases(ctx);
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
  if (land.mode === 'github' && (head !== land.approved_head_sha || baseSha !== land.approved_base_sha)) {
    // A changed head or base is not what the human approved (D-115): refused before any merge request.
    await ctx.tx.query("UPDATE lands SET status = 'rejected', reason = 'not_approved_head', finished_at = now() WHERE id = $1", [land.id]);
    const problems = [{ path: '', reason: head !== land.approved_head_sha ? 'head_changed' : 'base_moved' }];
    return { result: { accepted: false, problems }, events: [{ kind: 'land.rejected', data: { land_id: land.id, task_id: land.task_id, problems } }] };
  }
  const problems = await fencingCheck(ctx, land.task_id, changed, tokens as { lease_id: string; token: number }[], at);
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
  const steps = land.mode === 'github' ? GITHUB_STEPS : STEPS;
  if (typeof args.step !== 'string' || !steps.includes(args.step)) throw new CommandError('bad_request', `step must be one of ${steps.join(', ')}`);
  if (land.mode === 'github') await ctx.tx.query('UPDATE lands SET step = $2 WHERE id = $1', [land.id, args.step]);
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
  const at = await lockLeases(ctx); // then the lease lock: this releases the task's leases (D-97)
  const land = await deviceLand(ctx, args.land_id, ['accepted', 'cancelled']);
  const oldBase = sha(args.old_base_sha, 'old_base_sha');
  const newBase = sha(args.new_base_sha, 'new_base_sha');
  if (land.base_sha && oldBase !== land.base_sha) throw new CommandError('conflict', 'old_base_sha is not the base this land was accepted on');
  if (land.mode === 'github' && !land.merge_requested_at) throw new CommandError('conflict', `land ${land.id} was never armed`);
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
  const events: HandlerOutput['events'] = [
    { kind: 'land.completed', data: { land_id: land.id, task_id: task.id, old_base_sha: oldBase, new_base_sha: newBase, changed_paths: changed.map((c) => c.path) } },
    ...await releaseOnLand(ctx, task.id, at),
  ];
  if (land.mode === 'github') {
    // The chain moves to the merge (D-114). Moves parked while it was armed are dropped: the pollers report them again
    // against the new tip, and the merge itself is now known.
    await ctx.tx.query(
      `INSERT INTO project_bases (project_id, tip_sha) VALUES ($1, $2) ON CONFLICT (project_id) DO UPDATE SET tip_sha = $2, updated_at = now()`, [ctx.projectId, newBase]);
    await ctx.tx.query("DELETE FROM base_advances WHERE project_id = $1 AND status = 'parked'", [ctx.projectId]);
    await ctx.tx.query(
      `INSERT INTO base_advances (project_id, new_sha, old_sha, source, changed_blobs, observed_by) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id, new_sha) DO UPDATE SET source = EXCLUDED.source, status = 'applied'`,
      [ctx.projectId, newBase, oldBase, `land:${land.id}`, JSON.stringify(Object.fromEntries(changed.map((c) => [c.path, c.newHash]))), ctx.caller.deviceId]);
    await ctx.tx.query("UPDATE task_prs SET state = 'closed', merged = true, merge_sha = $2, updated_at = now() WHERE task_id = $1", [task.id, newBase]);
  }
  // Stale context (0B item 2): everyone who read a file this land changed, and read different content, hears it.
  events.push(...await noticeLanded(ctx, { task: task.id, agent: task.assignee_agent_id, landId: land.id, newBase }, changed));
  return { result: null, events };
}

/**
 * A landed task's current leases are released. One that ran out is expired, not released: the next lease command
 * logs it as `lease.expired`, once, as it would any other (D-97). Call with the lease lock held (`at` from lockLeases).
 */
export async function releaseOnLand(ctx: HandlerContext, taskId: string, at: string): Promise<HandlerOutput['events']> {
  const released = (await ctx.tx.query<{ id: string }>(
    `UPDATE leases SET released_at = now(), release_reason = 'landed'
     WHERE task_id = $1 AND released_at IS NULL AND expired_logged_at IS NULL AND expires_at > $2::timestamptz RETURNING id`, [taskId, at])).rows.map((r) => r.id).sort();
  return released.map((id) => ({ kind: 'lease.released', data: { lease_id: id, task_id: taskId, reason: 'landed' } }));
}

/** `land.fail { land_id, reason, detail?, conflict_paths? }` → `land.failed`. The task stays done; the human decides what's next. */
export async function failLand(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const land = await deviceLand(ctx, args.land_id, ['requested', 'accepted']);
  const reasons = land.mode === 'github' ? [...FAIL_REASONS, ...GITHUB_FAIL_REASONS] : FAIL_REASONS;
  if (typeof args.reason !== 'string' || !reasons.includes(args.reason)) throw new CommandError('bad_request', `reason must be one of ${reasons.join(', ')}`);
  if (land.merge_requested_at) {
    // Armed (D-115): only GitHub's evidence that nothing was merged releases it. Never an error, a timeout or a restart.
    const ev = args.evidence as { state?: unknown; merged?: unknown; head_sha?: unknown } | undefined;
    if (!ARMED_FAIL_REASONS.includes(args.reason) || !ev || ev.merged !== false || (ev.state !== 'open' && ev.state !== 'closed')) {
      throw new CommandError('conflict', `land ${land.id} is armed: it fails only on GitHub's evidence that nothing was merged (outcome_unknown until then)`);
    }
  }
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
  const land = (await ctx.tx.query<{ id: string; merge_requested_at: Date | null }>(
    "SELECT id, merge_requested_at FROM lands WHERE project_id = $1 AND task_id = $2 AND status IN ('requested', 'accepted') FOR UPDATE", [ctx.projectId, args.task_id])).rows[0];
  if (!land) throw new CommandError('conflict', `no land of ${args.task_id} is in flight`);
  if (land.merge_requested_at) throw new CommandError('conflict', `the merge for ${args.task_id} was requested: its outcome comes from GitHub, so it can't be cancelled (D-115). Close the PR on GitHub to stop it.`);
  await ctx.tx.query("UPDATE lands SET status = 'cancelled', reason = 'cancelled', finished_at = now() WHERE id = $1", [land.id]);
  return { result: null, events: [{ kind: 'land.failed', data: { land_id: land.id, task_id: args.task_id, reason: 'cancelled' } }] };
}
