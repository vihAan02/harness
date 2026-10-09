import { randomUUID, type KeyObject } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import type { DispatchEnvelope, DispatchKind, SignedDispatch } from '@harness/protocol';
import { messageSha256, newNonce, signDispatch, taskSha256 } from '@harness/protocol/signing';
import { createPool, migrate } from '../src/db.ts';
import type { HandlerContext } from '../src/handler.ts';
import { lockLeases } from '../src/leases.ts';

export const TEST_DATABASE_URL = process.env.HARNESS_TEST_DATABASE_URL ?? 'postgresql://localhost:5432/harness_test';

async function admin<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
  try {
    await c.connect();
  } catch (e) {
    throw new Error(`Can't reach the test database at ${TEST_DATABASE_URL}: ${(e as Error).message}. See "Running locally" in README.md.`);
  }
  try { return await fn(c); } finally { await c.end(); }
}

/** A migrated, throwaway schema in the test database, so test files can run in parallel. */
export async function freshSchema() {
  const schema = `t_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await admin((c) => c.query(`CREATE SCHEMA ${schema}`));
  const pool = createPool(TEST_DATABASE_URL, schema);
  await migrate(pool);
  return {
    pool, schema,
    drop: async () => { await pool.end(); await admin((c) => c.query(`DROP SCHEMA ${schema} CASCADE`)); },
  };
}

/** A project with one owning human; returns the project id. */
export async function seedProject(pool: pg.Pool): Promise<string> {
  const id = `prj_${randomUUID().slice(0, 8)}`;
  await pool.query("INSERT INTO human_principals (id, display_name) VALUES ('human_test', 'Test') ON CONFLICT DO NOTHING");
  await pool.query('INSERT INTO projects (id, name) VALUES ($1, $1)', [id]);
  await pool.query("INSERT INTO project_memberships (project_id, human_id, role) VALUES ($1, 'human_test', 'owner')", [id]);
  return id;
}

/**
 * Holds a project's lease lock in a transaction of its own, like a lease command in progress (D-97), until
 * `release()`. `queued()` finds a command waiting behind it and returns that command's transaction start,
 * which is what `now()` means in it; it returns null if `done()` turns true first (nothing waited).
 * The query reads `pg_stat_activity` (a snapshot) before `pg_locks` (live), so a command that began and queued
 * between the two reads shows as waiting with no transaction start yet: that one is looked at again.
 */
export async function holdLeaseLock(pool: pg.Pool, projectId: string) {
  const tx = await pool.connect();
  await tx.query('BEGIN');
  await lockLeases({ tx, projectId } as unknown as HandlerContext);
  let open = true;
  return {
    tx,
    async queued(done: () => boolean): Promise<Date | null> {
      for (const until = Date.now() + 10_000; Date.now() < until; await sleep(5)) {
        const waiting = (await pool.query<{ xact_start: Date | null }>(
          `SELECT a.xact_start FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
           WHERE l.locktype = 'advisory' AND NOT l.granted AND l.objsubid = 1
             AND l.classid::bigint = (hashtext('harness.leases:' || $1)::bigint >> 32) & 4294967295
             AND l.objid::bigint = hashtext('harness.leases:' || $1)::bigint & 4294967295`, [projectId])).rows[0];
        if (waiting?.xact_start) return waiting.xact_start;
        if (done()) return null;
      }
      throw new Error('nothing queued for the lease lock, and nothing finished');
    },
    async release() {
      if (!open) return;
      open = false;
      try { await tx.query('COMMIT'); } finally { tx.release(); }
    },
  };
}

/** Returns once the server's clock is past `at`. */
export async function untilPast(pool: pg.Pool, at: Date | string): Promise<void> {
  while (!(await pool.query<{ past: boolean }>('SELECT clock_timestamp() > $1::timestamptz AS past', [at])).rows[0]!.past) await sleep(5);
}

/**
 * A dispatch for a human's lifecycle command on `taskId` (D-112; protocol.md §11), signed with the issuing device's
 * key, from the task as the server stores it and the coordinator's epoch. Ten minutes to live: tests never need more.
 */
export async function dispatchFor(pool: pg.Pool, key: KeyObject, o: {
  kind: DispatchKind; projectId: string; taskId: string; agentId: string; targetDevice: string;
  issuerHuman: string; issuerDevice: string; message?: string; integrate?: NonNullable<DispatchEnvelope['integrate']>;
}): Promise<SignedDispatch> {
  const t = (await pool.query<{ title: string; text: string; scope: string[]; owner_human_id: string }>(
    'SELECT title, text, scope, owner_human_id FROM tasks WHERE id = $1', [o.taskId])).rows[0];
  if (!t) throw new Error(`dispatchFor: no task ${o.taskId}`);
  const epoch = (await pool.query<{ epoch: string }>('SELECT epoch FROM coordinator_epoch')).rows[0]!.epoch;
  const now = Date.now();
  return signDispatch(key, {
    v: 1, kind: o.kind, project_id: o.projectId, task_id: o.taskId, agent_id: o.agentId, target_device_id: o.targetDevice,
    issuer_human_id: o.issuerHuman, issuer_device_id: o.issuerDevice, epoch, nonce: newNonce(),
    issued_at: new Date(now).toISOString(), expires_at: new Date(now + 10 * 60_000).toISOString(),
    task_sha256: taskSha256(t), ...(o.message === undefined ? {} : { message_sha256: messageSha256(o.message) }),
    ...(o.integrate ? { integrate: o.integrate } : {}),
  });
}
