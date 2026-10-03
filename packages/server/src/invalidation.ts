// The invalidation engine (0B item 2; D-22, D-53; coordination.md §2, "When invalidation fires"). It turns
// read sets plus changes into `dependency_changed` notices, from the harness, for the reading agent:
// - stage in_progress: a peer started editing a file you read (an observed claim appeared), or you read a
//   file a peer is already editing. Awareness only.
// - stage landed: a peer's change landed and the file's content now differs from what you read. harnessd
//   holds these until it has synced your branch at your turn end (D-53), then delivers them with a diff.
// Each notice is a fact, not an instruction (F-10). The same news is never sent twice, and a newer notice
// replaces any older one the agent hasn't seen whose paths it fully covers.
import { CommandError, type HandlerContext, type HandlerOutput } from './handler.ts';
import { newMessageId } from './messages.ts';

/** Tasks whose agent can still act on in-progress news. */
export const ACTIVE_READERS = ['in_progress', 'blocked'];
/** Tasks that get landed news: also finished-but-unlanded ones, whose land will merge with the new base anyway (shown to the human). */
export const LANDED_READERS = ['in_progress', 'blocked', 'done'];
const MAX_TEXT_PATHS = 20;

type Stage = 'in_progress' | 'landed';
export type NoticePath = { path: string; readHash: string | null; newHash?: string | null };
type Writer = { task: string; agent: string | null; agentName: string | null; landId?: string; newBase?: string };

const short = (h: string | null | undefined) => (h ? h.slice(0, 7) : 'unknown');
const listed = (paths: string[]) => paths.length <= MAX_TEXT_PATHS ? paths.join(', ') : `${paths.slice(0, MAX_TEXT_PATHS).join(', ')} and ${paths.length - MAX_TEXT_PATHS} more`;

/** The notice text: a fact about the files (F-10). The landed form's first sentence per path is the exact S3 wording. */
export function noticeText(stage: Stage, paths: NoticePath[], w: Writer): string {
  const who = w.agentName ? `${w.agentName} (task ${w.task})` : `task ${w.task}`;
  if (stage === 'in_progress') {
    const one = paths.length === 1;
    const hashes = one ? ` at hash ${short(paths[0]!.readHash)}` : '';
    return `${listed(paths.map((p) => p.path))}: ${who} is changing ${one ? 'this file' : 'these files'}, which you read${hashes}. The change hasn't landed yet.`;
  }
  const lines = paths.slice(0, MAX_TEXT_PATHS).map((p) =>
    `Dependency changed: ${p.path} has changed since you read it. (You read ${short(p.readHash)}; it's now ${p.newHash ? short(p.newHash) : 'deleted'}.)`);
  if (paths.length > MAX_TEXT_PATHS) lines.push(`… and ${paths.length - MAX_TEXT_PATHS} more files.`);
  lines.push(`Landed by ${who}.`);
  return lines.join('\n');
}

/**
 * Sends one reader one notice covering `paths`, after dropping news it already got. Returns the events,
 * or none if nothing was new. Older undelivered notices whose every path this one covers are superseded.
 */
export async function sendNotice(ctx: HandlerContext, reader: { task: string; agent: string }, stage: Stage, paths: NoticePath[], w: Writer): Promise<HandlerOutput['events']> {
  const sorted = [...new Map(paths.map((p) => [p.path, p])).values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  const already = new Set((await ctx.tx.query<{ path: string }>(
    `SELECT path FROM dependency_notices WHERE reader_task = $1 AND path = ANY($2) AND stage = $3 AND writer_task = $4 AND coalesce(land_id, '') = $5`,
    [reader.task, sorted.map((p) => p.path), stage, w.task, w.landId ?? ''])).rows.map((r) => r.path));
  const fresh = sorted.filter((p) => !already.has(p.path));
  if (!fresh.length) return [];
  const id = newMessageId();
  const text = noticeText(stage, fresh, w);
  const data = {
    stage, paths: fresh.map((p) => p.path), changed_by: w.agent, writer_task: w.task, ...(w.landId ? { land_id: w.landId } : {}),
    // The base commit that has the change: harnessd says "your branch now includes it" only once it does.
    ...(w.newBase ? { new_base_sha: w.newBase } : {}),
    read_hashes: Object.fromEntries(fresh.map((p) => [p.path, p.readHash])),
    ...(stage === 'landed' ? { new_hashes: Object.fromEntries(fresh.map((p) => [p.path, p.newHash ?? null])) } : {}),
  };
  await ctx.tx.query(
    `INSERT INTO messages (id, project_id, kind, from_principal, to_principal, text, data, priority, from_task_id, to_task_id)
     VALUES ($1, $2, 'dependency_changed', 'harness', $3, $4, $5, 'high', NULL, $6)`,
    [id, ctx.projectId, reader.agent, text, JSON.stringify(data), reader.task]);
  for (const p of fresh) {
    await ctx.tx.query(
      `INSERT INTO dependency_notices (message_id, project_id, reader_task, path, stage, writer_task, land_id, read_hash, new_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, ctx.projectId, reader.task, p.path, stage, w.task, w.landId ?? null, p.readHash, p.newHash ?? null]);
  }
  const events: HandlerOutput['events'] = [{
    kind: 'message.sent',
    data: { message_id: id, kind: 'dependency_changed', from: 'harness', to: reader.agent, text, ...data, priority: 'high', from_task_id: null, to_task_id: reader.task },
  }];
  // Newer replaces older (coordination §2): an undelivered notice to this reader whose paths are all covered here.
  const older = (await ctx.tx.query<{ id: string }>(
    `SELECT m.id FROM messages m
     WHERE m.project_id = $1 AND m.kind = 'dependency_changed' AND m.to_task_id = $2 AND m.id <> $3
       AND m.delivered_at IS NULL AND m.superseded_by IS NULL
       -- in-progress news never replaces landed news, which a sync still has to deliver (D-53)
       AND ($5 = 'landed' OR m.data->>'stage' = 'in_progress')
       AND NOT EXISTS (SELECT 1 FROM dependency_notices d WHERE d.message_id = m.id AND NOT (d.path = ANY($4)))
     ORDER BY m.id`, [ctx.projectId, reader.task, id, fresh.map((p) => p.path), stage])).rows;
  for (const o of older) {
    await ctx.tx.query('UPDATE messages SET superseded_by = $2 WHERE id = $1', [o.id, id]);
    events.push({ kind: 'message.superseded', data: { message_id: o.id, by: id, to_task_id: reader.task } });
  }
  return events;
}

/**
 * Reads and edits of one project are checked against each other under one lock, so a first read and a first
 * edit of the same file in two concurrent commands can't both miss each other. Every command that takes it
 * takes it first, before any row lock: one lock order, so no deadlock with the row locks taken after it.
 */
export async function lockInvalidation(ctx: HandlerContext): Promise<void> {
  await ctx.tx.query("SELECT pg_advisory_xact_lock(hashtext('harness.invalidation:' || $1))", [ctx.projectId]);
}

/**
 * Trigger 2b: `reader` just read files that a land completed after its branch's base has changed. Its
 * worktree doesn't have that land yet, so what it read is already stale: it hears it landed, and the sync
 * follows (D-53). Reads whose hash equals the landed blob are what landed: no notice.
 */
export async function noticeReadsAfterLands(ctx: HandlerContext, reader: { task: string; agent: string }, reads: { path: string; hash: string | null }[]): Promise<HandlerOutput['events']> {
  if (!reads.length) return [];
  const lands = (await ctx.tx.query<{ id: string; task_id: string; agent_id: string | null; new_base_sha: string; changed_blobs: Record<string, string | null> }>(
    `SELECT l.id, l.task_id, w.assignee_agent_id AS agent_id, l.new_base_sha, l.changed_blobs
     FROM lands l JOIN tasks r ON r.id = $2 JOIN tasks w ON w.id = l.task_id
     WHERE l.project_id = $1 AND l.status = 'completed' AND l.task_id <> $2 AND l.changed_blobs IS NOT NULL
       AND r.base_set_at IS NOT NULL AND l.finished_at > r.base_set_at
     ORDER BY l.finished_at`, [ctx.projectId, reader.task])).rows;
  // The latest land wins per path.
  const latest = new Map<string, (typeof lands)[number]>();
  for (const l of lands) for (const p of Object.keys(l.changed_blobs)) latest.set(p, l);
  const byLand = new Map<string, { land: (typeof lands)[number]; paths: NoticePath[] }>();
  for (const r of reads) {
    const l = latest.get(r.path);
    if (!l) continue;
    const blob = l.changed_blobs[r.path] ?? null;
    if (r.hash !== null && r.hash === blob) continue;
    const x = byLand.get(l.id) ?? { land: l, paths: [] };
    x.paths.push({ path: r.path, readHash: r.hash, newHash: blob });
    byLand.set(l.id, x);
  }
  const events: HandlerOutput['events'] = [];
  for (const { land, paths } of byLand.values()) {
    events.push(...await sendNotice(ctx, reader, 'landed', paths, { ...await writerInfo(ctx, land.task_id, land.agent_id), landId: land.id, newBase: land.new_base_sha }));
  }
  return events;
}

/** Trigger 1: `writer` started editing `paths` (new observed claims). Readers of those files hear about it. */
export async function noticeEditsInProgress(ctx: HandlerContext, writer: { task: string; agent: string }, paths: string[]): Promise<HandlerOutput['events']> {
  if (!paths.length) return [];
  const rows = (await ctx.tx.query<{ task_id: string; agent_id: string; path: string; content_hash: string | null }>(
    `SELECT r.task_id, t.assignee_agent_id AS agent_id, r.path, r.content_hash FROM read_entries r JOIN tasks t ON t.id = r.task_id
     WHERE r.project_id = $1 AND r.path = ANY($2) AND r.task_id <> $3 AND t.status = ANY($4) AND t.assignee_agent_id IS NOT NULL
     ORDER BY r.task_id, r.path`, [ctx.projectId, paths, writer.task, ACTIVE_READERS])).rows;
  return byReader(ctx, rows, 'in_progress', await writerInfo(ctx, writer.task, writer.agent));
}

/** Trigger 2: `reader` just read `paths`; any another active task is already editing. */
export async function noticeReadsOfEdits(ctx: HandlerContext, reader: { task: string; agent: string }, reads: { path: string; hash: string | null }[]): Promise<HandlerOutput['events']> {
  if (!reads.length) return [];
  const hashes = new Map(reads.map((r) => [r.path, r.hash]));
  const claims = (await ctx.tx.query<{ task_id: string; agent_id: string | null; path: string }>(
    `SELECT c.task_id, t.assignee_agent_id AS agent_id, c.path FROM claims c JOIN tasks t ON t.id = c.task_id
     WHERE c.project_id = $1 AND c.kind = 'observed' AND c.cleared_at IS NULL AND c.path = ANY($2) AND c.task_id <> $3 AND t.status = ANY($4)
     ORDER BY c.task_id, c.path`, [ctx.projectId, [...hashes.keys()], reader.task, ACTIVE_READERS])).rows;
  const events: HandlerOutput['events'] = [];
  const byWriter = new Map<string, { agent: string | null; paths: NoticePath[] }>();
  for (const c of claims) {
    const w = byWriter.get(c.task_id) ?? { agent: c.agent_id, paths: [] };
    w.paths.push({ path: c.path, readHash: hashes.get(c.path) ?? null });
    byWriter.set(c.task_id, w);
  }
  for (const [task, w] of byWriter) events.push(...await sendNotice(ctx, reader, 'in_progress', w.paths, await writerInfo(ctx, task, w.agent)));
  return events;
}

/** Trigger 3: `writer`'s land changed these paths on the base. Readers whose hash differs hear it landed. */
export async function noticeLanded(ctx: HandlerContext, writer: { task: string; agent: string | null; landId: string; newBase: string }, changed: { path: string; newHash: string | null }[]): Promise<HandlerOutput['events']> {
  if (!changed.length) return [];
  const next = new Map(changed.map((c) => [c.path, c.newHash]));
  const rows = (await ctx.tx.query<{ task_id: string; agent_id: string; path: string; content_hash: string | null }>(
    `SELECT r.task_id, t.assignee_agent_id AS agent_id, r.path, r.content_hash FROM read_entries r JOIN tasks t ON t.id = r.task_id
     WHERE r.project_id = $1 AND r.path = ANY($2) AND r.task_id <> $3 AND t.status = ANY($4) AND t.assignee_agent_id IS NOT NULL
     ORDER BY r.task_id, r.path`, [ctx.projectId, [...next.keys()], writer.task, LANDED_READERS])).rows
    // The exact rule: notify if the new content isn't what the reader read. An unknown hash always counts as changed.
    .filter((r) => r.content_hash === null || r.content_hash !== next.get(r.path));
  return byReader(ctx, rows.map((r) => ({ ...r, newHash: next.get(r.path) ?? null })), 'landed', { ...await writerInfo(ctx, writer.task, writer.agent), landId: writer.landId, newBase: writer.newBase });
}

async function byReader(ctx: HandlerContext, rows: { task_id: string; agent_id: string; path: string; content_hash: string | null; newHash?: string | null }[], stage: Stage, w: Writer): Promise<HandlerOutput['events']> {
  const readers = new Map<string, { agent: string; paths: NoticePath[] }>();
  for (const r of rows) {
    const x = readers.get(r.task_id) ?? { agent: r.agent_id, paths: [] };
    x.paths.push({ path: r.path, readHash: r.content_hash, ...(r.newHash !== undefined ? { newHash: r.newHash } : {}) });
    readers.set(r.task_id, x);
  }
  const events: HandlerOutput['events'] = [];
  for (const [task, x] of readers) events.push(...await sendNotice(ctx, { task, agent: x.agent }, stage, x.paths, w));
  return events;
}

async function writerInfo(ctx: HandlerContext, task: string, agent: string | null): Promise<Writer> {
  if (!agent) return { task, agent: null, agentName: null };
  const name = (await ctx.tx.query<{ name: string }>('SELECT name FROM agent_principals WHERE id = $1', [agent])).rows[0]?.name ?? null;
  if (name === null) throw new CommandError('internal', `agent ${agent} vanished`);
  return { task, agent, agentName: name };
}
