// Soft claims and overlap warnings (D-20, D-21; coordination.md §1). Claims are awareness signals, not
// locks (principle 7): nothing here blocks an edit.
// - Prospective claims come from a task's scope when it's created.
// - Observed claims come from harnessd: edit hooks (precise, immediate) and worktree diffs against the
//   merge base (complete, catch background writes; D-70). A diff report is the full set, so it also
//   clears claims on files that no longer differ.
// - An observed claim that overlaps another active task's claim is an overlap: logged once per pair and
//   path, and both agents get a claim_conflict message. Scope-only overlaps go to the human at task creation.
import { randomUUID } from 'node:crypto';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { lockInvalidation, noticeEditsInProgress } from './invalidation.ts';
import { newMessageId } from './messages.ts';
import { requireAgentOnDevice } from './sessions.ts';

const MAX_PATHS = 5000;
/** Tasks whose claims count. A task blocked on a sync conflict still has its work in progress (D-53). */
const ACTIVE = ['open', 'in_progress', 'blocked'];

/** coordination.md §1: a prefix overlaps any path or prefix under it; an exact file overlaps itself and any prefix containing it. */
export function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.endsWith('/') && b.startsWith(a)) return true;
  if (b.endsWith('/') && a.startsWith(b)) return true;
  return false;
}

/** Control characters in a path could forge lines in another agent's notice (D-25), so paths never carry them. */
export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** A repo-relative, normalized file path, as harnessd reports observed edits. */
export function normalizeFilePath(raw: unknown): string {
  if (typeof raw !== 'string' || !raw || raw.length > 1000 || raw.startsWith('/') || raw.endsWith('/') || CONTROL_CHARS.test(raw)) {
    throw new CommandError('bad_request', `bad path ${JSON.stringify(raw)}: use a repo-relative file path`);
  }
  if (raw.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new CommandError('bad_request', `bad path ${JSON.stringify(raw)}: not normalized`);
  return raw;
}

type Claim = { task_id: string; kind: string; path: string; assignee_agent_id: string | null };

/** Active claims of every other active task in the project. */
async function othersClaims(ctx: HandlerContext, taskId: string): Promise<Claim[]> {
  return (await ctx.tx.query<Claim>(
    `SELECT c.task_id, c.kind, c.path, t.assignee_agent_id FROM claims c JOIN tasks t ON t.id = c.task_id
     WHERE c.project_id = $1 AND c.cleared_at IS NULL AND c.task_id <> $2 AND t.status = ANY($3)
     ORDER BY c.task_id, c.path`, // a fixed order, so concurrent observations lock overlap rows in the same order
    [ctx.projectId, taskId, ACTIVE])).rows;
}

/** Records an overlap once per pair and path; returns its id if it's new. */
async function recordOverlap(ctx: HandlerContext, t1: string, t2: string, path: string, level: 'prospective' | 'observed'): Promise<string | null> {
  const [a, b] = t1 < t2 ? [t1, t2] : [t2, t1];
  const id = `ovl_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const r = await ctx.tx.query(
    `INSERT INTO overlap_warnings (id, project_id, task_a, task_b, path, level) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (project_id, task_a, task_b, path, level) DO NOTHING RETURNING id`, [id, ctx.projectId, a, b, path, level]);
  return r.rowCount ? id : null;
}

/**
 * At task creation: the new task's prospective claims, and overlaps of its scope with other active
 * tasks' claims. Those are reported to the human (in the result and the log), not to agents (coordination §1).
 */
export async function claimScope(ctx: HandlerContext, taskId: string, scope: string[]): Promise<{ events: HandlerOutput['events']; overlaps: { task_id: string; paths: string[] }[] }> {
  if (!scope.length) return { events: [], overlaps: [] };
  await ctx.tx.query(
    "INSERT INTO claims (project_id, task_id, kind, path) SELECT $1, $2, 'prospective', unnest($3::text[])", [ctx.projectId, taskId, scope]);
  const events: HandlerOutput['events'] = [{ kind: 'claim.prospective', data: { task_id: taskId, paths: scope } }];
  const byTask = new Map<string, { id: string; paths: Set<string> }>();
  for (const c of await othersClaims(ctx, taskId)) {
    for (const p of scope) {
      if (!overlaps(p, c.path)) continue;
      const path = p.length >= c.path.length ? p : c.path; // the more specific of the two
      const id = await recordOverlap(ctx, taskId, c.task_id, path, 'prospective');
      if (!id) continue;
      const o = byTask.get(c.task_id) ?? { id, paths: new Set<string>() };
      byTask.set(c.task_id, o);
      o.paths.add(path);
    }
  }
  const found = [...byTask].map(([other, o]) => ({ task_id: other, overlap_id: o.id, paths: [...o.paths].sort() }));
  for (const o of found) {
    events.push({ kind: 'overlap.detected', data: { overlap_id: o.overlap_id, level: 'prospective', paths: o.paths, tasks: [taskId, o.task_id] } });
  }
  return { events, overlaps: found.map(({ task_id, paths }) => ({ task_id, paths })) };
}

/** When a task ends, its claims end with it (coordination §1). */
export async function clearTaskClaims(ctx: HandlerContext, taskId: string): Promise<HandlerOutput['events']> {
  const cleared = (await ctx.tx.query<{ kind: string; path: string }>(
    'UPDATE claims SET cleared_at = now() WHERE task_id = $1 AND cleared_at IS NULL RETURNING kind, path', [taskId])).rows;
  const events: HandlerOutput['events'] = [];
  for (const kind of ['prospective', 'observed']) {
    const paths = cleared.filter((c) => c.kind === kind).map((c) => c.path).sort();
    if (paths.length) events.push({ kind: 'claim.cleared', data: { task_id: taskId, claim_kind: kind, paths, reason: 'task ended' } });
  }
  return events;
}

/** The text of a claim_conflict: a fact, not an instruction (F-10). Rendered into an envelope by harnessd. */
function conflictText(paths: string[], otherTask: string, otherAgentName: string | null, otherKind: string): string {
  const who = otherAgentName ? `${otherAgentName} (task ${otherTask})` : `task ${otherTask} (not assigned yet)`;
  const one = paths.length === 1;
  return otherKind === 'observed'
    ? `${paths.join(', ')}: ${who} is also changing ${one ? 'this file' : 'these files'}.`
    : `${paths.join(', ')}: ${one ? 'this file is' : 'these files are'} in the scope of ${who}.`;
}

/** `claim.observe { session_id, paths[], source: hook | diff }` → `claim.observed`, `claim.cleared`, `overlap.detected`, `message.sent` (claim_conflict). */
export async function observeClaims(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const { agentId, deviceId } = requireAgentOnDevice(ctx);
  const source = args.source;
  if (source !== 'hook' && source !== 'diff') throw new CommandError('bad_request', 'source must be hook or diff');
  if (!Array.isArray(args.paths) || args.paths.length > MAX_PATHS) throw new CommandError('bad_request', `paths must be a list of up to ${MAX_PATHS}`);
  const paths = [...new Set(args.paths.map(normalizeFilePath))].sort();
  const sess = (await ctx.tx.query<{ task_id: string; agent_id: string; device_id: string; status: string; task_status: string }>(
    `SELECT s.task_id, s.agent_id, s.device_id, s.status, t.status AS task_status FROM agent_sessions s JOIN tasks t ON t.id = s.task_id
     WHERE s.id = $1 AND t.project_id = $2`, [args.session_id, ctx.projectId])).rows[0];
  if (!sess) throw new CommandError('not_found', `no session ${String(args.session_id)} in this project`);
  if (sess.agent_id !== agentId || sess.device_id !== deviceId) throw new CommandError('forbidden', 'that session belongs to another agent or device');
  const taskId = sess.task_id;
  if (sess.task_status !== 'in_progress' && sess.task_status !== 'blocked') return { result: { added: [], cleared: [] }, events: [] }; // claims ended with the task

  await lockInvalidation(ctx); // first: see lockInvalidation
  // Serialize observations per task, so concurrent reports don't both add the same path. NO KEY UPDATE: it
  // doesn't block the foreign-key checks of rows other commands insert for this task (notices, say).
  await ctx.tx.query('SELECT id FROM tasks WHERE id = $1 FOR NO KEY UPDATE', [taskId]);
  const active = new Set((await ctx.tx.query<{ path: string }>(
    "SELECT path FROM claims WHERE task_id = $1 AND kind = 'observed' AND cleared_at IS NULL", [taskId])).rows.map((r) => r.path));
  const added = paths.filter((p) => !active.has(p));
  const cleared = source === 'diff' ? [...active].filter((p) => !paths.includes(p)).sort() : [];
  const events: HandlerOutput['events'] = [];
  if (added.length) {
    await ctx.tx.query(
      "INSERT INTO claims (project_id, task_id, session_id, kind, path) SELECT $1, $2, $3, 'observed', unnest($4::text[])",
      [ctx.projectId, taskId, args.session_id, added]);
    events.push({ kind: 'claim.observed', data: { task_id: taskId, session_id: args.session_id, paths: added, source } });
  }
  if (cleared.length) {
    await ctx.tx.query("UPDATE claims SET cleared_at = now() WHERE task_id = $1 AND kind = 'observed' AND cleared_at IS NULL AND path = ANY($2)", [taskId, cleared]);
    events.push({ kind: 'claim.cleared', data: { task_id: taskId, claim_kind: 'observed', paths: cleared, source } });
  }

  // New observed claims against every other active task's claims.
  const fresh = new Map<string, { id: string; paths: Set<string>; kinds: Set<string>; assignee: string | null }>();
  for (const c of added.length ? await othersClaims(ctx, taskId) : []) {
    for (const p of added) {
      if (!overlaps(p, c.path)) continue;
      const id = await recordOverlap(ctx, taskId, c.task_id, p, 'observed');
      // Not new: reported by an earlier observation. Unless it's this observation's path again, via another of that task's claims.
      if (!id && !fresh.get(c.task_id)?.paths.has(p)) continue;
      const f = fresh.get(c.task_id) ?? { id: id!, paths: new Set(), kinds: new Set(), assignee: c.assignee_agent_id };
      f.paths.add(p);
      f.kinds.add(c.kind);
      fresh.set(c.task_id, f);
    }
  }
  const names = new Map((await ctx.tx.query<{ id: string; name: string }>('SELECT id, name FROM agent_principals WHERE project_id = $1', [ctx.projectId])).rows.map((r) => [r.id, r.name]));
  for (const [other, f] of fresh) {
    const ps = [...f.paths].sort();
    const otherKind = f.kinds.has('observed') ? 'observed' : 'prospective';
    const overlapId = f.id;
    events.push({ kind: 'overlap.detected', data: { overlap_id: overlapId, level: 'observed', paths: ps, tasks: [taskId, other], claim_kinds: [...f.kinds].sort() } });
    // Both agents hear about it at their next safe boundary (coordination §1). The observer's task is in progress, so it has an assignee.
    const notes = [
      { to: agentId, toTask: taskId, otherTask: other, otherAgent: f.assignee, text: conflictText(ps, other, f.assignee ? names.get(f.assignee) ?? f.assignee : null, otherKind) },
      ...(f.assignee ? [{ to: f.assignee, toTask: other, otherTask: taskId, otherAgent: agentId, text: conflictText(ps, taskId, names.get(agentId) ?? agentId, 'observed') }] : []),
    ];
    for (const n of notes) {
      const id = newMessageId();
      const data = { paths: ps, other_task: n.otherTask, other_agent: n.otherAgent, level: 'observed', overlap_id: overlapId };
      await ctx.tx.query(
        `INSERT INTO messages (id, project_id, kind, from_principal, to_principal, text, data, priority, from_task_id, to_task_id)
         VALUES ($1, $2, 'claim_conflict', 'harness', $3, $4, $5, 'high', NULL, $6)`,
        [id, ctx.projectId, n.to, n.text, JSON.stringify(data), n.toTask]);
      events.push({ kind: 'message.sent', data: { message_id: id, kind: 'claim_conflict', from: 'harness', to: n.to, text: n.text, ...data, priority: 'high', from_task_id: null, to_task_id: n.toTask } });
    }
  }
  // Stale context (0B item 2): agents that read these files hear that they're being changed.
  if (added.length) events.push(...await noticeEditsInProgress(ctx, { task: taskId, agent: agentId }, added));
  return { result: { added, cleared }, events };
}
