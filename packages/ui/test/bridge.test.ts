// The UI bridge (D-117; protocol.md §12). Everything here goes through createBridge().handle(), which takes a plain
// { method, url, headers, body }: no socket is opened and no port is listened on. Port 7480 appears only as the Host
// the bridge insists on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createBridge, type BridgeRequest, type BridgeResponse, type BridgeOptions, type Uirpc,
} from '../src/bridge.ts';
import { UirpcError } from '../src/uirpc-client.ts';

const PORT = 7480;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const SECRET = Buffer.from('b0a1c2d3e4f5061728394a5b6c7d8e9f00112233445566778899aabbccddeeff', 'hex');
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const hex = (n: number) => Buffer.alloc(n, 7).toString('hex');

/** A webRoot with one file per MIME entry, plus a symlink that escapes it. */
function webRoot(): { dir: string; outside: string } {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-web-')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ui-out-')));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>ui</p>');
  fs.writeFileSync(path.join(dir, 'style.css'), 'body { color: red }');
  fs.writeFileSync(path.join(dir, 'app.ts'), 'const answer: number = 42;\nexport {};\n');
  fs.writeFileSync(path.join(dir, 'mod.js'), 'export const n = 1;\n');
  fs.writeFileSync(path.join(dir, 'data.json'), '{"a":1}');
  fs.writeFileSync(path.join(dir, 'icon.svg'), '<svg/>');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not served');
  fs.writeFileSync(path.join(outside, 'secret.html'), 'outside');
  fs.symlinkSync(path.join(outside, 'secret.html'), path.join(dir, 'link.html'));
  return { dir, outside };
}

type Call = { method: string; params: Record<string, unknown> | undefined };

/** A webRoot shared by the tests that don't care which files are in it. */
const ROOT = webRoot().dir;

function harness(o: { webRoot?: string; port?: number; now?: () => number } = {}) {
  const calls: Call[] = [];
  let failure: Error | null = null;
  let result: unknown = { ok: true };
  let unsubscribed = false;
  let onMessage: ((m: { project_id: string; seq: number; snapshot: unknown }) => void) | null = null;
  let onState: ((s: 'up' | 'down') => void) | null = null;
  const uirpc: Uirpc = {
    call: (method, params) => {
      calls.push({ method, params });
      if (failure) return Promise.reject(failure);
      return Promise.resolve(result);
    },
    stream: (m, s) => {
      onMessage = m;
      onState = s;
      return () => { unsubscribed = true; onMessage = null; onState = null; };
    },
  };
  const options: BridgeOptions = { port: o.port ?? PORT, uirpc, webRoot: o.webRoot ?? ROOT, secret: SECRET, ...(o.now ? { now: o.now } : {}) };
  const bridge = createBridge(options);
  return {
    calls, bridge,
    setFailure: (e: Error | null) => { failure = e; },
    setResult: (r: unknown) => { result = r; },
    unsubscribed: () => unsubscribed,
    message: (m: { project_id: string; seq: number; snapshot: unknown }) => onMessage?.(m),
    state: (s: 'up' | 'down') => onState?.(s),
  };
}

function rq(method: string, url: string, body?: unknown, headers: Record<string, string | undefined> = {}): BridgeRequest {
  const has = body !== undefined;
  const raw = !has ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return { method, url, headers: { host: HOST, ...(has ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw };
}

/** The text of a response that carries a body (not a stream). */
const bodyText = (res: BridgeResponse): string => {
  if (!('body' in res)) throw new Error('expected a body response, got a stream');
  return res.body.toString();
};
const j = (res: BridgeResponse): Record<string, unknown> => JSON.parse(bodyText(res)) as Record<string, unknown>;

function hmac(secret: Buffer, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/** Runs the whole launch handshake and returns the session token. */
async function session(bridge: { handle(r: BridgeRequest): Promise<BridgeResponse> }, nonce_c = hex(32)): Promise<string> {
  const challenge = await bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c }));
  const { nonce_b, proof } = j(challenge) as { nonce_b: string; proof: string };
  assert.equal(proof, hmac(SECRET, `bridge:${nonce_c}${nonce_b}`));
  const launched = await bridge.handle(rq('POST', '/api/launch', { nonce_c, nonce_b, mac: hmac(SECRET, `launch:${nonce_c}${nonce_b}`) }));
  assert.equal(launched.status, 200);
  const got = await bridge.handle(rq('POST', '/api/session', { launch_token: (j(launched) as { launch_token: string }).launch_token }));
  assert.equal(got.status, 200);
  return (j(got) as { session_token: string }).session_token;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

// --- Host, Origin and headers -----------------------------------------------------------------------------------

test('Host must be exactly 127.0.0.1:<port>', async () => {
  const h = harness();
  assert.equal((await h.bridge.handle(rq('GET', '/', undefined, { host: `localhost:${PORT}` }))).status, 403);
  assert.equal((await h.bridge.handle(rq('GET', '/', undefined, { host: `127.0.0.1:${PORT + 1}` }))).status, 403);
  assert.equal((await h.bridge.handle(rq('GET', '/', undefined, { host: undefined }))).status, 403);
  assert.equal((await h.bridge.handle(rq('GET', '/'))).status, 200, 'the right Host passes');
});

test('Origin, when present, must be exactly http://127.0.0.1:<port>', async () => {
  const h = harness();
  assert.equal((await h.bridge.handle(rq('GET', '/', undefined, { origin: 'http://127.0.0.1:1' }))).status, 403);
  assert.equal((await h.bridge.handle(rq('GET', '/', undefined, { origin: 'https://evil.example' }))).status, 403);
  assert.equal((await h.bridge.handle(rq('GET', '/', undefined, { origin: ORIGIN }))).status, 200, 'the same origin passes');
});

test('every response carries the §12 security headers; /api/* also no-store', async () => {
  const h = harness();
  const page = await h.bridge.handle(rq('GET', '/'));
  assert.equal(page.headers['Content-Security-Policy'], CSP);
  assert.equal(page.headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(page.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(page.headers['Cache-Control'], undefined, 'static files are not no-store');
  assert.equal(page.headers['Content-Type'], 'text/html; charset=utf-8');

  const api = await h.bridge.handle(rq('GET', '/api/snapshot', undefined, auth(await session(h.bridge))));
  assert.equal(api.status, 200);
  assert.equal(api.headers['Cache-Control'], 'no-store');
  assert.equal(api.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(api.headers['Content-Security-Policy'], CSP);
  assert.equal(api.headers['Referrer-Policy'], 'no-referrer');
  assert.equal(api.headers['X-Content-Type-Options'], 'nosniff');

  const refused = await h.bridge.handle(rq('GET', '/api/snapshot'));
  assert.equal(refused.status, 401);
  assert.equal(refused.headers['Cache-Control'], 'no-store');
});

// --- The launch handshake ---------------------------------------------------------------------------------------

test('the challenge answers a fresh nonce_b and a bridge proof, once each', async () => {
  const h = harness();
  const nonce_c = hex(32);
  const first = await h.bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c }));
  assert.equal(first.status, 200);
  const a = j(first) as { nonce_b: string; proof: string };
  assert.equal(a.nonce_b.length, 64);
  assert.equal(a.proof, hmac(SECRET, `bridge:${nonce_c}${a.nonce_b}`));
  const second = await h.bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c }));
  assert.notEqual((j(second) as { nonce_b: string }).nonce_b, a.nonce_b, 'every challenge is fresh');
});

test('a nonce_c that is not 64 hex characters is refused with 400', async () => {
  const h = harness();
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c: 'ab' }))).status, 400);
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch/challenge', {}))).status, 400);
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c: 'g'.repeat(64) }))).status, 400);
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c: hex(32) }))).status, 200, 'the control passes');
});

test('a wrong mac is 401', async () => {
  const h = harness();
  const nonce_c = hex(32);
  const ask = async () => (j(await h.bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c }))) as { nonce_b: string }).nonce_b;
  const one = await ask();
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch', { nonce_c, nonce_b: one, mac: hex(32) }))).status, 401, 'not the bridge mac');
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch', { nonce_c, nonce_b: one, mac: hmac(SECRET, `launch:${nonce_c}${one}`) }))).status, 401, 'one guess per nonce_b');
  const two = await ask();
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch', { nonce_c: 'ab'.repeat(32), nonce_b: two, mac: hmac(SECRET, `launch:${nonce_c}${two}`) }))).status, 401, 'a nonce_c that was not this one');
  const three = await ask();
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch', { nonce_c, nonce_b: three, mac: hmac(SECRET, `launch:${nonce_c}${three}`) }))).status, 200, 'the control passes');
});

test('an unknown, reused or old nonce_b is 401', async () => {
  let now = 1000;
  const h = harness({ now: () => now });
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch', { nonce_c: hex(32), nonce_b: hex(32), mac: hex(32) }))).status, 401, 'never issued');

  const nonce_c = hex(32);
  const { nonce_b } = j(await h.bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c }))) as { nonce_b: string };
  const mac = hmac(SECRET, `launch:${nonce_c}${nonce_b}`);
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch', { nonce_c, nonce_b, mac }))).status, 200);
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch', { nonce_c, nonce_b, mac }))).status, 401, 'reused');

  const two = j(await h.bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c }))) as { nonce_b: string };
  now += 10_000; // exactly 10 s: no longer within the window
  assert.equal((await h.bridge.handle(rq('POST', '/api/launch', { nonce_c, nonce_b: two.nonce_b, mac: hmac(SECRET, `launch:${nonce_c}${two.nonce_b}`) }))).status, 401, 'old');
});

test('a launch token is single use and expires after 60 s', async () => {
  let now = 5000;
  const h = harness({ now: () => now });
  const nonce_c = hex(32);
  const { nonce_b } = j(await h.bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c }))) as { nonce_b: string };
  const { launch_token } = j(await h.bridge.handle(rq('POST', '/api/launch', { nonce_c, nonce_b, mac: hmac(SECRET, `launch:${nonce_c}${nonce_b}`) }))) as { launch_token: string };
  assert.equal((await h.bridge.handle(rq('POST', '/api/session', { launch_token }))).status, 200);
  assert.equal((await h.bridge.handle(rq('POST', '/api/session', { launch_token }))).status, 401, 'used');

  const c2 = j(await h.bridge.handle(rq('POST', '/api/launch/challenge', { nonce_c }))) as { nonce_b: string };
  const l2 = j(await h.bridge.handle(rq('POST', '/api/launch', { nonce_c, nonce_b: c2.nonce_b, mac: hmac(SECRET, `launch:${nonce_c}${c2.nonce_b}`) }))) as { launch_token: string };
  now += 60_000;
  assert.equal((await h.bridge.handle(rq('POST', '/api/session', { launch_token: l2.launch_token }))).status, 401, 'expired');
  assert.equal((await h.bridge.handle(rq('POST', '/api/session', { launch_token: hex(32) }))).status, 401, 'unknown');
});

test('a session token is required on every other /api route, compared in full', async () => {
  const h = harness();
  const token = await session(h.bridge);
  assert.equal((await h.bridge.handle(rq('GET', '/api/snapshot'))).status, 401, 'missing');
  assert.equal((await h.bridge.handle(rq('GET', '/api/snapshot', undefined, auth(hex(32))))).status, 401, 'unknown');
  assert.equal((await h.bridge.handle(rq('GET', '/api/snapshot', undefined, auth(`${token}x`)))).status, 401, 'a longer token');
  assert.equal((await h.bridge.handle(rq('GET', '/api/snapshot', undefined, { authorization: token }))).status, 401, 'no Bearer prefix');
  const refused = await h.bridge.handle(rq('GET', '/api/snapshot'));
  assert.deepEqual(j(refused), { error: { code: 'unauthorized', message: 'a session token is required' } });
  assert.equal((await h.bridge.handle(rq('GET', '/api/snapshot', undefined, auth(token)))).status, 200, 'the control passes');
});

test('at most 32 sessions are kept, the oldest dropped', async () => {
  const h = harness();
  const first = await session(h.bridge);
  for (let i = 0; i < 31; i++) await session(h.bridge);
  assert.equal((await h.bridge.handle(rq('GET', '/api/health', undefined, auth(first)))).status, 200, 'still within 32');
  const last = await session(h.bridge);
  assert.equal((await h.bridge.handle(rq('GET', '/api/health', undefined, auth(first)))).status, 401, 'the oldest was dropped');
  assert.equal((await h.bridge.handle(rq('GET', '/api/health', undefined, auth(last)))).status, 200);
});

// --- Bodies -----------------------------------------------------------------------------------------------------

test('an /api POST needs a JSON content type and an object body', async () => {
  const h = harness();
  const token = await session(h.bridge);
  assert.equal((await h.bridge.handle(rq('POST', '/api/command', 'not json', auth(token)))).status, 400, 'a non-JSON body');
  assert.equal((await h.bridge.handle(rq('POST', '/api/command', '[1,2]', auth(token)))).status, 400, 'an array body');
  assert.equal((await h.bridge.handle(rq('POST', '/api/command', 'null', auth(token)))).status, 400);
  assert.equal((await h.bridge.handle(rq('POST', '/api/command', { name: 'x' }, { ...auth(token), 'content-type': 'text/plain' }))).status, 400, 'the wrong content type');
  assert.equal((await h.bridge.handle(rq('POST', '/api/command', { name: 'x' }))).status, 401, 'no session still 401, not 400');
  const ok = await h.bridge.handle(rq('POST', '/api/command', { project_id: 'p', name: 'task.create', args: {}, command_id: 'c' }, { ...auth(token), 'content-type': 'application/json; charset=utf-8' }));
  assert.equal(ok.status, 200, 'a charset parameter is fine');
});

test('a body over 65536 bytes is 413', async () => {
  const h = harness();
  const token = await session(h.bridge);
  const big = { name: 'x', args: { text: 'a'.repeat(65537) } };
  assert.equal((await h.bridge.handle(rq('POST', '/api/command', big, auth(token)))).status, 413);
  const justUnder = { name: 'x', args: { text: 'a'.repeat(65000) } };
  assert.equal((await h.bridge.handle(rq('POST', '/api/command', justUnder, auth(token)))).status, 200, 'the control passes');
});

// --- Routes -----------------------------------------------------------------------------------------------------

test('GET routes map onto their uirpc methods', async () => {
  const h = harness();
  const token = await session(h.bridge);
  h.setResult({ hello: 'world' });
  for (const [url, method] of [['/api/snapshot', 'snapshot'], ['/api/health', 'health'], ['/api/approvals', 'pending_approvals']] as const) {
    h.calls.length = 0;
    const res = await h.bridge.handle(rq('GET', url, undefined, auth(token)));
    assert.equal(res.status, 200);
    assert.deepEqual(j(res), { result: { hello: 'world' } });
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0]?.method, method);
  }
});

test('the launch routes call nothing on harnessd', async () => {
  const h = harness();
  await session(h.bridge);
  assert.deepEqual(h.calls, []);
});

test('POST /api/approvals/:id carries the id, the decision and the shown hash', async () => {
  const h = harness();
  const token = await session(h.bridge);
  const ok = await h.bridge.handle(rq('POST', '/api/approvals/req-1', { decision: 'approve', shown_hash: 'a'.repeat(64) }, auth(token)));
  assert.equal(ok.status, 200);
  assert.deepEqual(h.calls.at(-1), { method: 'approve', params: { id: 'req-1', shown_hash: 'a'.repeat(64) } });
  await h.bridge.handle(rq('POST', '/api/approvals/req-2', { decision: 'deny' }, auth(token)));
  assert.deepEqual(h.calls.at(-1), { method: 'deny', params: { id: 'req-2' } });
  assert.equal((await h.bridge.handle(rq('POST', '/api/approvals/req-3', { decision: 'maybe' }, auth(token)))).status, 400, 'another decision is 400');
  assert.equal(h.calls.length, 2, 'a bad decision never reaches harnessd');
});

test('POST /api/command, /api/dispatch and /api/provider/reset pass their fields through', async () => {
  const h = harness();
  const token = await session(h.bridge);
  await h.bridge.handle(rq('POST', '/api/command', { project_id: 'p1', name: 'message.send', args: { text: 'hi' }, command_id: 'c1' }, auth(token)));
  assert.deepEqual(h.calls.at(-1), { method: 'command', params: { project_id: 'p1', name: 'message.send', args: { text: 'hi' }, command_id: 'c1' } });
  await h.bridge.handle(rq('POST', '/api/dispatch', { project_id: 'p1', kind: 'start', task_id: 'T-2', args: { assignee_agent_id: 'a1' }, expected: { task_sha256: 'h' }, command_id: 'c2' }, auth(token)));
  assert.deepEqual(h.calls.at(-1), { method: 'dispatch', params: { project_id: 'p1', kind: 'start', task_id: 'T-2', args: { assignee_agent_id: 'a1' }, expected: { task_sha256: 'h' }, command_id: 'c2' } });
  await h.bridge.handle(rq('POST', '/api/provider/reset', {}, auth(token)));
  assert.deepEqual(h.calls.at(-1), { method: 'provider_reset', params: {} });
});

test('an unknown /api route is 404', async () => {
  const h = harness();
  const token = await session(h.bridge);
  assert.equal((await h.bridge.handle(rq('GET', '/api/nope', undefined, auth(token)))).status, 404);
  assert.equal((await h.bridge.handle(rq('POST', '/api/nope', {}, auth(token)))).status, 404);
  assert.equal((await h.bridge.handle(rq('GET', '/api/session', undefined, auth(token)))).status, 404, 'session is POST only');
});

test("harnessd's codes set the status; anything else is 502", async () => {
  const h = harness();
  const token = await session(h.bridge);
  for (const [code, status] of [['not_found', 404], ['conflict', 409], ['forbidden', 403], ['bad_request', 400], ['not_available', 501], ['unavailable', 503], ['timeout', 504], ['internal', 502]] as const) {
    h.setFailure(new UirpcError(code, `no: ${code}`));
    const res = await h.bridge.handle(rq('GET', '/api/snapshot', undefined, auth(token)));
    assert.equal(res.status, status, code);
    assert.deepEqual(j(res), { error: { code, message: `no: ${code}` } });
  }
});

// --- Static files -----------------------------------------------------------------------------------------------

test('static files: index.html, MIME table, and .ts served stripped', async () => {
  const root = webRoot();
  const h = harness({ webRoot: root.dir });
  const page = await h.bridge.handle(rq('GET', '/'));
  assert.equal(page.status, 200);
  assert.equal(bodyText(page), '<!doctype html><p>ui</p>');
  assert.equal(bodyText(await h.bridge.handle(rq('GET', '/launch'))), '<!doctype html><p>ui</p>', '/launch serves the same index.html');

  const cases: Array<[string, string, string]> = [
    ['/style.css', 'text/css; charset=utf-8', 'body { color: red }'],
    ['/mod.js', 'text/javascript; charset=utf-8', 'export const n = 1;\n'],
    ['/data.json', 'application/json', '{"a":1}'],
    ['/icon.svg', 'image/svg+xml', '<svg/>'],
  ];
  for (const [url, type, body] of cases) {
    const res = await h.bridge.handle(rq('GET', url));
    assert.equal(res.status, 200, url);
    assert.equal(res.headers['Content-Type'], type, url);
    assert.equal(bodyText(res), body, url);
  }

  const ts = await h.bridge.handle(rq('GET', '/app.ts'));
  assert.equal(ts.status, 200);
  assert.equal(ts.headers['Content-Type'], 'text/javascript; charset=utf-8');
  assert.ok(!bodyText(ts).includes(': number'), 'the type annotation was stripped');
  assert.ok(bodyText(ts).includes('const answer'), 'the value survives');

  assert.equal((await h.bridge.handle(rq('GET', '/notes.txt'))).status, 404, 'an extension off the table');
  assert.equal((await h.bridge.handle(rq('GET', '/missing.html'))).status, 404);
  assert.equal((await h.bridge.handle(rq('POST', '/'))).status, 404, 'static files are GET only');
});

test('the path may not escape webRoot', async () => {
  const root = webRoot();
  const h = harness({ webRoot: root.dir });
  assert.equal((await h.bridge.handle(rq('GET', '/../secret.html'))).status, 404, 'a .. segment');
  assert.equal((await h.bridge.handle(rq('GET', '/%2e%2e/secret.html'))).status, 404, 'a percent-encoded .. segment');
  assert.equal((await h.bridge.handle(rq('GET', '/..%2fsecret.html'))).status, 404);
  assert.equal((await h.bridge.handle(rq('GET', '/%00.html'))).status, 404, 'a NUL');
  assert.equal((await h.bridge.handle(rq('GET', '/sub\\index.html'))).status, 404, 'a backslash');
  assert.equal((await h.bridge.handle(rq('GET', '/link.html'))).status, 404, 'a symlink out of webRoot');
  assert.equal((await h.bridge.handle(rq('GET', '/%zz'))).status, 400, 'a bad escape');
  assert.equal((await h.bridge.handle(rq('GET', '/index.html'))).status, 200, 'the control passes');
});

// --- The stream -------------------------------------------------------------------------------------------------

test('/api/stream sends each snapshot and each state change, and unsubscribes', async () => {
  const h = harness();
  const token = await session(h.bridge);
  const res = await h.bridge.handle(rq('GET', '/api/stream', undefined, auth(token)));
  assert.equal(res.status, 200);
  assert.equal(res.headers['Content-Type'], 'application/x-ndjson');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.ok('stream' in res);
  if (!('stream' in res)) return;
  const lines: string[] = [];
  const off = res.stream((l) => lines.push(l));

  h.message({ project_id: 'p1', seq: 4, snapshot: { head_seq: 4 } });
  h.state('down');
  h.state('up');
  assert.deepEqual(lines, ['{"snapshot":{"head_seq":4}}', '{"harnessd":"down"}', '{"harnessd":"up"}']);
  assert.equal(h.unsubscribed(), false);
  off();
  assert.equal(h.unsubscribed(), true);
  // After unsubscribe, nothing more is sent.
  h.message({ project_id: 'p1', seq: 5, snapshot: {} });
  assert.equal(lines.length, 3);
});

test('/api/stream needs a session too', async () => {
  const h = harness();
  assert.equal((await h.bridge.handle(rq('GET', '/api/stream'))).status, 401);
});
