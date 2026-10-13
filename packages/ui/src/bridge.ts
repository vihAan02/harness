// The UI bridge (D-117; protocol.md §12): the local HTTP server between the browser and harnessd's socket.
// It holds no state of its own that matters — the session tokens it hands the page, and the nonces that prove the
// bridge is really the bridge. Nothing here logs or returns a token or the secret.
//
// `handle()` is the whole request path, over a plain { method, url, headers, body } request, so tests exercise it
// with no sockets. `startBridge()` is the thin node:http shell around it.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import type { UirpcClient } from './uirpc-client.ts';

export type BridgeRequest = { method: string; url: string; headers: Record<string, string | undefined>; body: Buffer };
export type BridgeResponse = { status: number; headers: Record<string, string>; body: string | Buffer }
  | { status: number; headers: Record<string, string>; stream: (send: (line: string) => void) => () => void };

export class BridgeError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The part of UirpcClient the bridge uses; tests pass a fake. */
export type Uirpc = Pick<UirpcClient, 'call' | 'stream'>;
export type BridgeOptions = { port: number; uirpc: Uirpc; webRoot: string; secret: Buffer; now?: () => number };

/** protocol.md §12, verbatim. */
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const MAX_BODY = 65536;
const NONCE_TTL_MS = 10_000;
const LAUNCH_TTL_MS = 60_000;
const MAX_SESSIONS = 32;
const MAX_CHALLENGES = 1024;
const HEX64 = /^[0-9a-f]{64}$/;
const KEEPALIVE_MS = 15_000;

/** harnessd's error codes, as HTTP statuses (§12). */
const STATUS_BY_CODE: Record<string, number> = {
  not_found: 404, conflict: 409, forbidden: 403, bad_request: 400, not_available: 501, unavailable: 503, timeout: 504,
};
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ts': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
};

/** Constant-time string compare that never throws on unequal lengths. */
function ctEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function hmac(secret: Buffer, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

/** Splits a request URL into its path and query, without touching the filesystem. */
function urlPath(url: string): string {
  let p = url;
  const hash = p.indexOf('#');
  if (hash >= 0) p = p.slice(0, hash);
  const q = p.indexOf('?');
  if (q >= 0) p = p.slice(0, q);
  return p;
}

export function createBridge(o: BridgeOptions): { handle(req: BridgeRequest): Promise<BridgeResponse> } {
  const now = o.now ?? (() => Date.now());
  const host = `127.0.0.1:${o.port}`;
  const origin = `http://${host}`;
  const webRoot = fs.realpathSync(o.webRoot);
  /** nonce_b → what the bridge issued it for; accepted once, within NONCE_TTL_MS. */
  const challenges = new Map<string, { nonce_c: string; at: number }>();
  /** launch tokens, single use, LAUNCH_TTL_MS. */
  const launches = new Map<string, number>();
  /** session tokens, in insertion order; the oldest is dropped past MAX_SESSIONS. */
  const sessions = new Map<string, number>();

  const baseHeaders = (): Record<string, string> => ({
    'Content-Security-Policy': CSP,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });

  const json = (status: number, value: unknown, isApi: boolean): BridgeResponse => ({
    status,
    headers: {
      ...baseHeaders(),
      ...(isApi ? { 'Cache-Control': 'no-store' } : {}),
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(value),
  });
  const fail = (status: number, code: string, message: string, isApi: boolean): BridgeResponse => json(status, { error: { code, message } }, isApi);

  /** A UirpcError becomes the status §12 gives its code; anything unknown is a bad gateway. */
  const failRpc = (e: unknown, isApi: boolean): BridgeResponse => {
    const code = typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'internal';
    const message = e instanceof Error ? e.message : String(e);
    return fail(STATUS_BY_CODE[code] ?? 502, code, message, isApi);
  };

  const hasSession = (req: BridgeRequest): boolean => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return false;
    const token = auth.slice('Bearer '.length);
    let ok = false;
    for (const s of sessions.keys()) if (ctEqual(s, token)) ok = true; // no early exit: a constant-time compare each
    return ok;
  };

  const issueSession = (): string => {
    const t = randomBytes(32).toString('hex');
    sessions.set(t, now());
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
    return t;
  };

  const challenge = (body: Record<string, unknown>): BridgeResponse => {
    const nonce_c = body.nonce_c;
    if (typeof nonce_c !== 'string' || !HEX64.test(nonce_c)) return fail(400, 'bad_request', 'nonce_c must be 64 hex characters', true);
    const at = now();
    for (const [k, v] of challenges) if (at - v.at >= NONCE_TTL_MS) challenges.delete(k);
    while (challenges.size >= MAX_CHALLENGES) {
      const oldest = challenges.keys().next().value;
      if (oldest === undefined) break;
      challenges.delete(oldest);
    }
    const nonce_b = randomBytes(32).toString('hex');
    challenges.set(nonce_b, { nonce_c, at });
    return json(200, { nonce_b, proof: hmac(o.secret, `bridge:${nonce_c}${nonce_b}`) }, true);
  };

  const launch = (body: Record<string, unknown>): BridgeResponse => {
    const { nonce_c, nonce_b, mac } = body;
    const issued = typeof nonce_b === 'string' ? challenges.get(nonce_b) : undefined;
    // Unknown, reused, old, or issued for another nonce_c: refused the same way as a bad mac.
    if (typeof nonce_b !== 'string' || typeof nonce_c !== 'string' || typeof mac !== 'string' || !issued || issued.nonce_c !== nonce_c || now() - issued.at >= NONCE_TTL_MS) {
      return fail(401, 'unauthorized', 'the launch request did not come from this bridge', true);
    }
    challenges.delete(nonce_b);
    if (!ctEqual(mac, hmac(o.secret, `launch:${nonce_c}${nonce_b}`))) return fail(401, 'unauthorized', 'bad launch mac', true);
    const at = now();
    for (const [k, v] of launches) if (at - v >= LAUNCH_TTL_MS) launches.delete(k);
    const token = randomBytes(32).toString('hex');
    launches.set(token, at);
    return json(200, { launch_token: token }, true);
  };

  const session = (body: Record<string, unknown>): BridgeResponse => {
    const t = body.launch_token;
    const at = typeof t === 'string' ? launches.get(t) : undefined;
    if (typeof t !== 'string' || at === undefined || now() - at >= LAUNCH_TTL_MS) return fail(401, 'unauthorized', 'the launch token is used, expired or unknown', true);
    launches.delete(t); // single use
    return json(200, { session_token: issueSession() }, true);
  };

  const approved = (id: string, body: Record<string, unknown>): BridgeResponse | Promise<BridgeResponse> => {
    const decision = body.decision;
    if (decision === 'approve') return Promise.resolve(o.uirpc.call('approve', { id, shown_hash: body.shown_hash })).then((r) => json(200, { result: r }, true), (e) => failRpc(e, true));
    if (decision === 'deny') return Promise.resolve(o.uirpc.call('deny', { id })).then((r) => json(200, { result: r }, true), (e) => failRpc(e, true));
    return fail(400, 'bad_request', "decision must be 'approve' or 'deny'", true);
  };

  const apiRoute = (req: BridgeRequest, p: string, body: Record<string, unknown>): BridgeResponse | Promise<BridgeResponse> => {
    const pass = (method: string, params: Record<string, unknown>): Promise<BridgeResponse> =>
      Promise.resolve(o.uirpc.call(method, params)).then((r) => json(200, { result: r }, true), (e) => failRpc(e, true));

    if (req.method === 'POST') {
      if (p === '/api/launch/challenge') return challenge(body);
      if (p === '/api/launch') return launch(body);
      if (p === '/api/session') return session(body);
    }
    if (!hasSession(req)) return fail(401, 'unauthorized', 'a session token is required', true);
    if (req.method === 'GET' && p === '/api/snapshot') return pass('snapshot', {});
    if (req.method === 'GET' && p === '/api/health') return pass('health', {});
    if (req.method === 'GET' && p === '/api/approvals') return pass('pending_approvals', {});
    if (req.method === 'POST' && p.startsWith('/api/approvals/')) return approved(decodeURIComponent(p.slice('/api/approvals/'.length)), body);
    if (req.method === 'POST' && p === '/api/command') {
      return pass('command', { project_id: body.project_id, name: body.name, args: body.args, command_id: body.command_id });
    }
    if (req.method === 'POST' && p === '/api/dispatch') {
      return pass('dispatch', { project_id: body.project_id, kind: body.kind, task_id: body.task_id, args: body.args, expected: body.expected, command_id: body.command_id });
    }
    if (req.method === 'POST' && p === '/api/provider/reset') return pass('provider_reset', {});
    if (req.method === 'GET' && p === '/api/stream') {
      return {
        status: 200,
        headers: { ...baseHeaders(), 'Cache-Control': 'no-store', 'Content-Type': 'application/x-ndjson' },
        stream: (send) => {
          const keepalive = setInterval(() => send(JSON.stringify({ keepalive: true })), KEEPALIVE_MS);
          const off = o.uirpc.stream(
            (m) => send(JSON.stringify({ snapshot: m.snapshot })),
            (s) => send(JSON.stringify({ harnessd: s })),
          );
          return () => { clearInterval(keepalive); off(); };
        },
      };
    }
    return fail(404, 'not_found', 'no such route', true);
  };

  const staticFile = (req: BridgeRequest, p: string): BridgeResponse => {
    if (req.method !== 'GET') return fail(404, 'not_found', 'no such file', false);
    let decoded: string;
    try {
      decoded = decodeURIComponent(p === '/' || p === '/launch' ? '/index.html' : p);
    } catch {
      return fail(400, 'bad_request', 'the path is not valid percent-encoding', false);
    }
    if (decoded.includes('\0') || decoded.includes('\\') || decoded.split('/').includes('..')) return fail(404, 'not_found', 'no such file', false);
    const file = path.resolve(webRoot, `.${decoded}`);
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime) return fail(404, 'not_found', 'no such file', false);
    let real: string;
    try {
      real = fs.realpathSync(file);
      if (real !== webRoot && !real.startsWith(webRoot + path.sep)) return fail(404, 'not_found', 'no such file', false);
      if (!fs.statSync(real).isFile()) return fail(404, 'not_found', 'no such file', false);
    } catch {
      return fail(404, 'not_found', 'no such file', false);
    }
    const headers = { ...baseHeaders(), 'Content-Type': mime };
    try {
      const src = fs.readFileSync(real, 'utf8');
      return { status: 200, headers, body: real.endsWith('.ts') ? stripTypeScriptTypes(src, { mode: 'strip' }) : src };
    } catch {
      return fail(404, 'not_found', 'no such file', false);
    }
  };

  return {
    async handle(req: BridgeRequest): Promise<BridgeResponse> {
      const p = urlPath(req.url);
      const isApi = p === '/api' || p.startsWith('/api/');
      // Host and Origin must name this bridge exactly: nothing else may talk to it.
      if (req.headers.host !== host || (req.headers.origin !== undefined && req.headers.origin !== origin)) {
        return fail(403, 'forbidden', 'host or origin is not this bridge', isApi);
      }
      let body: Record<string, unknown> = {};
      if (isApi && req.method === 'POST') {
        if (req.body.length > MAX_BODY) return fail(413, 'bad_request', `the body is over ${MAX_BODY} bytes`, true);
        const ct = req.headers['content-type'];
        if (typeof ct !== 'string' || ct.split(';')[0]?.trim().toLowerCase() !== 'application/json') return fail(400, 'bad_request', 'the body must be JSON', true);
        try {
          const parsed: unknown = JSON.parse(req.body.toString('utf8'));
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          body = parsed as Record<string, unknown>;
        } catch {
          return fail(400, 'bad_request', 'the body must be a JSON object', true);
        }
      }
      return isApi ? apiRoute(req, p, body) : staticFile(req, p);
    },
  };
}

export function startBridge(o: BridgeOptions): Promise<{ url: string; close(): Promise<void> }> {
  const bridge = createBridge(o);
  const server = http.createServer();
  const open = new Set<() => void>();
  const baseHeadersFor = () => ({ 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });

  server.on('request', (req, res) => {
    const chunks: Buffer[] = [];
    let len = 0;
    let tooBig = false;
    req.on('error', () => {});
    req.on('data', (c: Buffer) => {
      if (tooBig) return;
      len += c.length;
      // At most 65537 bytes: one more than the limit, so handle() can answer 413 without buffering a flood.
      if (len > MAX_BODY) { tooBig = true; chunks.length = 0; chunks.push(c.subarray(0, MAX_BODY + 1)); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      void bridge.handle({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers as Record<string, string | undefined>,
        body: Buffer.concat(chunks),
      }).then((out) => {
        res.writeHead(out.status, out.headers);
        if ('stream' in out) {
          const off = out.stream((line) => { if (!res.writableEnded) res.write(`${line}\n`); });
          // Ending the response here too: close() runs this for every open stream, and server.close() waits for the
          // response to end, so without it close() would hang while a page is subscribed.
          const stop = () => {
            off();
            if (!res.writableEnded && !res.destroyed) res.end();
            open.delete(stop);
          };
          open.add(stop);
          res.on('close', stop);
          return;
        }
        res.end(out.body);
      }, (e: unknown) => {
        res.writeHead(500, { ...baseHeadersFor(), 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } }));
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') return reject(new BridgeError('port_taken', `127.0.0.1:${o.port} is taken`));
      reject(e);
    });
    server.listen(o.port, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => {
          for (const stop of [...open]) stop();
          server.close(() => done());
        }),
      });
    });
  });
}
