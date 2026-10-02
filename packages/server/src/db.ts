// Postgres access for the coordination server (D-11). Migrations are plain numbered SQL files in
// ../migrations, applied in order, each in its own transaction, and recorded in schema_migrations.
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export const DEFAULT_DATABASE_URL = 'postgresql://localhost:5432/harness_dev';
export const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../migrations');

/** A pool for one database. `schema` pins the search_path (tests use a throwaway schema each). */
export function createPool(connectionString = process.env.HARNESS_DATABASE_URL ?? DEFAULT_DATABASE_URL, schema?: string): pg.Pool {
  if (schema && !/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`invalid schema name: ${schema}`);
  return new pg.Pool({ connectionString, ...(schema ? { options: `-c search_path=${schema}` } : {}) });
}

/** Runs `fn` in one READ COMMITTED transaction; rolls back if it throws. */
export async function inTransaction<T>(pool: pg.Pool, fn: (tx: pg.PoolClient) => Promise<T>): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (e) {
    await tx.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    tx.release();
  }
}

/** Applies pending migrations and returns their versions. Safe to call from several processes at once. */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('harness.migrate'))");
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map((r) => r.version));
    const applied: string[] = [];
    for (const file of fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      const version = file.slice(0, -'.sql'.length);
      if (done.has(version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${version} failed: ${(e as Error).message}`);
      }
      applied.push(version);
    }
    return applied;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('harness.migrate'))").catch(() => {});
    client.release();
  }
}
