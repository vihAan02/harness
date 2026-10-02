import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { inTransaction } from '../src/db.ts';
import { appendEvents } from '../src/events.ts';
import { startServer, type RunningServer } from '../src/server.ts';
import { TestClient } from './client.ts';
import { freshSchema, seedProject, TEST_DATABASE_URL } from './helpers.ts';

const TOKEN = 'test-token-'.padEnd(48, 'x');
let db: Awaited<ReturnType<typeof freshSchema>>;
let server: RunningServer;
const errors: unknown[] = [];

before(async () => {
  db = await freshSchema();
  await db.pool.query("INSERT INTO human_principals (id, display_name) VALUES ('human_test', 'Test'), ('human_viewer', 'Viewer'), ('human_outsider', 'Outsider')");
  await db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_test', 'human_test', 'laptop')");
  // The poll is slow here, so live delivery has to come from NOTIFY (one test starts its own fast-polling server).
  server = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, localToken: TOKEN, port: 0, pollIntervalMs: 60_000, onError: (e) => errors.push(e) });
});
after(async () => {
  await server?.close();
  await db?.drop();
  assert.deepEqual(errors, [], 'the server reported unexpected errors');
});

const hello = (over: Record<string, unknown> = {}) => ({
  v: 1, type: 'hello', client: { kind: 'cli', version: '0.0.0' }, principal: 'human_test', device_id: 'dev_test',
  auth: { scheme: 'local-token', token: TOKEN }, ...over,
});
const sub = (project_id: string, after_seq = 0) => ({ subscribe: [{ project_id, after_seq }] });
const command = (project_id: string, name: string, args: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  ({ v: 1, type: 'command', command_id: randomUUID(), project_id, name, args, ...over });
const agent = (n: number) => ({ name: `agent/a-${n}`, vendor: 'claude' });

async function connect(h: Record<string, unknown>, url = server.url) {
  const c = await TestClient.open(url);
  c.send(h);
  return c;
}
async function joined(project: string, after_seq = 0, url = server.url) {
  const c = await connect(hello(sub(project, after_seq)), url);
  await c.next('welcome');
  return c;
}

test('a wrong token is refused and the socket closed', async () => {
  const c = await connect(hello({ auth: { scheme: 'local-token', token: 'nope' } }));
  assert.equal((await c.next('error')).code, 'unauthorized');
  assert.equal(await c.closed, 1008);
});

test('an unsupported protocol version is refused', async () => {
  const c = await connect({ ...hello(), v: 99 });
  assert.equal((await c.next('error')).code, 'unsupported_version');
  await c.closed;
});

test('the first message must be hello', async () => {
  const p = await seedProject(db.pool);
  const c = await connect(command(p, 'agent.create', agent(1)));
  assert.equal((await c.next('error')).code, 'unauthorized');
  await c.closed;
});

test('a device must belong to the principal', async () => {
  const c = await connect(hello({ principal: 'human_viewer' }));
  assert.equal((await c.next('error')).code, 'unauthorized');
  await c.closed;
});

test('subscribing to a project you are not a member of is refused', async () => {
  const p = await seedProject(db.pool);
  const c = await connect(hello({ principal: 'human_outsider', device_id: undefined, ...sub(p) }));
  assert.equal((await c.next('error')).code, 'forbidden');
  await c.closed;
});

test('welcome reports the head, then events replay from the cursor in order', async () => {
  const p = await seedProject(db.pool);
  await inTransaction(db.pool, (tx) => appendEvents(tx, p, ['a', 'b', 'c'].map((kind) => ({ kind, actor: 'human_test' }))));
  const c = await connect(hello(sub(p, 1)));
  assert.deepEqual((await c.next('welcome')).projects, [{ project_id: p, head_seq: 3 }]);
  assert.deepEqual([(await c.next('event')).seq, (await c.next('event')).seq], [2, 3]);
  c.close();
});

test('a command commits its event, which reaches every subscriber live', async () => {
  const p = await seedProject(db.pool);
  const [watcher, actor] = [await joined(p), await joined(p)];
  actor.send(command(p, 'agent.create', agent(1)));
  const res = await actor.next('command_result');
  assert.ok(res.ok, JSON.stringify(res));
  assert.deepEqual(res.seqs, [1]);
  for (const c of [watcher, actor]) {
    const e = await c.next('event');
    assert.equal(e.seq, 1);
    assert.equal(e.kind, 'agent.created');
    assert.deepEqual(e.actor, { principal: 'human_test', on_behalf_of: null, device_id: 'dev_test' });
    assert.deepEqual(e.data, { agent_id: (res.result as { agent_id: string }).agent_id, name: 'agent/a-1', vendor: 'claude', accountable_human_id: 'human_test' });
  }
  watcher.close(); actor.close();
});

test('a retried command returns the original outcome and runs once', async () => {
  const p = await seedProject(db.pool);
  const c = await joined(p);
  const cmd = command(p, 'agent.create', agent(1));
  c.send(cmd);
  const first = await c.next('command_result');
  c.send(cmd);
  const second = await c.next('command_result');
  assert.ok(first.ok && second.ok);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.deepEqual([second.seqs, second.result], [first.seqs, first.result]);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM agent_principals WHERE project_id = $1', [p])).rows[0].n, 1);
  c.close();
});

test('concurrent retries of one command on two connections run it once', async () => {
  const p = await seedProject(db.pool);
  const [a, b] = [await joined(p), await joined(p)];
  const cmd = command(p, 'agent.create', agent(1));
  a.send(cmd); b.send(cmd);
  const [ra, rb] = [await a.next('command_result'), await b.next('command_result')];
  assert.ok(ra.ok && rb.ok, JSON.stringify([ra, rb]));
  assert.deepEqual([ra.duplicate, rb.duplicate].sort(), [false, true]);
  assert.deepEqual(ra.result, rb.result);
  assert.equal((await db.pool.query('SELECT count(*)::int AS n FROM events WHERE project_id = $1', [p])).rows[0].n, 1);
  a.close(); b.close();
});

test('a command_id reused for a different command is a conflict', async () => {
  const p = await seedProject(db.pool);
  const c = await joined(p);
  const cmd = command(p, 'agent.create', agent(1));
  c.send(cmd);
  await c.next('command_result');
  c.send({ ...cmd, args: agent(2) });
  const res = await c.next('command_result');
  assert.ok(!res.ok && res.error.code === 'conflict', JSON.stringify(res));
  c.close();
});

test('viewers cannot send commands', async () => {
  const p = await seedProject(db.pool);
  await db.pool.query("INSERT INTO project_memberships (project_id, human_id, role) VALUES ($1, 'human_viewer', 'viewer')", [p]);
  const c = await connect(hello({ principal: 'human_viewer', device_id: undefined, ...sub(p) }));
  await c.next('welcome');
  c.send(command(p, 'agent.create', agent(1)));
  const res = await c.next('command_result');
  assert.ok(!res.ok && res.error.code === 'forbidden', JSON.stringify(res));
  c.close();
});

test('as_agent must name one of the caller\'s own agents in the project', async () => {
  const p = await seedProject(db.pool);
  const c = await joined(p);
  c.send(command(p, 'agent.create', agent(1)));
  const created = await c.next('command_result');
  assert.ok(created.ok);
  const agentId = (created.result as { agent_id: string }).agent_id;
  c.send(command(p, 'agent.create', agent(2), { as_agent: 'agent_nobody' }));
  const unknown = await c.next('command_result');
  assert.ok(!unknown.ok && unknown.error.code === 'forbidden', JSON.stringify(unknown));
  c.send(command(p, 'agent.create', agent(2), { as_agent: agentId }));
  const selfCreate = await c.next('command_result');
  assert.ok(!selfCreate.ok && /agents cannot create agents/.test(selfCreate.error.message), JSON.stringify(selfCreate));
  c.close();
});

test('reconnecting from a cursor resumes exactly where the client left off', async () => {
  const p = await seedProject(db.pool);
  const writer = await joined(p);
  const reader = await joined(p);
  for (const n of [1, 2]) { writer.send(command(p, 'agent.create', agent(n))); await writer.next('command_result'); }
  assert.deepEqual([(await reader.next('event')).seq, (await reader.next('event')).seq], [1, 2]);
  reader.close();
  await reader.closed;
  for (const n of [3, 4]) { writer.send(command(p, 'agent.create', agent(n))); await writer.next('command_result'); }
  const again = await connect(hello(sub(p, 2)));
  assert.deepEqual((await again.next('welcome')).projects, [{ project_id: p, head_seq: 4 }]);
  assert.deepEqual([(await again.next('event')).seq, (await again.next('event')).seq], [3, 4]);
  await sleep(200);
  assert.deepEqual(again.take('event'), [], 'nothing before the cursor is replayed');
  writer.close(); again.close();
});

test('a later subscribe replays that project and reports its head', async () => {
  const [p, q] = [await seedProject(db.pool), await seedProject(db.pool)];
  await inTransaction(db.pool, (tx) => appendEvents(tx, q, [{ kind: 'x', actor: 'human_test' }]));
  const c = await joined(p);
  c.send({ v: 1, type: 'subscribe', ...sub(q) });
  assert.deepEqual((await c.next('subscribed')).projects, [{ project_id: q, head_seq: 1 }]);
  assert.equal((await c.next('event', (e) => e.project_id === q)).seq, 1);
  c.close();
});

test('the timer poll delivers events whose wake-up never came', async () => {
  const fast = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, localToken: TOKEN, port: 0, pollIntervalMs: 150, onError: (e) => errors.push(e) });
  try {
    const p = await seedProject(db.pool);
    const c = await joined(p, 0, fast.url);
    await inTransaction(db.pool, (tx) => appendEvents(tx, p, [{ kind: 'silent', actor: 'human_test' }])); // no NOTIFY
    assert.equal((await c.next('event', () => true, 2000)).kind, 'silent');
    c.close();
  } finally {
    await fast.close();
  }
});

test('after losing its listener connection, the server reconnects and catches up', async () => {
  const p = await seedProject(db.pool);
  const c = await joined(p);
  await inTransaction(db.pool, (tx) => appendEvents(tx, p, [{ kind: 'missed', actor: 'human_test' }])); // no NOTIFY, and the poll is slow
  await sleep(300);
  assert.deepEqual(c.take('event'), [], 'nothing should wake the fan-out yet');
  const killed = await db.pool.query("SELECT pg_terminate_backend(pid) AS ok FROM pg_stat_activity WHERE application_name = $1", [`harness-listener:${db.schema}`]);
  assert.equal(killed.rowCount, 1);
  assert.equal((await c.next('event', () => true, 5000)).kind, 'missed'); // the catch-up on reconnect
  c.send(command(p, 'agent.create', agent(1)));
  assert.equal((await c.next('event', (e) => e.kind === 'agent.created')).seq, 2); // and live NOTIFY works again
  c.close();
});
