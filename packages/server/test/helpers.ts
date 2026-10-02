import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createPool, migrate } from '../src/db.ts';

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
