import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { migrate } from '../src/db.ts';
import { freshSchema, seedProject } from './helpers.ts';

let db: Awaited<ReturnType<typeof freshSchema>>;
before(async () => { db = await freshSchema(); });
after(async () => { await db?.drop(); });

test('migrations apply once', async () => {
  assert.deepEqual(await migrate(db.pool), []);
});

test('no single-user shortcut: no user_id column anywhere (D-18)', async () => {
  const r = await db.pool.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1 AND column_name LIKE '%user_id%'", [db.schema]);
  assert.deepEqual(r.rows, []);
});

test('messages accept only the typed kinds (D-24)', async () => {
  const p = await seedProject(db.pool);
  const insert = (id: string, kind: string) => db.pool.query(
    "INSERT INTO messages (id, project_id, kind, from_principal, text) VALUES ($1, $2, $3, 'agent_a', 'hi')", [id, p, kind]);
  await insert('msg_1', 'question');
  await assert.rejects(insert('msg_2', 'chat'), /messages_kind_check/);
});

test('tasks move only through the defined states (D-54)', async () => {
  const p = await seedProject(db.pool);
  await assert.rejects(db.pool.query(
    "INSERT INTO tasks (id, project_id, title, text, scope, owner_human_id, status) VALUES ('t1', $1, 't', 't', '{src/}', 'human_test', 'paused')", [p]),
  /tasks_status_check/);
});

test('runs on PostgreSQL 18 or later (D-73): a missing HARNESS_TEST_DATABASE_URL could point the tests at an older server', async () => {
  const v = Number((await db.pool.query('SHOW server_version_num')).rows[0].server_version_num);
  assert.ok(v >= 180000, `server_version_num is ${v}; point HARNESS_TEST_DATABASE_URL at PostgreSQL 18 (see README "Running locally")`);
});
