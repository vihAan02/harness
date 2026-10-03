import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer, type RunningServer } from '../src/server.ts';
import { TestClient } from './client.ts';
import { freshSchema, seedProject, TEST_DATABASE_URL } from './helpers.ts';

const TOKEN = 'presence-token-'.padEnd(48, 'x');
let db: Awaited<ReturnType<typeof freshSchema>>;
let server: RunningServer;
const errors: unknown[] = [];

before(async () => {
  db = await freshSchema();
  await db.pool.query("INSERT INTO human_principals (id, display_name) VALUES ('human_test', 'Test')");
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_a', 'human_test', 'a'), ('dev_b', 'human_test', 'b')");
  server = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, localToken: TOKEN, port: 0, offlineAfterMs: 600, onError: (e) => errors.push(e) });
});
after(async () => {
  await server?.close();
  await db?.drop();
  assert.deepEqual(errors, []);
});

async function join(project: string, device?: string) {
  const c = await TestClient.open(server.url);
  c.send({ v: 1, type: 'hello', client: { kind: device ? 'harnessd' : 'cli', version: '0' }, principal: 'human_test', ...(device ? { device_id: device } : {}),
    auth: { scheme: 'local-token', token: TOKEN }, subscribe: [{ project_id: project, after_seq: 0 }] });
  await c.next('welcome');
  return c;
}
const beat = (c: TestClient) => c.send({ v: 1, type: 'heartbeat' });

test('the first heartbeat logs device.online once; later ones log nothing', async () => {
  const p = await seedProject(db.pool);
  const d = await join(p, 'dev_a');
  beat(d);
  const online = await d.next('event');
  assert.deepEqual([online.kind, online.actor.device_id, online.data], ['device.online', 'dev_a', { device_id: 'dev_a' }]);
  beat(d); beat(d);
  await sleep(150);
  assert.deepEqual(d.take('event'), []);
  assert.ok((await db.pool.query("SELECT last_heartbeat_at FROM devices WHERE id = 'dev_a'")).rows[0].last_heartbeat_at);
  d.close();
});

test('a device that goes silent is marked offline, and comes back online', async () => {
  const p = await seedProject(db.pool);
  const watcher = await join(p);
  const d = await join(p, 'dev_b');
  beat(d);
  assert.equal((await watcher.next('event')).kind, 'device.online');
  d.close();
  const offline = await watcher.next('event', () => true, 3000);
  assert.deepEqual([offline.kind, offline.actor.principal, offline.actor.device_id], ['device.offline', 'harness', 'dev_b']);
  const back = await join(p, 'dev_b');
  beat(back);
  assert.equal((await watcher.next('event')).kind, 'device.online');
  watcher.close(); back.close();
});

test('heartbeats need a device', async () => {
  const p = await seedProject(db.pool);
  const cli = await join(p);
  beat(cli);
  assert.equal((await cli.next('error')).code, 'bad_request');
  cli.close();
});

test('harnessd reports worktrees and setup as events; others cannot', async () => {
  const p = await seedProject(db.pool);
  await db.pool.query("INSERT INTO tasks (id, project_id, title, text, scope, owner_human_id) VALUES ('t1', $1, 't', 't', '{src/}', 'human_test')", [p]);
  const d = await join(p, 'dev_a');
  const send = (name: string, args: Record<string, unknown>) => {
    d.send({ v: 1, type: 'command', command_id: randomUUID(), project_id: p, name, args });
    return d.next('command_result');
  };
  assert.ok((await send('worktree.report', { task_id: 't1', event: 'created', path: '/h/wt/t1', branch: 'harness/task/t1' })).ok);
  assert.ok((await send('setup.report', { task_id: 't1', command_hash: 'a'.repeat(64), event: 'ran', exit_code: 0 })).ok);
  const kinds = [(await d.next('event')).kind, (await d.next('event')).kind];
  assert.deepEqual(kinds, ['worktree.created', 'setup.ran']);
  const missing = await send('worktree.report', { task_id: 'nope', event: 'created', path: '/x' });
  assert.ok(!missing.ok && missing.error.code === 'not_found');
  const relative = await send('worktree.report', { task_id: 't1', event: 'created', path: 'relative/path' });
  assert.ok(!relative.ok && relative.error.code === 'bad_request');
  d.close();

  const cli = await join(p);
  cli.send({ v: 1, type: 'command', command_id: randomUUID(), project_id: p, name: 'setup.report', args: { task_id: 't1', command_hash: 'a'.repeat(64), event: 'approved' } });
  const refused = await cli.next('command_result');
  assert.ok(!refused.ok && refused.error.code === 'forbidden', JSON.stringify(refused));
  cli.close();
});
