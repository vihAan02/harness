// harnessd's connection to the coordination server (docs/protocol.md §2 to §4).
// - Reconnects with backoff. On its first connection it replays each project's log from the start, so
//   harnessd can rebuild its view of the project; events at or before the saved cursor are passed on
//   marked `replayed`, so they're folded into the view but never acted on twice (D-78). Later
//   reconnects resume from the last event seen.
// - Commands wait in an outbox until the server answers. After a reconnect they are resent with the
//   same command_id, which is safe because commands are idempotent (D-74).
// - Sends a heartbeat while connected (D-75).
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION, type Command, type EventMessage, type ServerMessage } from '@harness/protocol';

export type LinkOptions = {
  url: string; token: string; principal: string; deviceId: string;
  cursors: Record<string, number>; // project id → last seq acted on; every key is subscribed
  onEvent: (e: EventMessage, replayed: boolean) => void;
  onCursor?: (projectId: string, seq: number) => void;
  heartbeatMs?: number; // default 10000
  log?: (msg: string) => void;
};
type Pending = { msg: Command; resolve: (v: { seqs: number[]; result: unknown }) => void; reject: (e: Error) => void };

export class CommandFailed extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

export class ServerLink {
  o: LinkOptions;
  cursors: Record<string, number>;
  seen: Record<string, number>; // last seq passed to onEvent in this process, replayed or not
  ws: WebSocket | null = null;
  ready = false;
  stopped = false;
  fatal: string | null = null;
  pending = new Map<string, Pending>();
  readyWaiters: (() => void)[] = [];
  heads: Record<string, number> | null = null; // each project's head at the first welcome
  caughtUpWaiters: (() => void)[] = [];
  running: Promise<void> | null = null;

  constructor(o: LinkOptions) {
    this.o = o;
    this.cursors = { ...o.cursors };
    this.seen = Object.fromEntries(Object.keys(o.cursors).map((p) => [p, 0]));
  }

  start(): void {
    this.running ??= this.run();
  }

  /** Resolves once the server has welcomed us. */
  whenReady(): Promise<void> {
    return this.ready ? Promise.resolve() : new Promise((r) => this.readyWaiters.push(r));
  }

  /** Resolves once every project's log has been replayed up to where it stood when we first connected. */
  whenCaughtUp(): Promise<void> {
    return this.isCaughtUp() ? Promise.resolve() : new Promise((r) => this.caughtUpWaiters.push(r));
  }

  isCaughtUp(): boolean {
    return this.heads !== null && Object.entries(this.heads).every(([p, h]) => (this.seen[p] ?? 0) >= h);
  }

  checkCaughtUp(): void {
    if (this.isCaughtUp()) for (const w of this.caughtUpWaiters.splice(0)) w();
  }

  /** Sends a command; `asAgent` sends it for one of this human's agents (D-18). */
  command(projectId: string, name: string, args: Record<string, unknown>, asAgent?: string): Promise<{ seqs: number[]; result: unknown }> {
    if (this.stopped) return Promise.reject(new Error('link stopped'));
    const msg: Command = {
      v: PROTOCOL_VERSION, type: 'command', command_id: randomUUID(), project_id: projectId, name, args, ...(asAgent ? { as_agent: asAgent } : {}),
    };
    return new Promise((resolve, reject) => {
      this.pending.set(msg.command_id, { msg, resolve, reject });
      if (this.ready) this.ws?.send(JSON.stringify(msg));
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.ws?.close();
    for (const p of this.pending.values()) p.reject(new Error('link stopped'));
    this.pending.clear();
    await this.running;
  }

  async run(): Promise<void> {
    let backoff = 250;
    while (!this.stopped && !this.fatal) {
      const welcomed = await this.session();
      if (this.stopped || this.fatal) break;
      backoff = welcomed ? 250 : Math.min(backoff * 2, 10_000);
      await new Promise((r) => setTimeout(r, backoff));
    }
    if (this.fatal) this.o.log?.(`server refused this daemon (${this.fatal}); not reconnecting`);
  }

  /** One connection, until it closes. Returns whether the server welcomed us. */
  session(): Promise<boolean> {
    return new Promise((resolve) => {
      let welcomed = false;
      let beat: NodeJS.Timeout | undefined;
      const ws = new WebSocket(this.o.url);
      this.ws = ws;
      const send = (m: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m)); };
      ws.addEventListener('open', () => send({
        v: PROTOCOL_VERSION, type: 'hello', client: { kind: 'harnessd', version: '0.0.0' },
        principal: this.o.principal, device_id: this.o.deviceId, auth: { scheme: 'local-token', token: this.o.token },
        subscribe: Object.entries(this.seen).map(([project_id, after_seq]) => ({ project_id, after_seq })),
      }));
      ws.addEventListener('message', (ev) => {
        let m: ServerMessage;
        try { m = JSON.parse(String(ev.data)) as ServerMessage; } catch { return; }
        if (m.type === 'welcome') {
          welcomed = true;
          this.ready = true;
          this.heads ??= Object.fromEntries(m.projects.map((p) => [p.project_id, p.head_seq]));
          for (const p of this.pending.values()) send(p.msg); // resend: idempotent on command_id
          send({ v: PROTOCOL_VERSION, type: 'heartbeat' });
          beat = setInterval(() => send({ v: PROTOCOL_VERSION, type: 'heartbeat' }), this.o.heartbeatMs ?? 10_000);
          for (const w of this.readyWaiters.splice(0)) w();
          this.checkCaughtUp();
        } else if (m.type === 'event') {
          if (m.seq <= (this.seen[m.project_id] ?? 0)) return; // at-least-once: drop duplicates
          this.seen[m.project_id] = m.seq;
          const replayed = m.seq <= (this.cursors[m.project_id] ?? 0);
          this.o.onEvent(m, replayed);
          if (!replayed) {
            this.cursors[m.project_id] = m.seq;
            this.o.onCursor?.(m.project_id, m.seq);
          }
          this.checkCaughtUp();
        } else if (m.type === 'command_result') {
          const p = this.pending.get(m.command_id);
          if (!p) return;
          this.pending.delete(m.command_id);
          if (m.ok) p.resolve({ seqs: m.seqs, result: m.result });
          else p.reject(new CommandFailed(m.error.code, m.error.message));
        } else if (m.type === 'error') {
          this.o.log?.(`server error: ${m.code}: ${m.message}`);
          if (m.code === 'unauthorized' || m.code === 'unsupported_version' || m.code === 'forbidden') this.fatal = m.code;
        }
      });
      ws.addEventListener('close', () => {
        clearInterval(beat);
        this.ready = false;
        this.ws = null;
        resolve(welcomed);
      });
      ws.addEventListener('error', () => {}); // a close always follows
    });
  }
}
