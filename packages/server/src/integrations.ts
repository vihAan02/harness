// GitHub integration records (D-114, D-115; docs/protocol.md §11). What harnessd tells the coordinator about a
// task's PR, and about the base branch's tip as GitHub has it. The coordinator holds metadata only: never
// repository contents, never credentials. Every command here comes from harnessd, on its own device.
// - pr.publish / pr.status / publish.blocked: the task's device published (or couldn't publish) its PR, and what
//   it last polled of it.
// - base.observe: any daemon saw the remote base move. The tip moves only by compare-and-swap, so every daemon
//   agrees on one chain; a move the harness didn't make is noticed once, like a land; a move seen while a merge is
//   armed is parked until that merge's outcome is known (D-115).
// - land.external: a task's PR was merged outside the harness. It lands like any other, once, and is noticed.
import { randomUUID } from 'node:crypto';
import { normalizeFilePath } from './claims.ts';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { lockInvalidation, noticeLanded } from './invalidation.ts';
import { releaseOnLand } from './lands.ts';
import { lockLeases } from './leases.ts';
import { lockTask } from './tasks.ts';

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTE_REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,200}$/;
const STATE = /^[a-z_]{1,40}$/;
const MAX_PATHS = 5000;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const CONCLUSIONS = ['success', 'failure', 'pending', 'neutral', 'skipped', 'cancelled'];
const REVIEW_STATES = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'];

type Events = HandlerOutput['events'];
type PrRow = { task_id: string; device_id: string; pr_number: number; head_sha: string; state: string; merged: boolean; merge_sha: string | null; mergeable_state: string | null; checks: unknown; reviews: unknown };

const sha = (v: unknown, name: string) => {
  if (typeof v !== 'string' || !SHA.test(v)) throw new CommandError('bad_request', `${name} must be a full commit id`);
  return v;
};
const prNumber = (v: unknown) => {
  if (!Number.isSafeInteger(v) || (v as number) < 1) throw new CommandError('bad_request', 'pr_number must be a positive integer');
  return v as number;
};
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(CONTROL, '').slice(0, max) : undefined);

/** Changed files with their new blobs, as land.complete carries them. */
export function changedBlobs(v: unknown): { path: string; newHash: string | null }[] {
  if (!Array.isArray(v) || v.length > MAX_PATHS) throw new CommandError('bad_request', `changed must be a list of up to ${MAX_PATHS}`);
  return (v as { path?: unknown; new_hash?: unknown }[]).map((c, i) => {
    const hash = c?.new_hash === null ? null : typeof c?.new_hash === 'string' && SHA.test(c.new_hash) ? c.new_hash : undefined;
    if (hash === undefined) throw new CommandError('bad_request', `changed[${i}].new_hash must be a Git blob id or null (deleted)`);
    return { path: normalizeFilePath(c?.path), newHash: hash };
  });
}

/** harnessd, on its own device, reporting for its human (never as an agent). Returns the device. */
function requireHarnessd(ctx: HandlerContext, what: string): string {
  if (!ctx.caller.deviceId || ctx.actor.onBehalfOf) throw new CommandError('forbidden', `only harnessd reports ${what}, from its device`);
  return ctx.caller.deviceId;
}

/** These records exist only for a project that integrates through GitHub (D-114). */
async function requireGithubProject(ctx: HandlerContext): Promise<void> {
  const mode = (await ctx.tx.query<{ integration_mode: string }>('SELECT integration_mode FROM projects WHERE id = $1', [ctx.projectId])).rows[0]?.integration_mode;
  if (mode !== 'github') throw new CommandError('conflict', 'this project lands locally; it has no GitHub integration (D-114)');
}

/** The device that ran the task's latest session: the one that publishes and polls its PR. */
async function requireTaskDevice(ctx: HandlerContext, taskId: string, device: string): Promise<void> {
  const ran = (await ctx.tx.query<{ device_id: string }>('SELECT device_id FROM agent_sessions WHERE task_id = $1 ORDER BY started_at DESC LIMIT 1', [taskId])).rows[0]?.device_id;
  if (ran !== device) throw new CommandError('forbidden', `${taskId} runs on another device`);
}

/** `pr.publish { task_id, pr_number, url, head_sha, base_sha, remote_ref }` → `pr.published`. A republished task's PR replaces its old record. */
export async function publishPr(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const device = requireHarnessd(ctx, 'a published PR');
  await requireGithubProject(ctx);
  const task = await lockTask(ctx, args.task_id);
  if (task.status !== 'done') throw new CommandError('conflict', `${task.id} is ${task.status}; only a finished task is published`);
  await requireTaskDevice(ctx, task.id, device);
  const n = prNumber(args.pr_number);
  if (typeof args.url !== 'string' || !/^https?:\/\/[^\s]{1,490}$/.test(args.url)) throw new CommandError('bad_request', 'url must be the PR\'s web address');
  if (typeof args.remote_ref !== 'string' || !REMOTE_REF.test(args.remote_ref)) throw new CommandError('bad_request', 'remote_ref must be refs/heads/<branch>');
  const head = sha(args.head_sha, 'head_sha');
  const base = sha(args.base_sha, 'base_sha');
  await ctx.tx.query(
    `INSERT INTO task_prs (task_id, project_id, device_id, pr_number, url, remote_ref, head_sha, base_sha)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (task_id) DO UPDATE SET device_id = $3, pr_number = $4, url = $5, remote_ref = $6, head_sha = $7, base_sha = $8,
       state = 'open', merged = false, merge_sha = NULL, mergeable_state = NULL, checks = '{}', reviews = '[]', updated_at = now()`,
    [task.id, ctx.projectId, device, n, args.url, args.remote_ref, head, base]);
  return { result: null, events: [{ kind: 'pr.published', data: { task_id: task.id, pr_number: n, url: args.url, head_sha: head, base_sha: base, remote_ref: args.remote_ref, device_id: device } }] };
}

/** `pr.status { task_id, pr_number, head_sha, state, merged, merge_sha?, mergeable_state, checks, reviews }` → `pr.updated`, only when something changed. */
export async function reportPrStatus(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const device = requireHarnessd(ctx, 'a PR\'s status');
  await requireGithubProject(ctx);
  if (typeof args.task_id !== 'string') throw new CommandError('bad_request', 'task_id is missing');
  const pr = (await ctx.tx.query<PrRow>('SELECT * FROM task_prs WHERE task_id = $1 AND project_id = $2 FOR UPDATE', [args.task_id, ctx.projectId])).rows[0];
  if (!pr) throw new CommandError('not_found', `${args.task_id} has no PR`);
  if (pr.device_id !== device) throw new CommandError('forbidden', `${args.task_id}'s PR is polled by its own device`);
  if (prNumber(args.pr_number) !== pr.pr_number) throw new CommandError('conflict', `${args.task_id}'s PR is #${pr.pr_number}`);
  const head = sha(args.head_sha, 'head_sha');
  if (args.state !== 'open' && args.state !== 'closed') throw new CommandError('bad_request', 'state must be open or closed');
  if (typeof args.merged !== 'boolean') throw new CommandError('bad_request', 'merged must be true or false');
  const mergeSha = args.merged ? sha(args.merge_sha, 'merge_sha') : null;
  if (typeof args.mergeable_state !== 'string' || !STATE.test(args.mergeable_state)) throw new CommandError('bad_request', 'mergeable_state is malformed');
  const rawChecks = args.checks;
  if (typeof rawChecks !== 'object' || rawChecks === null || Array.isArray(rawChecks) || Object.keys(rawChecks).length > 50) throw new CommandError('bad_request', 'checks must be { name: conclusion }');
  const checks = Object.fromEntries(Object.entries(rawChecks as Record<string, unknown>).map(([name, c]) => {
    if (!CONCLUSIONS.includes(c as string)) throw new CommandError('bad_request', `checks.${clean(name, 60)}: unknown conclusion`);
    return [clean(name, 100)!, c as string];
  }));
  if (!Array.isArray(args.reviews) || args.reviews.length > 100) throw new CommandError('bad_request', 'reviews must be a list');
  const reviews = (args.reviews as Record<string, unknown>[]).map((r) => {
    if (typeof r?.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(r.login) || !REVIEW_STATES.includes(r.state as string)) throw new CommandError('bad_request', 'a review is { login, state, commit_id }');
    return { login: r.login, state: r.state as string, commit_id: sha(r.commit_id, 'reviews[].commit_id') };
  });
  const next = { head_sha: head, state: args.state, merged: args.merged, merge_sha: mergeSha, mergeable_state: args.mergeable_state, checks, reviews };
  const same = pr.head_sha === head && pr.state === args.state && pr.merged === args.merged && pr.merge_sha === mergeSha && pr.mergeable_state === args.mergeable_state
    && JSON.stringify(pr.checks) === JSON.stringify(checks) && JSON.stringify(pr.reviews) === JSON.stringify(reviews);
  if (same) return { result: { changed: false }, events: [] };
  await ctx.tx.query(
    `UPDATE task_prs SET head_sha = $2, state = $3, merged = $4, merge_sha = $5, mergeable_state = $6, checks = $7, reviews = $8, updated_at = now() WHERE task_id = $1`,
    [pr.task_id, head, args.state, args.merged, mergeSha, args.mergeable_state, JSON.stringify(checks), JSON.stringify(reviews)]);
  return { result: { changed: true }, events: [{ kind: 'pr.updated', data: { task_id: pr.task_id, pr_number: pr.pr_number, ...next } }] };
}

/** `publish.blocked { task_id, reasons[{ commit?, path?, rule }] }` → `publish.blocked`. The gate refused; nothing was pushed (D-114). */
export async function reportPublishBlocked(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const device = requireHarnessd(ctx, 'a blocked publish');
  await requireGithubProject(ctx);
  const task = await lockTask(ctx, args.task_id);
  await requireTaskDevice(ctx, task.id, device);
  if (!Array.isArray(args.reasons) || !args.reasons.length || args.reasons.length > 50) throw new CommandError('bad_request', 'reasons must be a list of 1 to 50');
  const reasons = (args.reasons as Record<string, unknown>[]).map((r) => {
    const rule = clean(r?.rule, 100);
    if (!rule) throw new CommandError('bad_request', 'each reason names its rule');
    const commit = typeof r.commit === 'string' && SHA.test(r.commit) ? r.commit : undefined;
    const path = r.path === undefined ? undefined : normalizeFilePath(r.path);
    return { rule, ...(commit ? { commit } : {}), ...(path ? { path } : {}) };
  });
  return { result: null, events: [{ kind: 'publish.blocked', data: { task_id: task.id, reasons } }] };
}

/**
 * `base.observe { old_sha, new_sha, changed[{ path, new_hash }] }`: the remote base moved from old to new, as a daemon
 * saw it. Returns `{ status }`: `seeded` (the first observation starts the chain; nothing to notice), `known` (already
 * seen), `stale` (the chain's tip is elsewhere: re-derive from `tip`), `parked` (a merge is armed: held until its
 * outcome), or `applied` (→ `base.advanced` and landed notices, writer outside the harness).
 */
export async function observeBase(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const device = requireHarnessd(ctx, 'the base branch');
  await requireGithubProject(ctx);
  await lockInvalidation(ctx); // the same lock order as land.complete: invalidation, then leases
  await lockLeases(ctx);
  const oldSha = sha(args.old_sha, 'old_sha');
  const newSha = sha(args.new_sha, 'new_sha');
  if (oldSha === newSha) throw new CommandError('bad_request', 'old_sha and new_sha are the same commit');
  const changed = changedBlobs(args.changed);
  // A move parked while a merge was armed isn't known yet: its reporter keeps reporting it until it's applied.
  const before = (await ctx.tx.query<{ status: string }>('SELECT status FROM base_advances WHERE project_id = $1 AND new_sha = $2', [ctx.projectId, newSha])).rows[0];
  if (before && before.status !== 'parked') return { result: { status: 'known' }, events: [] };
  const tip = (await ctx.tx.query<{ tip_sha: string }>('SELECT tip_sha FROM project_bases WHERE project_id = $1 FOR UPDATE', [ctx.projectId])).rows[0]?.tip_sha;
  if (!tip) {
    await ctx.tx.query('INSERT INTO project_bases (project_id, tip_sha) VALUES ($1, $2)', [ctx.projectId, newSha]);
    return { result: { status: 'seeded', tip: newSha }, events: [] };
  }
  if (tip !== oldSha) return { result: { status: 'stale', tip }, events: [] };
  const armed = (await ctx.tx.query<{ id: string; device_id: string }>(
    "SELECT id, device_id FROM lands WHERE project_id = $1 AND mode = 'github' AND status = 'accepted' AND merge_requested_at IS NOT NULL", [ctx.projectId])).rows[0];
  const blobs = JSON.stringify(Object.fromEntries(changed.map((c) => [c.path, c.newHash])));
  if (armed) {
    // Possibly the armed merge itself: held, unnoticed, until its outcome is known (D-115).
    if (!before) {
      await ctx.tx.query(
        "INSERT INTO base_advances (project_id, new_sha, old_sha, source, status, changed_blobs, observed_by) VALUES ($1, $2, $3, 'external', 'parked', $4, $5)",
        [ctx.projectId, newSha, oldSha, blobs, device]);
    }
    return { result: { status: 'parked', land_id: armed.id }, events: [] };
  }
  if (before) await ctx.tx.query("DELETE FROM base_advances WHERE project_id = $1 AND new_sha = $2 AND status = 'parked'", [ctx.projectId, newSha]);
  await ctx.tx.query('UPDATE project_bases SET tip_sha = $2, updated_at = now() WHERE project_id = $1', [ctx.projectId, newSha]);
  await ctx.tx.query(
    "INSERT INTO base_advances (project_id, new_sha, old_sha, source, changed_blobs, observed_by) VALUES ($1, $2, $3, 'external', $4, $5)",
    [ctx.projectId, newSha, oldSha, blobs, device]);
  const events: Events = [{ kind: 'base.advanced', data: { old_sha: oldSha, new_sha: newSha, changed_paths: changed.map((c) => c.path), observed_by: device } }];
  events.push(...await noticeLanded(ctx, { task: null, agent: null, landId: `base:${newSha}`, newBase: newSha }, changed));
  return { result: { status: 'applied' }, events };
}

/**
 * `land.external { task_id, pr_number, merge_sha, old_base_sha, changed[] }`: the task's PR was merged on GitHub without
 * the harness (D-115's honest limit). It lands once: the task is landed, its leases released, readers told. If a
 * reservation for the task is in flight, that's the harness's own merge: its device completes it, not this.
 */
export async function landExternal(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const device = requireHarnessd(ctx, 'an outside merge');
  await requireGithubProject(ctx);
  await lockInvalidation(ctx);
  const at = await lockLeases(ctx);
  const task = await lockTask(ctx, args.task_id);
  await requireTaskDevice(ctx, task.id, device);
  const n = prNumber(args.pr_number);
  const mergeSha = sha(args.merge_sha, 'merge_sha');
  const oldBase = sha(args.old_base_sha, 'old_base_sha');
  const changed = changedBlobs(args.changed);
  const pr = (await ctx.tx.query<PrRow>('SELECT * FROM task_prs WHERE task_id = $1 FOR UPDATE', [task.id])).rows[0];
  if (!pr || pr.pr_number !== n) throw new CommandError('conflict', `${task.id}'s PR isn't #${n}`);
  const inFlight = (await ctx.tx.query<{ id: string }>("SELECT id FROM lands WHERE task_id = $1 AND status IN ('requested', 'accepted')", [task.id])).rows[0];
  if (inFlight) return { result: { status: 'reservation_active', land_id: inFlight.id }, events: [] };
  // The harness's own merge of this PR, found not to be the approved squash (D-115): it never lands, from here either.
  // The task stays done, with its alert; the move of the base is a pollers' base.observe, like any outside move.
  const unapproved = (await ctx.tx.query(
    "SELECT 1 FROM events WHERE project_id = $1 AND kind = 'security.alert' AND data->>'what' = 'merge_not_approved' AND data->>'merge_sha' = $2 LIMIT 1",
    [ctx.projectId, mergeSha])).rows[0];
  if (unapproved) return { result: { status: 'not_approved' }, events: [] };
  // Another daemon's poll may have seen this merge first, as a move of the base outside the harness: its readers were
  // told then, and the chain already moved. The task still lands, once, without a second notice.
  const seen = (await ctx.tx.query<{ source: string; status: string }>('SELECT source, status FROM base_advances WHERE project_id = $1 AND new_sha = $2', [ctx.projectId, mergeSha])).rows[0];
  if (seen && seen.source !== 'external') return { result: { status: 'known' }, events: [] };
  const tip = (await ctx.tx.query<{ tip_sha: string }>('SELECT tip_sha FROM project_bases WHERE project_id = $1 FOR UPDATE', [ctx.projectId])).rows[0]?.tip_sha;
  if (!seen && tip && tip !== oldBase) return { result: { status: 'stale', tip }, events: [] };
  const id = `land_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const blobs = JSON.stringify(Object.fromEntries(changed.map((c) => [c.path, c.newHash])));
  await ctx.tx.query(
    `INSERT INTO lands (id, project_id, task_id, device_id, requested_by, status, run_tests, mode, pr_number, base_sha, head_sha, new_base_sha, changed_paths, changed_blobs, finished_at)
     VALUES ($1, $2, $3, $4, 'github', 'completed', false, 'external', $5, $6, $7, $8, $9, $10, now())`,
    [id, ctx.projectId, task.id, device, n, oldBase, pr.head_sha, mergeSha, changed.map((c) => c.path), blobs]);
  await ctx.tx.query("UPDATE tasks SET status = 'landed', landed_at = now() WHERE id = $1", [task.id]);
  await ctx.tx.query("UPDATE task_prs SET state = 'closed', merged = true, merge_sha = $2, updated_at = now() WHERE task_id = $1", [task.id, mergeSha]);
  if (seen) {
    await ctx.tx.query('UPDATE base_advances SET source = $3 WHERE project_id = $1 AND new_sha = $2', [ctx.projectId, mergeSha, `land:${id}`]);
  } else {
    await ctx.tx.query(
      `INSERT INTO project_bases (project_id, tip_sha) VALUES ($1, $2) ON CONFLICT (project_id) DO UPDATE SET tip_sha = $2, updated_at = now()`,
      [ctx.projectId, mergeSha]);
    await ctx.tx.query(
      "INSERT INTO base_advances (project_id, new_sha, old_sha, source, changed_blobs, observed_by) VALUES ($1, $2, $3, $4, $5, $6)",
      [ctx.projectId, mergeSha, oldBase, `land:${id}`, blobs, device]);
  }
  const events: Events = [
    { kind: 'land.completed', data: { land_id: id, task_id: task.id, old_base_sha: oldBase, new_base_sha: mergeSha, changed_paths: changed.map((c) => c.path), external: true, pr_number: n } },
    ...await releaseOnLand(ctx, task.id, at),
  ];
  if (!seen) events.push(...await noticeLanded(ctx, { task: task.id, agent: task.assignee_agent_id, landId: id, newBase: mergeSha }, changed));
  return { result: { status: 'landed', land_id: id }, events };
}
