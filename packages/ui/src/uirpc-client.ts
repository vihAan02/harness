// The UI bridge's client for harnessd's local socket (D-117; protocol.md §12). Newline-delimited JSON over a Unix
// socket: { id, token, method, params } → { id, ok, result | error }. The token is re-read for every connection,
// because harnessd writes a new one at each start (§12, "harnessd restarts").
//
// Two kinds of connection, both through the `connect` seam so tests can use an in-memory Duplex:
// - calls share one lazily-opened connection, reopened by the next call after it closes;
// - a stream opens its own connection and reconnects with backoff when it drops.
// Nothing here logs or returns the token.
import type { Duplex } from 'node:stream';

export class UirpcError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null };

export type StreamMessage = { project_id: string; seq: number; snapshot: unknown };

/** A line this long without a newline is a broken peer; the connection is destroyed. */
const MAX_LINE = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_BACKOFF_MS = [1000, 2000, 5000, 10000];

export class UirpcClient {
  connect: () => Duplex;
  token: () => string;
  timeoutMs: number;
  backoffMs: number[];

  private conn: Duplex | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed = false;

  constructor(o: { connect: () => Duplex; token: () => string; timeoutMs?: number; backoffMs?: number[] }) {
    this.connect = o.connect;
    this.token = o.token;
    this.timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.backoffMs = o.backoffMs ?? DEFAULT_BACKOFF_MS;
  }

  /** The shared call connection, opened lazily and reopened by the next call after it closes. */
  private dial(): Duplex {
    const c = this.connect();
    this.conn = c;
    this.buf = '';
    c.setEncoding('utf8');
    c.on('data', (chunk: string | Buffer) => this.onData(c, String(chunk)));
    const down = () => this.onClose(c);
    c.on('close', down);
    c.on('error', down);
    c.on('end', down);
    return c;
  }

  private onData(c: Duplex, chunk: string): void {
    if (c !== this.conn) return;
    this.buf += chunk;
    if (!this.buf.includes('\n') && this.buf.length > MAX_LINE) return void c.destroy();
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.trim()) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let m: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
    try { m = JSON.parse(line) as typeof m; } catch { return; }
    if (m === null || typeof m !== 'object' || Array.isArray(m)) return;
    const id = typeof m.id === 'number' ? m.id : Number(m.id);
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (p.timer) clearTimeout(p.timer);
    if (m.ok === true) return void p.resolve(m.result);
    const code = typeof m.error?.code === 'string' ? m.error.code : 'internal';
    const message = typeof m.error?.message === 'string' ? m.error.message : 'uirpc error';
    p.reject(new UirpcError(code, message));
  }

  /** An error or close rejects every pending call: nothing can answer them any more. */
  private onClose(c: Duplex): void {
    if (c !== this.conn) return;
    this.conn = null;
    this.buf = '';
    this.failPending('unavailable', 'harnessd is not answering');
  }

  private failPending(code: string, message: string): void {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const p of pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new UirpcError(code, message));
    }
  }

  call(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(new UirpcError('unavailable', 'the client is closed'));
    const c = this.conn ?? this.dial();
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new UirpcError('timeout', `no answer to ${method} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      // A write on a destroyed socket throws: treat it as the connection being down.
      try {
        c.write(`${JSON.stringify({ id, token: this.token(), method, params: params ?? {} })}\n`);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new UirpcError('unavailable', 'harnessd is not answering'));
      }
    });
  }

  /**
   * Opens its own connection and subscribes to `events`. onState('up') follows the {ok:true} reply; a drop is
   * onState('down') once, then a reconnect after backoffMs[min(attempt, last)]. A connection that fails or closes
   * before any 'up' also reports 'down' once — so a stream that never reaches harnessd still says so — and 'down' is
   * not repeated until the next 'up'. An 'up' resets the attempt count. The returned function stops the stream for good.
   */
  stream(onMessage: (m: StreamMessage) => void, onState: (s: 'up' | 'down') => void): () => void {
    let stopped = false;
    let up = false;
    let reportedDown = false;
    let attempt = 0;
    let c: Duplex | null = null;
    let buf = '';
    let timer: NodeJS.Timeout | null = null;

    /** One 'down' per drop, including a drop before any 'up'; not again until the next 'up'. */
    const reportDown = () => {
      if (stopped || reportedDown) return;
      reportedDown = true;
      up = false;
      onState('down');
    };

    const open = () => {
      if (stopped) return;
      buf = '';
      let conn: Duplex;
      try { conn = this.connect(); } catch { reportDown(); return void schedule(); }
      c = conn;
      conn.setEncoding('utf8');
      conn.on('data', (chunk: string | Buffer) => {
        if (conn !== c) return;
        buf += String(chunk);
        if (!buf.includes('\n') && buf.length > MAX_LINE) return void conn.destroy();
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          if (line.trim() && conn === c && !stopped) onStreamLine(line);
        }
      });
      const down = () => {
        if (conn !== c) return;
        c = null;
        if (stopped) return;
        reportDown();
        schedule();
      };
      conn.on('close', down);
      conn.on('error', down);
      conn.on('end', down);
      const id = this.nextId++;
      try {
        conn.write(`${JSON.stringify({ id, token: this.token(), method: 'events', params: {} })}\n`);
      } catch { down(); }
    };

    const schedule = () => {
      if (stopped || timer) return;
      const delay = this.backoffMs[Math.min(attempt, this.backoffMs.length - 1)] ?? 1000;
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        open();
      }, delay);
    };

    const onStreamLine = (line: string): void => {
      let m: { ok?: unknown; error?: { message?: unknown }; stream?: unknown; project_id?: unknown; seq?: unknown; snapshot_patch?: { op?: unknown; value?: unknown } };
      try { m = JSON.parse(line) as typeof m; } catch { return; }
      if (m === null || typeof m !== 'object' || Array.isArray(m)) return;
      if (m.stream !== undefined) {
        // { stream, project_id, seq, snapshot_patch: { op: 'replace', value } } — one project's new snapshot.
        if (m.snapshot_patch?.op !== 'replace') return;
        onMessage({ project_id: String(m.project_id), seq: Number(m.seq), snapshot: m.snapshot_patch.value });
        return;
      }
      if (m.ok === true) {
        const wasDown = !up;
        up = true;
        reportedDown = false;
        attempt = 0;
        if (wasDown) onState('up');
        return;
      }
      // A refusal of the subscribe itself: the connection will close, which reports the drop.
    };

    open();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      const conn = c;
      c = null;
      if (conn) conn.destroy();
    };
  }

  close(): void {
    this.closed = true;
    const c = this.conn;
    this.conn = null;
    if (c) c.destroy();
    this.failPending('unavailable', 'the client is closed');
  }
}
