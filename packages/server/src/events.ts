// The append-only event log (D-12; docs/protocol.md §3).
// Seqs come from the project's counter row, bumped in the same transaction as the insert. That row
// lock is held until commit, so writers to one project are serialized and seqs are dense and
// commit-ordered: a reader resuming "after N" never skips an event that commits late. A bigserial
// cursor can't promise that, because sequence values are handed out before commit (F-56).
import type pg from 'pg';

export type NewEvent = { kind: string; actor: string; onBehalfOf?: string; deviceId?: string; data?: unknown };
export type StoredEvent = {
  projectId: string; seq: number; at: Date; actor: string; onBehalfOf: string | null;
  deviceId: string | null; kind: string; data: unknown;
};

/**
 * Appends events inside the caller's transaction, which also holds the state change they record
 * (protocol.md §1). Returns their seqs. Throws outside a transaction: autocommitting the counter
 * update would release its lock before the insert and break commit ordering.
 */
export async function appendEvents(tx: pg.ClientBase, projectId: string, events: NewEvent[]): Promise<number[]> {
  if (events.length === 0) return [];
  await tx.query('SAVEPOINT append_events'); // errors unless we're inside a transaction block
  const bumped = await tx.query<{ next_seq: string }>(
    'UPDATE projects SET next_seq = next_seq + $2 WHERE id = $1 RETURNING next_seq', [projectId, events.length]);
  const last = bumped.rows[0]?.next_seq;
  if (last === undefined) throw new Error(`unknown project ${projectId}`);
  const seqs = events.map((_, i) => Number(last) - events.length + 1 + i);
  await tx.query(
    `INSERT INTO events (project_id, seq, actor_principal, on_behalf_of, device_id, kind, data)
     SELECT $1, * FROM unnest($2::bigint[], $3::text[], $4::text[], $5::text[], $6::text[], $7::jsonb[])`,
    [projectId, seqs, events.map((e) => e.actor), events.map((e) => e.onBehalfOf ?? null), events.map((e) => e.deviceId ?? null),
      events.map((e) => e.kind), events.map((e) => JSON.stringify(e.data ?? {}))]);
  await tx.query('RELEASE SAVEPOINT append_events');
  return seqs;
}

/** Postgres channel for the fan-out wake-up. Payload: a project id, never an event (D-11, F-54). */
export const EVENTS_CHANNEL = 'harness_events';

/** Wakes the fan-out for a project when the caller's transaction commits. Send at most one per transaction (F-55). */
export async function notifyProject(tx: pg.ClientBase, projectId: string): Promise<void> {
  await tx.query('SELECT pg_notify($1, $2)', [EVENTS_CHANNEL, projectId]);
}

/** Committed events after `afterSeq`, in seq order. */
export async function readEvents(db: pg.Pool | pg.ClientBase, projectId: string, afterSeq: number, limit = 1000): Promise<StoredEvent[]> {
  const r = await db.query(
    `SELECT seq, at, actor_principal, on_behalf_of, device_id, kind, data FROM events
     WHERE project_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`, [projectId, afterSeq, limit]);
  return r.rows.map((row) => ({
    projectId, seq: Number(row.seq), at: row.at, actor: row.actor_principal, onBehalfOf: row.on_behalf_of,
    deviceId: row.device_id, kind: row.kind, data: row.data,
  }));
}
