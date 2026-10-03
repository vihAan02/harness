// Read sets (0B item 1; D-22, D-23, D-88; coordination.md §2). harnessd reports what its agents read, as
// the agent, from its device: repo-relative paths with the Git blob id it hashed from disk, the capture
// source and its confidence. Paths and hashes only, never contents (TH-12). An entry that changes logs
// `readset.added`; re-reading the same content is a no-op.
import { normalizeFilePath } from './claims.ts';
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { lockInvalidation, noticeReadsAfterLands, noticeReadsOfEdits } from './invalidation.ts';
import { requireAgentOnDevice } from './sessions.ts';

export const MAX_ENTRIES = 200;
const SOURCES = ['read_tool', 'search_hit', 'shell_heuristic', 'edit_base', 'instructions'] as const;
const CONFIDENCE = ['high', 'medium', 'low'] as const;
const RANK: Record<string, number> = { low: 0, medium: 1, high: 2 };
/** A Git blob id: SHA-1 or SHA-256 hex. */
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Tasks whose agent can still be told about a change: active, or blocked on a sync conflict. */
export const READER_STATUSES = ['in_progress', 'blocked'];

export type ReadEntry = {
  path: string; hash: string | null; source: (typeof SOURCES)[number]; confidence: (typeof CONFIDENCE)[number];
  range?: { start: number; lines: number };
};

function parseEntry(raw: unknown, i: number): ReadEntry {
  const e = raw as Record<string, unknown>;
  if (typeof e !== 'object' || e === null) throw new CommandError('bad_request', `entries[${i}] is not an object`);
  const path = normalizeFilePath(e.path);
  const hash = e.hash === null ? null : typeof e.hash === 'string' && HASH.test(e.hash) ? e.hash : undefined;
  if (hash === undefined) throw new CommandError('bad_request', `entries[${i}].hash must be a Git blob id or null`);
  if (!SOURCES.includes(e.source as ReadEntry['source'])) throw new CommandError('bad_request', `entries[${i}].source must be one of ${SOURCES.join(', ')}`);
  if (!CONFIDENCE.includes(e.confidence as ReadEntry['confidence'])) throw new CommandError('bad_request', `entries[${i}].confidence must be high, medium or low`);
  let range: ReadEntry['range'];
  if (e.range !== undefined) {
    const r = e.range as Record<string, unknown>;
    if (!Number.isSafeInteger(r?.start) || !Number.isSafeInteger(r?.lines) || (r.start as number) < 1 || (r.lines as number) < 1) {
      throw new CommandError('bad_request', `entries[${i}].range must be { start ≥ 1, lines ≥ 1 }`);
    }
    range = { start: r.start as number, lines: r.lines as number };
  }
  return { path, hash, source: e.source as ReadEntry['source'], confidence: e.confidence as ReadEntry['confidence'], ...(range ? { range } : {}) };
}

/** `readset.add { session_id, entries[{ path, hash, source, confidence, range? }] }` → `readset.added`. */
export async function addReadset(ctx: HandlerContext, args: Record<string, unknown>): Promise<HandlerOutput> {
  const { agentId, deviceId } = requireAgentOnDevice(ctx);
  if (!Array.isArray(args.entries) || args.entries.length === 0 || args.entries.length > MAX_ENTRIES) {
    throw new CommandError('bad_request', `entries must be a list of 1 to ${MAX_ENTRIES}`);
  }
  // The last report of a path in one batch wins, as if they'd come one by one.
  const entries = [...new Map(args.entries.map((e, i) => parseEntry(e, i)).map((e) => [e.path, e])).values()];
  const sess = (await ctx.tx.query<{ task_id: string; agent_id: string; device_id: string; task_status: string }>(
    `SELECT s.task_id, s.agent_id, s.device_id, t.status AS task_status FROM agent_sessions s JOIN tasks t ON t.id = s.task_id
     WHERE s.id = $1 AND t.project_id = $2`, [args.session_id, ctx.projectId])).rows[0];
  if (!sess) throw new CommandError('not_found', `no session ${String(args.session_id)} in this project`);
  if (sess.agent_id !== agentId || sess.device_id !== deviceId) throw new CommandError('forbidden', 'that session belongs to another agent or device');
  const taskId = sess.task_id;
  if (!READER_STATUSES.includes(sess.task_status)) return { result: { changed: [] }, events: [] }; // reads end with the task

  await lockInvalidation(ctx); // first: see lockInvalidation
  // Serialize with this task's other reports (claims and reads), in path order.
  await ctx.tx.query('SELECT id FROM tasks WHERE id = $1 FOR NO KEY UPDATE', [taskId]);
  const prev = new Map((await ctx.tx.query<{ path: string; content_hash: string | null; confidence: string; stale: boolean }>(
    'SELECT path, content_hash, confidence, stale FROM read_entries WHERE task_id = $1 AND path = ANY($2)', [taskId, entries.map((e) => e.path)])).rows.map((r) => [r.path, r]));
  const changed: ReadEntry[] = [];
  for (const e of entries.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const p = prev.get(e.path);
    // Same content again: keep the strongest confidence, clear `stale` (the agent has now seen it), log nothing.
    if (p && p.content_hash === e.hash && e.hash !== null) {
      if (p.stale || RANK[e.confidence]! > RANK[p.confidence]!) {
        await ctx.tx.query(
          `UPDATE read_entries SET stale = false, session_id = $5, observed_at = now(),
             confidence = CASE WHEN $3 THEN $4 ELSE confidence END, source = CASE WHEN $3 THEN $6 ELSE source END
           WHERE task_id = $1 AND path = $2`, [taskId, e.path, RANK[e.confidence]! > RANK[p.confidence]!, e.confidence, args.session_id, e.source]);
        if (p.stale) changed.push(e);
      }
      continue;
    }
    await ctx.tx.query(
      `INSERT INTO read_entries (project_id, task_id, session_id, agent_id, path, content_hash, source, confidence, range_start, range_lines)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (task_id, path) DO UPDATE SET session_id = $3, content_hash = $6, source = $7, confidence = $8,
         range_start = $9, range_lines = $10, stale = false, observed_at = now()`,
      [ctx.projectId, taskId, args.session_id, agentId, e.path, e.hash, e.source, e.confidence, e.range?.start ?? null, e.range?.lines ?? null]);
    changed.push(e);
  }
  const events: HandlerOutput['events'] = changed.length
    ? [{ kind: 'readset.added', data: { task_id: taskId, session_id: args.session_id, agent_id: agentId, entries: changed } }]
    : [];
  // Stale context (0B item 2): reading a file another agent is already changing is news too, and so is
  // reading one a land has changed since this branch's base (the worktree doesn't have it yet).
  events.push(...await noticeReadsOfEdits(ctx, { task: taskId, agent: agentId }, changed));
  events.push(...await noticeReadsAfterLands(ctx, { task: taskId, agent: agentId }, changed));
  return { result: { changed: changed.map((e) => e.path) }, events };
}
