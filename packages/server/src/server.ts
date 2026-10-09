// The coordination server's WebSocket endpoint (0A item 3; docs/protocol.md §2 to §4).
// - Phase 0 is loopback only, and every client presents the local token (D-74).
// - The events table is the record. A client learns about the world only from events: replayed
//   from its cursor when it subscribes, then pushed as they commit, in seq order, at least once.
// - Postgres LISTEN/NOTIFY only wakes the fan-out up. The payload is a project id, never an event.
//   The listener reconnects and catches up, and a timer poll covers notifications that never
//   arrive (D-11, F-54).
import { createHash, timingSafeEqual } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { WebSocketServer, type WebSocket } from 'ws';
import { PROTOCOL_VERSION, type Command, type ErrorCode, type EventMessage, type Hello, type ProjectHead, type ServerMessage, type Subscription } from '@harness/protocol';
import { CommandError, EVENTS_CHANNEL, executeCommand } from './commands.ts';
import { readEvents, type StoredEvent } from './events.ts';
import { heartbeat, sweepOffline } from './presence.ts';
import { sweepWaits } from './waits.ts';

export type ServerOptions = {
  pool: pg.Pool;
  /** For the dedicated LISTEN connection, which must be direct, not through a transaction pooler (F-54). */
  databaseUrl: string;
  schema?: string;
  localToken: string;
  host?: string; // default 127.0.0.1: Phase 0 never listens beyond loopback
  port?: number; // default 7400; 0 picks a free port
  pollIntervalMs?: number; // default 5000
  offlineAfterMs?: number; // default 30000: a device silent this long is marked offline (D-75)
  waitSweepMs?: number; // default 1000: how often open waits are resolved, timed out or cancelled (D-95)
  helloTimeoutMs?: number; // default 10000
  onError?: (e: unknown) => void;
};
export type RunningServer = { url: string; port: number; close: () => Promise<void> };

// The protocol carries paths, hashes and short text, never file contents. A land or a full diff report can
// list up to 5,000 paths of up to 1,000 characters each, so frames go up to 8 MiB.
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const REPLAY_BATCH = 500;

type Sub = { cursor: number; pumping: boolean; again: boolean };
type Conn = { ws: WebSocket; principal: string | null; deviceId: string | null; subs: Map<string, Sub>; queue: Promise<void> };

export async function startServer(o: ServerOptions): Promise<RunningServer> {
  const onError = o.onError ?? ((e: unknown) => console.error('harness server:', e));
  const conns = new Set<Conn>();
  let closing = false;

  const send = (c: Conn, m: ServerMessage) => { if (c.ws.readyState === c.ws.OPEN) c.ws.send(JSON.stringify(m)); };
  const fail = (c: Conn, code: ErrorCode, message: string, close = false) => {
    send(c, { v: PROTOCOL_VERSION, type: 'error', code, message });
    if (close) c.ws.close(1008, code);
  };

  // ---------- fan-out ----------
  /** Sends a subscriber every committed event after its cursor. Serialized per subscription. */
  async function pump(c: Conn, projectId: string) {
    const sub = c.subs.get(projectId);
    if (!sub) return;
    if (sub.pumping) { sub.again = true; return; }
    sub.pumping = true;
    try {
      do {
        sub.again = false;
        for (;;) {
          const batch = await readEvents(o.pool, projectId, sub.cursor, REPLAY_BATCH);
          for (const e of batch) { send(c, toMessage(e)); sub.cursor = e.seq; }
          if (batch.length < REPLAY_BATCH) break;
        }
      } while (sub.again && !closing);
    } catch (e) {
      if (!closing) onError(e);
    } finally {
      sub.pumping = false;
    }
  }
  const pumpProject = (projectId: string) => { for (const c of conns) if (c.subs.has(projectId)) void pump(c, projectId); };
  const pumpAll = () => { for (const c of conns) for (const p of c.subs.keys()) void pump(c, p); };

  // ---------- the wake-up listener ----------
  async function connectListener() {
    const client = new pg.Client({
      connectionString: o.databaseUrl,
      application_name: `harness-listener${o.schema ? `:${o.schema}` : ''}`,
      ...(o.schema ? { options: `-c search_path=${o.schema}` } : {}),
    });
    const lost = new Promise<void>((resolve) => { client.on('error', () => resolve()); client.on('end', () => resolve()); });
    await client.connect();
    client.on('notification', (n) => { if (n.channel === EVENTS_CHANNEL && n.payload) pumpProject(n.payload); });
    await client.query(`LISTEN ${EVENTS_CHANNEL}`);
    pumpAll(); // anything committed while nobody was listening
    return { client, lost };
  }
  let listener = await connectListener();
  const listening = (async () => {
    while (!closing) {
      await listener.lost;
      await listener.client.end().catch(() => {});
      while (!closing) {
        try { listener = await connectListener(); break; } catch (e) { onError(e); await sleep(500); }
      }
    }
  })();
  const poll = setInterval(pumpAll, o.pollIntervalMs ?? 5000);
  const offlineAfterMs = o.offlineAfterMs ?? 30_000;
  const sweep = setInterval(() => { sweepOffline(o.pool, offlineAfterMs).catch((e) => { if (!closing) onError(e); }); }, Math.max(250, Math.min(5000, offlineAfterMs / 3)));
  let sweepingWaits = false; // one wait sweep at a time
  const waitSweep = setInterval(() => {
    if (sweepingWaits) return;
    sweepingWaits = true;
    sweepWaits(o.pool).catch((e) => { if (!closing) onError(e); }).finally(() => { sweepingWaits = false; });
  }, o.waitSweepMs ?? 1000);

  // ---------- connections ----------
  async function headsFor(principal: string, subs: Subscription[]): Promise<ProjectHead[]> {
    if (subs.length === 0) return [];
    const ids = subs.map((s) => s.project_id);
    const rows = (await o.pool.query<{ id: string; next_seq: string }>(
      `SELECT p.id, p.next_seq FROM projects p
       JOIN project_memberships m ON m.project_id = p.id AND m.human_id = $1 WHERE p.id = ANY($2)`, [principal, ids])).rows;
    const head = new Map(rows.map((r) => [r.id, Number(r.next_seq)]));
    const denied = ids.filter((id) => !head.has(id));
    if (denied.length) throw new CommandError('forbidden', `${principal} is not a member of ${denied.join(', ')}`);
    return ids.map((id) => ({ project_id: id, head_seq: head.get(id)! }));
  }
  function subscribe(c: Conn, subs: Subscription[]) {
    for (const s of subs) {
      if (!c.subs.has(s.project_id)) c.subs.set(s.project_id, { cursor: s.after_seq, pumping: false, again: false });
      void pump(c, s.project_id);
    }
  }

  async function hello(c: Conn, m: Record<string, unknown>) {
    if (!isHello(m)) return fail(c, 'bad_request', 'malformed hello', true);
    if (m.auth.scheme !== 'local-token' || !tokenMatches(m.auth.token, o.localToken)) return fail(c, 'unauthorized', 'bad token', true);
    if (!(await o.pool.query('SELECT 1 FROM human_principals WHERE id = $1', [m.principal])).rowCount) {
      return fail(c, 'unauthorized', `unknown principal ${m.principal}`, true);
    }
    if (m.device_id && !(await o.pool.query('SELECT 1 FROM devices WHERE id = $1 AND human_id = $2', [m.device_id, m.principal])).rowCount) {
      return fail(c, 'unauthorized', `${m.device_id} is not a device of ${m.principal}`, true);
    }
    const subs = m.subscribe ?? [];
    let projects: ProjectHead[];
    try { projects = await headsFor(m.principal, subs); } catch (e) {
      if (e instanceof CommandError) return fail(c, e.code, e.message, true);
      throw e;
    }
    c.principal = m.principal;
    c.deviceId = m.device_id ?? null;
    send(c, { v: PROTOCOL_VERSION, type: 'welcome', server_time: new Date().toISOString(), projects });
    subscribe(c, subs); // after welcome, so replayed events always follow it
  }

  async function handle(c: Conn, raw: string) {
    let m: unknown;
    try { m = JSON.parse(raw); } catch { return fail(c, 'bad_request', 'not JSON'); }
    if (!isObject(m)) return fail(c, 'bad_request', 'not a JSON object');
    if (m.v !== PROTOCOL_VERSION) return fail(c, 'unsupported_version', `this server speaks v${PROTOCOL_VERSION}`, true);
    if (!c.principal) {
      if (m.type !== 'hello') return fail(c, 'unauthorized', 'the first message must be hello', true);
      return hello(c, m);
    }
    if (m.type === 'subscribe') {
      if (!isSubscriptions(m.subscribe)) return fail(c, 'bad_request', 'malformed subscribe');
      try {
        send(c, { v: PROTOCOL_VERSION, type: 'subscribed', projects: await headsFor(c.principal, m.subscribe) });
      } catch (e) {
        if (e instanceof CommandError) return fail(c, e.code, e.message);
        throw e;
      }
      return subscribe(c, m.subscribe);
    }
    if (m.type === 'command') {
      if (!isCommand(m)) return fail(c, 'bad_request', 'malformed command');
      try {
        const out = await executeCommand(o.pool, { principal: c.principal, deviceId: c.deviceId }, m);
        send(c, { v: PROTOCOL_VERSION, type: 'command_result', command_id: m.command_id, ok: true, ...out });
      } catch (e) {
        if (!(e instanceof CommandError)) onError(e);
        const error = e instanceof CommandError ? { code: e.code, message: e.message } : { code: 'internal' as const, message: 'internal error' };
        send(c, { v: PROTOCOL_VERSION, type: 'command_result', command_id: m.command_id, ok: false, error });
      }
      return;
    }
    if (m.type === 'heartbeat') {
      if (!c.deviceId) return fail(c, 'bad_request', 'heartbeats come from harnessd, whose hello names its device');
      return heartbeat(o.pool, c.deviceId, c.principal, [...c.subs.keys()]);
    }
    if (m.type === 'hello') return fail(c, 'bad_request', 'already said hello');
    return fail(c, 'bad_request', `unknown message type ${String(m.type)}`);
  }

  const wss = new WebSocketServer({ host: o.host ?? '127.0.0.1', port: o.port ?? 7400, maxPayload: MAX_MESSAGE_BYTES });
  await new Promise<void>((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
  const handling = new Set<Promise<void>>(); // each connection's message chain, until it has run: close() waits for them
  wss.on('connection', (ws) => {
    const c: Conn = { ws, principal: null, deviceId: null, subs: new Map(), queue: Promise.resolve() };
    conns.add(c);
    const helloTimer = setTimeout(() => { if (!c.principal) fail(c, 'unauthorized', 'no hello', true); }, o.helloTimeoutMs ?? 10_000);
    // One message at a time per connection, in arrival order.
    ws.on('message', (data) => {
      const q = c.queue = c.queue.then(() => handle(c, data.toString())).catch((e) => { onError(e); fail(c, 'internal', 'internal error'); });
      handling.add(q);
      void q.finally(() => handling.delete(q));
    });
    ws.on('close', () => { clearTimeout(helloTimer); conns.delete(c); });
    ws.on('error', () => {});
  });

  const port = (wss.address() as { port: number }).port;
  return {
    url: `ws://${o.host ?? '127.0.0.1'}:${port}`,
    port,
    close: async () => {
      closing = true;
      clearInterval(poll);
      clearInterval(sweep);
      clearInterval(waitSweep);
      for (const c of conns) c.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      // Commands already received still run to the end (their replies go nowhere), so nothing uses the pool after
      // close() returns and the caller can end it.
      await Promise.allSettled([...handling]);
      await listener.client.end().catch(() => {});
      await listening;
    },
  };
}

function toMessage(e: StoredEvent): EventMessage {
  return {
    v: PROTOCOL_VERSION, type: 'event', project_id: e.projectId, seq: e.seq, at: e.at.toISOString(),
    actor: { principal: e.actor, on_behalf_of: e.onBehalfOf, device_id: e.deviceId }, kind: e.kind, data: e.data,
  };
}

function tokenMatches(given: string, expected: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

// ---------- shape checks for untrusted input ----------
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200;
function isSubscriptions(x: unknown): x is Subscription[] {
  return Array.isArray(x) && x.length <= 100 && x.every((s) => isObject(s) && isString(s.project_id) && Number.isSafeInteger(s.after_seq) && (s.after_seq as number) >= 0);
}
function isHello(m: Record<string, unknown>): m is Hello {
  return isObject(m.client) && ['harnessd', 'cli', 'dashboard'].includes(m.client.kind as string) && isString(m.client.version)
    && isString(m.principal) && (m.device_id === undefined || isString(m.device_id))
    && isObject(m.auth) && m.auth.scheme === 'local-token' && typeof m.auth.token === 'string'
    && (m.subscribe === undefined || isSubscriptions(m.subscribe));
}
function isCommand(m: Record<string, unknown>): m is Command {
  return isString(m.command_id) && isString(m.project_id) && isString(m.name) && isObject(m.args) && (m.as_agent === undefined || isString(m.as_agent));
}
