// harnessd and the CLI with device keys (D-111): a real server, a real harnessd and the real `harness` CLI, each
// proving this device's key; and a process squatting the server's port, which can neither make harnessd trust it nor
// make it give up (TH-23). No agent runs, so no model is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { WebSocketServer } from 'ws';
import { Daemon } from '../../packages/daemon/src/daemon.ts';
import { renderConfig, parseConfig } from '../../packages/daemon/src/config.ts';
import { createDeviceKey, loadDeviceKey } from '../../packages/daemon/src/identity.ts';
import { CliClient, CliError } from '../../packages/cli/src/client.ts';
import { makeRepo, tempDir, tempHome } from '../../packages/daemon/test/fixtures.ts';
import { generateKeyPair, HELLO_SERVER_CONTEXT, keyId, newNonce, parsePrivateKey, signPayload } from '../../packages/protocol/src/signing.ts';
import { startServer, type RunningServer } from '../../packages/server/src/server.ts';
import { freshSchema, seedProject, TEST_DATABASE_URL } from '../../packages/server/test/helpers.ts';

const freePort = () => new Promise<number>((resolve) => {
  const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address() as net.AddressInfo; srv.close(() => resolve(port)); });
});
const until = async (pred: () => boolean | Promise<boolean>, what: string, ms = 20_000) => {
  for (const end = Date.now() + ms; !(await pred()); await new Promise((r) => setTimeout(r, 25))) if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
};

async function pilotDevice(port: number) {
  const db = await freshSchema();
  const project = await seedProject(db.pool); // human_test owns it
  const t = tempDir('identity');
  const { repo } = makeRepo(t.dir, { 'README.md': 'hi\n' });
  const home = tempHome(t.dir);
  const { publicKey } = createDeviceKey(home);
  assert.equal((fs.statSync(home.deviceKey).mode & 0o777), 0o600);
  assert.throws(() => createDeviceKey(home), /EEXIST/, 'never overwrites a device key');
  await db.pool.query("INSERT INTO devices (id, human_id, name, public_key) VALUES ('dev_test', 'human_test', 'laptop', $1)", [publicKey]);
  const server = generateKeyPair();
  const raw = {
    device_id: 'dev_test', principal: 'human_test', server_url: `ws://127.0.0.1:${port}`, auth: 'device-key', server_key: server.publicKey,
    trust: { devices: { dev_test: { human: 'human_test', key: publicKey } } },
    limits: { port_range: [31700, 31799] }, agents: { max_budget_usd: 0.1, daily_budget_usd: 0.25 }, projects: [{ id: project, repo }],
  };
  fs.writeFileSync(home.config, renderConfig(raw)); // what `harness setup` writes; the CLI reads it
  const config = parseConfig(raw, '');
  return { db, project, t, home, config, serverKey: parsePrivateKey(server.privateKeyPem), serverPub: server.publicKey, publicKey };
}

test('harnessd and the CLI authenticate with the device key; nothing needs the shared token', async () => {
  const port = await freePort();
  const d = await pilotDevice(port);
  const logs: string[] = [];
  let server: RunningServer | null = null;
  const daemon = new Daemon({ home: d.home, config: d.config, heartbeatMs: 200, log: (m) => logs.push(m) });
  try {
    server = await startServer({ pool: d.db.pool, databaseUrl: TEST_DATABASE_URL, schema: d.db.schema, serverKey: d.serverKey, port });
    await daemon.start();
    await daemon.ready();
    assert.equal(daemon.linkState, 'connected');
    assert.match(daemon.link!.epoch!, /^[0-9a-f]{16}$/);
    // Heartbeats come from the verified harnessd: its presence is recorded.
    await until(async () => !!(await d.db.pool.query("SELECT 1 FROM devices WHERE id = 'dev_test' AND last_heartbeat_at IS NOT NULL")).rowCount, 'a heartbeat');
    // The real CLI, through the same handshake: it reads config.toml and device.key from HARNESS_HOME.
    const main = path.resolve(import.meta.dirname, '../../packages/cli/src/main.ts');
    const { stdout } = await promisify(execFile)(process.execPath, [main, 'agent', 'add', 'pilot'], { env: { ...process.env, HARNESS_HOME: d.home.root } });
    assert.match(stdout, /agent\/pilot/);
    assert.ok((await d.db.pool.query("SELECT 1 FROM agent_principals WHERE name = 'agent/pilot' AND accountable_human_id = 'human_test'")).rowCount);
    assert.ok(loadDeviceKey(d.home));
  } finally {
    await daemon.stop();
    await server?.close();
    await d.db.drop();
    d.t.cleanup();
  }
});

test('a squatter on the server\'s port: harnessd trusts nothing it says and never gives up, then connects to the real server', async () => {
  const port = await freePort();
  const d = await pilotDevice(port);
  const logs: string[] = [];
  const daemon = new Daemon({ home: d.home, config: d.config, heartbeatMs: 200, log: (m) => logs.push(m) });
  // The squatter: a forged challenge (its own key), then a welcome and an event it hopes are believed, then an
  // `unauthorized` error it hopes is fatal.
  const squatterKey = parsePrivateKey(generateKeyPair().privateKeyPem);
  let hellos = 0;
  const squatter = new WebSocketServer({ host: '127.0.0.1', port });
  squatter.on('connection', (ws) => {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as { type: string; auth?: { client_nonce?: string } };
      if (m.type !== 'hello') return;
      hellos++;
      const server_nonce = newNonce();
      const proof = { client_nonce: m.auth?.client_nonce ?? '', server_nonce, server_key_id: keyId(d.serverPub), device_id: 'dev_test', principal: 'human_test' };
      ws.send(JSON.stringify({ v: 1, type: 'welcome', server_time: new Date().toISOString(), projects: [{ project_id: d.project, head_seq: 1 }] }));
      ws.send(JSON.stringify({ v: 1, type: 'event', project_id: d.project, seq: 1, at: new Date().toISOString(), actor: { principal: 'human_test', on_behalf_of: null, device_id: null }, kind: 'task.assigned', data: { task_id: 'T-1' } }));
      ws.send(JSON.stringify({ v: 1, type: 'challenge', server_nonce, server_key_id: proof.server_key_id, sig: signPayload(squatterKey, HELLO_SERVER_CONTEXT, proof) }));
      ws.send(JSON.stringify({ v: 1, type: 'error', code: 'unauthorized', message: 'go away' }));
    });
  });
  await new Promise<void>((r) => squatter.once('listening', () => r()));
  let server: RunningServer | null = null;
  try {
    await daemon.start();
    await until(() => hellos >= 2, 'harnessd to retry against the squatter');
    assert.equal(daemon.linkState, 'server_identity_mismatch');
    assert.equal(daemon.link!.fatal, null, 'an unverified error never makes harnessd give up');
    assert.equal(daemon.link!.ready, false, 'an unverified welcome is never believed');
    assert.equal(daemon.view(d.project).events.length, 0, 'an unverified event is never folded in');
    assert.ok(logs.some((l) => /didn't prove the pinned server key/.test(l)), logs.join(' | '));
    // The squatter goes; the real coordinator comes back on the same port.
    await new Promise<void>((r) => squatter.close(() => r()));
    server = await startServer({ pool: d.db.pool, databaseUrl: TEST_DATABASE_URL, schema: d.db.schema, serverKey: d.serverKey, port });
    await daemon.ready();
    assert.equal(daemon.linkState, 'connected');
  } finally {
    await daemon.stop();
    if (squatter.address()) await new Promise<void>((r) => squatter.close(() => r()));
    await server?.close();
    await d.db.drop();
    d.t.cleanup();
  }
});

test('a revoked device, or one replaced by another harnessd, stops reconnecting', async () => {
  const port = await freePort();
  const d = await pilotDevice(port);
  const server = await startServer({ pool: d.db.pool, databaseUrl: TEST_DATABASE_URL, schema: d.db.schema, serverKey: d.serverKey, port });
  const first = new Daemon({ home: d.home, config: d.config, heartbeatMs: 200, log: () => {} });
  const second = new Daemon({ home: d.home, config: d.config, heartbeatMs: 200, log: () => {} });
  try {
    await first.start();
    await first.ready();
    // A second harnessd with the same device key (a misconfigured clone): the newer one wins; the older stops.
    await second.start();
    await second.ready();
    await until(() => first.linkState === 'replaced', 'the older harnessd to be replaced');
    assert.equal(first.link!.fatal, 'replaced');
    // Revoked: the server refuses the device after it proved itself, so harnessd stops trying.
    await d.db.pool.query("UPDATE devices SET revoked_at = now() WHERE id = 'dev_test'");
    second.link!.ws?.close();
    await until(() => second.linkState === 'refused', 'the revoked device to be refused');
    assert.equal(second.link!.fatal, 'unauthorized');
  } finally {
    await first.stop();
    await second.stop();
    await server.close();
    await d.db.drop();
    d.t.cleanup();
  }
});

/** A process on the server's port that answers each hello with `frames(hello)`, raw, then closes after a moment. */
async function squat(port: number, frames: (hello: { auth?: { client_nonce?: string } }) => string[]) {
  let hellos = 0;
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      const m = JSON.parse(String(data)) as { type: string; auth?: { client_nonce?: string } };
      if (m.type !== 'hello') return;
      hellos++;
      for (const f of frames(m)) ws.send(f);
      setTimeout(() => ws.close(), 100);
    });
  });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  return { hellos: () => hellos, close: () => new Promise<void>((r) => wss.close(() => r())) };
}
const deepChallenge = (serverPub: string) => {
  const sig = signPayload(parsePrivateKey(generateKeyPair().privateKeyPem), HELLO_SERVER_CONTEXT, {});
  return `{"v":1,"type":"challenge","server_nonce":${'['.repeat(50_000)}${']'.repeat(50_000)},"server_key_id":"${keyId(serverPub)}","sig":"${sig}"}`;
};

test('a squatter\'s malformed frames crash nothing: harnessd keeps retrying; the CLI fails with a clear error', async () => {
  const port = await freePort();
  const d = await pilotDevice(port);
  const logs: string[] = [];
  const junk = ['not json', 'null', '[]', '42', '{"type":7}', '{"v":1,"type":"error","code":"unauthorized","message":"go\\naway"}'];
  let s = await squat(port, () => [...junk, deepChallenge(d.serverPub)]);
  const daemon = new Daemon({ home: d.home, config: d.config, heartbeatMs: 200, log: (m) => logs.push(m) });
  try {
    await daemon.start();
    await until(() => s.hellos() >= 3, 'harnessd to keep retrying');
    assert.equal(daemon.link!.fatal, null);
    assert.equal(daemon.linkState, 'server_identity_mismatch');
    assert.ok(logs.some((l) => /sent a malformed challenge/.test(l)), logs.join(' | '));
    assert.ok(logs.some((l) => l.includes('(ignored): unauthorized: go away')), 'the unverified text is logged on one line');
    await daemon.stop();
    // The CLI: junk and no challenge is a timeout naming what the unverified answer said; the deep challenge is refused.
    await s.close();
    s = await squat(port, () => junk);
    await assert.rejects(CliClient.connect(d.config, d.project, 1500, loadDeviceKey(d.home)), (e: unknown) => e instanceof CliError && /no verified answer .* \(an unverified answer said unauthorized: go away\)/.test((e as Error).message));
    await s.close();
    s = await squat(port, () => [deepChallenge(d.serverPub)]);
    await assert.rejects(CliClient.connect(d.config, d.project, 1500, loadDeviceKey(d.home)), (e: unknown) => e instanceof CliError && /malformed challenge/.test((e as Error).message));
  } finally {
    await daemon.stop();
    await s.close();
    await d.db.drop();
    d.t.cleanup();
  }
});

test('the CLI refuses a real challenge replayed to a new hello, and a server with another key', async () => {
  const port = await freePort();
  const d = await pilotDevice(port);
  const other = generateKeyPair();
  let server: RunningServer | null = await startServer({ pool: d.db.pool, databaseUrl: TEST_DATABASE_URL, schema: d.db.schema, serverKey: d.serverKey, port });
  let s: Awaited<ReturnType<typeof squat>> | null = null;
  try {
    // A real challenge, recorded from the real server for one hello.
    const recorded = await new Promise<string>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.addEventListener('open', () => ws.send(JSON.stringify({ v: 1, type: 'hello', client: { kind: 'cli', version: '0' }, principal: 'human_test', device_id: 'dev_test', auth: { scheme: 'device-key', client_nonce: newNonce() }, subscribe: [] })));
      ws.addEventListener('message', (ev) => { resolve(String(ev.data)); ws.close(); });
    });
    assert.equal(JSON.parse(recorded).type, 'challenge');
    await server.close();
    server = null;
    // Replayed to the CLI's own hello (a fresh client nonce): it doesn't verify.
    s = await squat(port, () => [recorded]);
    await assert.rejects(CliClient.connect(d.config, d.project, 3000, loadDeviceKey(d.home)), (e: unknown) => e instanceof CliError && /didn't prove the pinned server key/.test((e as Error).message));
    await s.close();
    s = null;
    // A coordinator with another key on the pinned address.
    server = await startServer({ pool: d.db.pool, databaseUrl: TEST_DATABASE_URL, schema: d.db.schema, serverKey: parsePrivateKey(other.privateKeyPem), port });
    await assert.rejects(CliClient.connect(d.config, d.project, 3000, loadDeviceKey(d.home)), (e: unknown) => e instanceof CliError && /didn't prove the pinned server key/.test((e as Error).message));
  } finally {
    await s?.close();
    await server?.close();
    await d.db.drop();
    d.t.cleanup();
  }
});
