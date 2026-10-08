// Device-key authentication (D-111; protocol.md §2): the server proves its key, the device proves its own, and the
// principal is the device's human. Wrong principals, unknown or revoked devices, other keys and replayed proofs are
// all refused with the same answer; the principal a client claims is never trusted on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, type KeyObject } from 'node:crypto';
import type { Challenge, ClientKind, ServerMessage } from '@harness/protocol';
import {
  generateKeyPair, HELLO_DEVICE_CONTEXT, HELLO_SERVER_CONTEXT, keyId, newNonce, parsePrivateKey, publicKeyText, signPayload, verifyPayload,
} from '@harness/protocol/signing';
import { startServer } from '../src/server.ts';
import { TestClient } from './client.ts';
import { freshSchema, seedProject, TEST_DATABASE_URL } from './helpers.ts';

const key = () => { const k = generateKeyPair(); return { priv: parsePrivateKey(k.privateKeyPem), pub: k.publicKey }; };

async function stack() {
  const db = await freshSchema();
  const project = await seedProject(db.pool); // human_test owns it
  const server = key();
  const laptop = key();
  await db.pool.query("INSERT INTO devices (id, human_id, name, public_key) VALUES ('dev_test', 'human_test', 'laptop', $1)", [laptop.pub]);
  await db.pool.query("INSERT INTO human_principals (id, display_name) VALUES ('human_other', 'Other')");
  const errors: unknown[] = [];
  const running = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, serverKey: server.priv, port: 0, onError: (e) => errors.push(e) });
  const epoch = (await db.pool.query<{ epoch: string }>('SELECT epoch FROM coordinator_epoch')).rows[0]!.epoch;
  return {
    db, project, server, laptop, running, epoch, errors,
    async stop() { await running.close(); await db.drop(); assert.deepEqual(errors, []); },
  };
}
type Stack = Awaited<ReturnType<typeof stack>>;

/** Opens a connection and says hello with device keys; returns the client and the server's challenge. */
async function hello(s: Stack, o: { device?: string; principal?: string; kind?: ClientKind; subscribe?: boolean } = {}) {
  const c = await TestClient.open(s.running.url);
  const client_nonce = newNonce();
  const device = o.device ?? 'dev_test';
  const principal = o.principal ?? 'human_test';
  c.send({ v: 1, type: 'hello', client: { kind: o.kind ?? 'harnessd', version: '0' }, principal, device_id: device, auth: { scheme: 'device-key', client_nonce }, subscribe: o.subscribe === false ? [] : [{ project_id: s.project, after_seq: 0 }] });
  const ch = await c.next('challenge');
  const proof = { client_nonce, server_nonce: ch.server_nonce, server_key_id: ch.server_key_id, device_id: device, principal };
  return { c, ch, proof, kind: o.kind ?? 'harnessd' };
}
const answer = (h: Awaited<ReturnType<typeof hello>>, priv: KeyObject) => h.c.send({ v: 1, type: 'auth', sig: signPayload(priv, HELLO_DEVICE_CONTEXT, { ...h.proof, client_kind: h.kind }) });
/** The error a refused client gets, and the close that follows. */
async function refused(c: TestClient): Promise<{ code: string; close: number }> {
  const e = await c.next('error');
  return { code: e.code, close: await c.closed };
}

test('the handshake: the server proves its key, the device proves its own, then welcome with the coordinator epoch', async () => {
  const s = await stack();
  try {
    const h = await hello(s);
    assert.equal(h.ch.server_key_id, keyId(s.server.pub));
    assert.ok(verifyPayload(s.server.pub, HELLO_SERVER_CONTEXT, h.proof, h.ch.sig), 'the challenge is signed by the server key over both nonces');
    answer(h, s.laptop.priv);
    const w = await h.c.next('welcome');
    assert.equal(w.epoch, s.epoch);
    assert.match(w.epoch!, /^[0-9a-f]{16}$/);
    assert.deepEqual(w.projects.map((p) => p.project_id), [s.project]);
    h.c.close();
  } finally { await s.stop(); }
});

test('refused, with one answer for every case: wrong principal, unknown or revoked device, another key, a key-less device', async () => {
  const s = await stack();
  try {
    const cases: [string, () => Promise<{ code: string; close: number }>][] = [
      ['a principal that is not the device\'s human', async () => { const h = await hello(s, { principal: 'human_other', subscribe: false }); answer(h, s.laptop.priv); return refused(h.c); }],
      ['an unknown device', async () => { const h = await hello(s, { device: 'dev_nobody' }); answer(h, s.laptop.priv); return refused(h.c); }],
      ['another key', async () => { const h = await hello(s); answer(h, key().priv); return refused(h.c); }],
      ['the right key over another server nonce', async () => {
        const h = await hello(s);
        h.c.send({ v: 1, type: 'auth', sig: signPayload(s.laptop.priv, HELLO_DEVICE_CONTEXT, { ...h.proof, server_nonce: newNonce(), client_kind: 'harnessd' }) });
        return refused(h.c);
      }],
      ['the right key, signed as another kind of client', async () => {
        const h = await hello(s, { kind: 'cli' });
        h.c.send({ v: 1, type: 'auth', sig: signPayload(s.laptop.priv, HELLO_DEVICE_CONTEXT, { ...h.proof, client_kind: 'harnessd' }) });
        return refused(h.c);
      }],
    ];
    for (const [what, run] of cases) {
      const r = await run();
      assert.equal(r.code, 'unauthorized', what);
      assert.equal(r.close, 1008, what);
    }
    await s.db.pool.query("INSERT INTO devices (id, human_id, name) VALUES ('dev_nokey', 'human_test', 'no key')");
    const nokey = await hello(s, { device: 'dev_nokey' });
    answer(nokey, s.laptop.priv);
    assert.equal((await refused(nokey.c)).code, 'unauthorized', 'a device with no registered key');
    await s.db.pool.query("UPDATE devices SET revoked_at = now() WHERE id = 'dev_test'");
    const revoked = await hello(s);
    answer(revoked, s.laptop.priv);
    assert.equal((await refused(revoked.c)).code, 'unauthorized', 'a revoked device');
  } finally { await s.stop(); }
});

test('a captured proof is useless on another connection: each challenge has a fresh server nonce', async () => {
  const s = await stack();
  try {
    const first = await hello(s);
    const sig = signPayload(s.laptop.priv, HELLO_DEVICE_CONTEXT, { ...first.proof, client_kind: 'harnessd' });
    first.c.send({ v: 1, type: 'auth', sig });
    await first.c.next('welcome');
    // An eavesdropper replays the hello (same client nonce) and the captured signature on a new connection.
    const c = await TestClient.open(s.running.url);
    c.send({ v: 1, type: 'hello', client: { kind: 'harnessd', version: '0' }, principal: 'human_test', device_id: 'dev_test', auth: { scheme: 'device-key', client_nonce: first.proof.client_nonce }, subscribe: [] });
    const ch2 = await c.next('challenge');
    assert.notEqual(ch2.server_nonce, first.ch.server_nonce);
    c.send({ v: 1, type: 'auth', sig });
    assert.equal((await refused(c)).code, 'unauthorized');
    first.c.close();
  } finally { await s.stop(); }
});

test('the scheme is the server\'s: a local token gets nowhere on a device-key server, and the handshake is in order', async () => {
  const s = await stack();
  try {
    const token = await TestClient.open(s.running.url);
    token.send({ v: 1, type: 'hello', client: { kind: 'cli', version: '0' }, principal: 'human_test', auth: { scheme: 'local-token', token: 'x'.repeat(64) } });
    assert.equal((await refused(token)).code, 'unauthorized');
    const nodevice = await TestClient.open(s.running.url);
    nodevice.send({ v: 1, type: 'hello', client: { kind: 'cli', version: '0' }, principal: 'human_test', auth: { scheme: 'device-key', client_nonce: newNonce() } });
    assert.equal((await refused(nodevice)).code, 'unauthorized', 'a device-key hello names its device');
    const early = await TestClient.open(s.running.url);
    early.send({ v: 1, type: 'auth', sig: 'A'.repeat(86) + '==' });
    assert.equal((await refused(early)).code, 'unauthorized', 'auth before hello');
    const twice = await hello(s);
    twice.c.send({ v: 1, type: 'hello', client: { kind: 'harnessd', version: '0' }, principal: 'human_test', device_id: 'dev_test', auth: { scheme: 'device-key', client_nonce: newNonce() } });
    assert.equal((await refused(twice.c)).code, 'unauthorized', 'a second hello instead of auth');
  } finally { await s.stop(); }
});

test('a local-token server refuses device-key hellos (one scheme per server)', async () => {
  const db = await freshSchema();
  await seedProject(db.pool);
  const running = await startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, schema: db.schema, localToken: 't'.repeat(32), port: 0 });
  try {
    const c = await TestClient.open(running.url);
    c.send({ v: 1, type: 'hello', client: { kind: 'cli', version: '0' }, principal: 'human_test', auth: { scheme: 'device-key', client_nonce: newNonce() } });
    assert.equal((await refused(c)).code, 'unauthorized');
    await assert.rejects(startServer({ pool: db.pool, databaseUrl: TEST_DATABASE_URL, port: 0 }), /exactly one/);
  } finally { await running.close(); await db.drop(); }
});

test('one harnessd per device: a newer one replaces the older (close 4001); a CLI on the device is not a harnessd', async () => {
  const s = await stack();
  try {
    const first = await hello(s);
    answer(first, s.laptop.priv);
    await first.c.next('welcome');
    const cli = await hello(s, { kind: 'cli' });
    answer(cli, s.laptop.priv);
    await cli.c.next('welcome');
    const second = await hello(s);
    answer(second, s.laptop.priv);
    await second.c.next('welcome');
    assert.equal(await first.c.closed, 4001);
    // The CLI connection is still open and can act as its human, but not as the device's harnessd.
    const command_id = randomUUID();
    cli.c.send({ v: 1, type: 'command', command_id, project_id: s.project, name: 'worktree.report', args: { task_id: 'T-1', event: 'removed', path: '/x' } });
    const r = await cli.c.next('command_result', (m) => m.command_id === command_id);
    assert.ok(!r.ok && r.error.code === 'forbidden', 'device-only commands come from harnessd only');
    const agent = randomUUID();
    cli.c.send({ v: 1, type: 'command', command_id: agent, project_id: s.project, name: 'agent.create', args: { name: 'agent/x', vendor: 'claude' } });
    const created = await cli.c.next('command_result', (m) => m.command_id === agent);
    assert.ok(created.ok, 'a human command from the CLI still works');
    cli.c.close();
    second.c.close();
  } finally { await s.stop(); }
});

test('nothing before the challenge: the server sends no welcome, event or result to an unauthenticated client', async () => {
  const s = await stack();
  try {
    const h = await hello(s);
    const before: ServerMessage[] = [...h.c.inbox];
    assert.deepEqual(before.map((m) => m.type), [], 'only the challenge, already taken');
    // A command before auth is refused, and nothing leaks.
    h.c.send({ v: 1, type: 'command', command_id: randomUUID(), project_id: s.project, name: 'agent.create', args: { name: 'agent/y', vendor: 'claude' } });
    assert.equal((await refused(h.c)).code, 'unauthorized');
    assert.deepEqual(h.c.inbox.map((m) => m.type), [], 'nothing but the refusal, up to the close');
    assert.ok(!(h.ch as Challenge & { projects?: unknown }).projects);
    assert.equal(publicKeyText(s.laptop.priv), s.laptop.pub);
  } finally { await s.stop(); }
});

test('a device revoked while connected loses the connection at its next message', async () => {
  const s = await stack();
  try {
    const h = await hello(s);
    answer(h, s.laptop.priv);
    await h.c.next('welcome');
    const before = randomUUID();
    h.c.send({ v: 1, type: 'command', command_id: before, project_id: s.project, name: 'agent.create', args: { name: 'agent/before', vendor: 'claude' } });
    assert.ok((await h.c.next('command_result', (m) => m.command_id === before)).ok, 'a command before the revocation');
    h.c.take('event');
    await s.db.pool.query("UPDATE devices SET revoked_at = now() WHERE id = 'dev_test'");
    h.c.send({ v: 1, type: 'command', command_id: randomUUID(), project_id: s.project, name: 'agent.create', args: { name: 'agent/after', vendor: 'claude' } });
    assert.deepEqual(await refused(h.c), { code: 'unauthorized', close: 1008 });
    assert.equal((await s.db.pool.query("SELECT 1 FROM agent_principals WHERE name = 'agent/after'")).rowCount, 0);
  } finally { await s.stop(); }
});
