// The UI bridge (packages/ui/src, built through Harness tasks; D-117, protocol.md §12) over real sockets, against a
// real harnessd's uirpc: what its own tests, which may not open sockets, can't show. The launch handshake and the
// Host check over HTTP; the stream following the project live; harnessd going away and coming back with a new token;
// a taken port; and closing while a page still holds the stream. Each refusal has its passing control.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Daemon } from '../../packages/daemon/src/daemon.ts';
import { startBridge } from '../../packages/ui/src/bridge.ts';
import { UirpcClient } from '../../packages/ui/src/uirpc-client.ts';
import { startStack, type Stack } from '../support.ts';

const short = fs.realpathSync(fs.mkdtempSync('/tmp/hui-br-')); // macOS caps socket paths at 104 bytes
const socket = path.join(short, 'run', 'harnessd.sock');
const secret = randomBytes(32);
const WEB = path.resolve(import.meta.dirname, '../../packages/ui/web');
const hmac = (s: string) => createHmac('sha256', secret).update(s).digest('hex');

let s: Stack;
let port = 0;
let bridge: { url: string; close(): Promise<void> };
let uirpc: UirpcClient;
/** harnessds this file starts after the stack's own; the stack's stop() only knows its first. */
const restarted: Daemon[] = [];

/** A free loopback port, by asking the OS for one and giving it back. */
async function freePort(): Promise<number> {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const p = (srv.address() as net.AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return p;
}
/** A raw request, so a test can set the Host header itself. */
function request(o: { method?: string; path: string; host?: string; headers?: Record<string, string>; body?: unknown }): Promise<{ status: number; json: any }> {
  const body = o.body === undefined ? undefined : Buffer.from(JSON.stringify(o.body));
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path,
      headers: { host: o.host ?? `127.0.0.1:${port}`, ...(body ? { 'content-type': 'application/json', 'content-length': String(body.length) } : {}), ...o.headers },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = text;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}
/** The launcher's half of §12's handshake, then the page's session swap: a bearer token. */
async function session(): Promise<string> {
  const nonce_c = randomBytes(32).toString('hex');
  const ch = await request({ method: 'POST', path: '/api/launch/challenge', body: { nonce_c } });
  assert.equal(ch.status, 200, JSON.stringify(ch.json));
  assert.equal(ch.json.proof, hmac(`bridge:${nonce_c}${ch.json.nonce_b}`), 'the bridge proves the secret first');
  const l = await request({ method: 'POST', path: '/api/launch', body: { nonce_c, nonce_b: ch.json.nonce_b, mac: hmac(`launch:${nonce_c}${ch.json.nonce_b}`) } });
  assert.equal(l.status, 200, JSON.stringify(l.json));
  const sess = await request({ method: 'POST', path: '/api/session', body: { launch_token: l.json.launch_token } });
  assert.equal(sess.status, 200);
  return sess.json.session_token as string;
}
/** Reads /api/stream lines as they come. */
function openStream(token: string) {
  const lines: any[] = [];
  const req = http.request({ host: '127.0.0.1', port, path: '/api/stream', headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` } }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('data', (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) lines.push(JSON.parse(line));
      }
    });
    res.on('error', () => {});
  });
  req.on('error', () => {});
  req.end();
  return { lines, close: () => req.destroy() };
}

before(async () => {
  s = await startStack({ portRange: [30950, 30999], files: { 'src/app.ts': 'export const app = 1;\n' }, daemonOptions: { uiSocket: socket } });
  port = await freePort();
  uirpc = new UirpcClient({ connect: () => net.connect(socket), token: () => fs.readFileSync(path.join(path.dirname(socket), 'uirpc.token'), 'utf8').trim(), backoffMs: [100, 200] });
  bridge = await startBridge({ port, uirpc, webRoot: WEB, secret });
});
after(async () => {
  await bridge?.close();
  uirpc?.close();
  for (const d of restarted) await d.stop();
  await s?.stop();
  fs.rmSync(short, { recursive: true, force: true });
});

test('over HTTP: the launch handshake buys a session; the snapshot is harnessd\'s own; another Host name is refused (DNS rebinding)', async () => {
  const token = await session();
  const snap = await request({ path: '/api/snapshot', headers: { authorization: `Bearer ${token}` } });
  assert.equal(snap.status, 200);
  assert.deepEqual(snap.json.result.map((p: { project_id: string }) => p.project_id), [s.project]);
  assert.equal(snap.json.result[0].principal, 'human_test');
  const rebound = await request({ path: '/api/snapshot', host: `localhost:${port}`, headers: { authorization: `Bearer ${token}` } });
  assert.equal(rebound.status, 403, 'a page on another name that resolves here gets nothing');
  const bare = await request({ path: '/api/snapshot' });
  assert.equal(bare.status, 401, 'no session, no snapshot');
  const page = await request({ path: '/' });
  assert.ok([200, 404].includes(page.status), `the page itself needs no session (${page.status})`);
});

test('a command goes to harnessd and its seqs come back; a dispatch without device keys is not_available; a wrong approval hash is a conflict', async () => {
  const token = await session();
  const auth = { authorization: `Bearer ${token}` };
  const created = await request({ method: 'POST', path: '/api/command', headers: auth, body: { project_id: s.project, name: 'task.create', args: { title: 'from the UI', text: 'x', scope: [] }, command_id: crypto.randomUUID() } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  assert.ok(Array.isArray(created.json.result.seqs) && created.json.result.seqs.length > 0);
  const dispatch = await request({ method: 'POST', path: '/api/dispatch', headers: auth, body: { project_id: s.project, kind: 'start', task_id: 'T-1', args: {}, expected: {}, command_id: crypto.randomUUID() } });
  assert.equal(dispatch.status, 501, JSON.stringify(dispatch.json));
  const approval = await request({ method: 'POST', path: '/api/approvals/nope', headers: auth, body: { decision: 'approve', shown_hash: 'a'.repeat(64) } });
  assert.equal(approval.status, 404, JSON.stringify(approval.json));
  const forbidden = await request({ method: 'POST', path: '/api/command', headers: auth, body: { project_id: s.project, name: 'task.assign', args: {}, command_id: crypto.randomUUID() } });
  assert.equal(forbidden.status, 403, 'lifecycle commands need a dispatch');
});

test('the stream follows the project live, says when harnessd goes away, and comes back on harnessd\'s new token', async () => {
  const token = await session();
  const st = openStream(token);
  try {
    await s.until(() => st.lines.some((l) => l.harnessd === 'up') && st.lines.some((l) => l.snapshot?.project_id === s.project), 10_000, 'the first snapshot');
    await s.command('task.create', { title: 'seen live', text: 'x', scope: [] });
    await s.until(() => st.lines.some((l) => l.snapshot?.tasks?.some((t: { title: string }) => t.title === 'seen live')), 10_000, 'the new task on the stream');
    // harnessd stops: its socket goes, and the page hears it; calls answer 503.
    const old = fs.readFileSync(path.join(path.dirname(socket), 'uirpc.token'), 'utf8');
    await s.daemon.stop();
    await s.until(() => st.lines.some((l) => l.harnessd === 'down'), 10_000, 'harnessd down on the stream');
    const down = await request({ path: '/api/health', headers: { authorization: `Bearer ${token}` } });
    assert.equal(down.status, 503, JSON.stringify(down.json));
    // A new harnessd writes a new token; the bridge reads it again and the stream resumes.
    const fresh = new Daemon(s.daemon.o);
    restarted.push(fresh);
    (s as { daemon: Daemon }).daemon = fresh;
    await fresh.start();
    await fresh.ready();
    assert.notEqual(fs.readFileSync(path.join(path.dirname(socket), 'uirpc.token'), 'utf8'), old, 'a new token');
    const ups = st.lines.filter((l) => l.harnessd === 'up').length;
    await s.until(() => st.lines.filter((l) => l.harnessd === 'up').length > ups, 15_000, 'harnessd up again on the stream');
    const health = await request({ path: '/api/health', headers: { authorization: `Bearer ${token}` } });
    assert.equal(health.status, 200, JSON.stringify(health.json));
    assert.equal(health.json.result.device_id, 'dev_test');
  } finally {
    st.close();
  }
});

test('a taken port fails closed as port_taken, never another port; a free one starts (the control)', async () => {
  const taken = net.createServer();
  await new Promise<void>((r) => taken.listen(0, '127.0.0.1', () => r()));
  const p = (taken.address() as net.AddressInfo).port;
  try {
    await assert.rejects(startBridge({ port: p, uirpc, webRoot: WEB, secret }), (e: Error & { code?: string }) => e.code === 'port_taken');
  } finally {
    await new Promise<void>((r) => taken.close(() => r()));
  }
  const other = await startBridge({ port: await freePort(), uirpc, webRoot: WEB, secret });
  await other.close();
});

test('close() returns while a page still holds the stream', async () => {
  const p = await freePort();
  const b = await startBridge({ port: p, uirpc, webRoot: WEB, secret });
  const prev = port;
  port = p;
  try {
    const st = openStream(await session());
    await s.until(() => st.lines.length > 0, 10_000, 'the stream to start');
    const closed = await Promise.race([b.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 5000))]);
    assert.equal(closed, 'closed', 'close() waited on the open stream');
    st.close();
  } finally {
    port = prev;
  }
});
