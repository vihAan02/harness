import type { ServerMsg } from "@mp/protocol";
import { RoomMirror, SeqGapError } from "@mp/room";
import { Emitter, OfflineError, OpFailedError, type LinkEvents, type OpRequest, type RoomLink } from "./link.ts";

export interface RelayClientOptions {
  relayUrl: string;
  roomId: string;
  secret: string;
  member: { id: string; name: string };
  deviceId: string;
  requestTimeoutMs?: number;
  pingMs?: number;
  /** Reconnect backoff bounds. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  WebSocketImpl?: typeof WebSocket;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function wsUrlFor(relayUrl: string, roomId: string): string {
  const u = new URL(relayUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/rooms/${roomId}/ws`;
  u.hash = "";
  u.search = "";
  return u.toString();
}

/**
 * One WebSocket to one room. Keeps `mirror` current, reconnects with jittered backoff, and resumes
 * with `lastSeq` so a reconnect replays only what was missed.
 */
export class RelayClient implements RoomLink {
  readonly roomId: string;
  readonly mirror: RoomMirror;
  private readonly opts: Required<Omit<RelayClientOptions, "WebSocketImpl">> & { WebSocketImpl: typeof WebSocket };
  private readonly emitter = new Emitter();
  private ws: WebSocket | null = null;
  private isConnected = false;
  private stopped = false;
  private attempt = 0;
  private reqCounter = 0;
  private readonly pending = new Map<string, Pending>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Set when we must discard the mirror and ask for a full snapshot. */
  private needSnapshot = false;

  constructor(opts: RelayClientOptions) {
    this.roomId = opts.roomId;
    this.mirror = new RoomMirror(opts.roomId);
    this.opts = {
      requestTimeoutMs: 10_000,
      pingMs: 25_000,
      minBackoffMs: 500,
      maxBackoffMs: 30_000,
      WebSocketImpl: globalThis.WebSocket,
      ...opts,
    } as RelayClient["opts"];
  }

  get connected(): boolean {
    return this.isConnected;
  }

  on<K extends keyof LinkEvents>(event: K, fn: LinkEvents[K]): () => void {
    return this.emitter.on(event, fn);
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardown("closed");
    this.ws?.close(1000, "bye");
    this.ws = null;
  }

  request(op: OpRequest): Promise<unknown> {
    const ws = this.ws;
    if (!this.isConnected || !ws) return Promise.reject(new OfflineError());
    const reqId = `r${++this.reqCounter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new OfflineError(`relay did not answer ${op.op} within ${this.opts.requestTimeoutMs}ms`));
      }, this.opts.requestTimeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ ...op, reqId }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new OfflineError(String(err)));
      }
    });
  }

  // ------------------------------------------------------------------ internals

  private open(): void {
    if (this.stopped) return;
    let ws: WebSocket;
    try {
      ws = new this.opts.WebSocketImpl(wsUrlFor(this.opts.relayUrl, this.roomId));
    } catch (err) {
      console.error(`[mp] could not open relay socket for ${this.roomId}`, err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      const resume = !this.needSnapshot && this.mirror.seq > 0;
      ws.send(
        JSON.stringify({
          op: "hello",
          secret: this.opts.secret,
          member: this.opts.member,
          deviceId: this.opts.deviceId,
          ...(resume ? { lastSeq: this.mirror.seq } : {}),
        }),
      );
    });
    ws.addEventListener("message", (e) => this.onMessage(ws, e.data));
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.teardown("disconnected");
      this.scheduleReconnect();
    });
    ws.addEventListener("error", () => {
      // A close event always follows; reconnect happens there.
    });
  }

  private onMessage(ws: WebSocket, data: unknown): void {
    if (typeof data !== "string" || data === "pong") return;
    let msg: ServerMsg;
    try {
      msg = JSON.parse(data) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.t) {
      case "welcome":
        try {
          if (msg.mode === "snapshot" && msg.snapshot) {
            this.mirror.reset(msg.snapshot);
          } else {
            for (const e of msg.events ?? []) this.mirror.apply(e);
            for (const [agentId, events] of Object.entries(msg.streamTails ?? {})) {
              this.mirror.state.streams.set(agentId, [...events]);
            }
          }
        } catch (err) {
          if (err instanceof SeqGapError) return this.resync(ws);
          throw err;
        }
        this.needSnapshot = false;
        this.attempt = 0;
        this.isConnected = true;
        this.startPing(ws);
        if (msg.mode === "replay") for (const e of msg.events ?? []) this.emitter.emit("event", e);
        this.emitter.emit("status", true);
        return;
      case "event":
        try {
          this.mirror.apply(msg.event);
        } catch (err) {
          if (err instanceof SeqGapError) return this.resync(ws);
          throw err;
        }
        this.emitter.emit("event", msg.event);
        return;
      case "stream":
        this.mirror.applyStream(msg.agentId, msg.events);
        this.emitter.emit("stream", msg.agentId, msg.events);
        return;
      case "ack": {
        const p = this.pending.get(msg.reqId);
        if (!p) return;
        this.pending.delete(msg.reqId);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new OpFailedError(msg.error.code, msg.error.message));
        return;
      }
      case "error":
        if (!this.isConnected && msg.error.code === "unauthorized") {
          this.stopped = true;
          this.emitter.emit("fatal", msg.error.message);
        }
        return;
    }
  }

  /** We missed events: drop this socket and come back asking for a snapshot. */
  private resync(ws: WebSocket): void {
    this.needSnapshot = true;
    ws.close(4000, "resync");
  }

  private startPing(ws: WebSocket): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      try {
        ws.send("ping");
      } catch {
        // close handler will reconnect
      }
    }, this.opts.pingMs);
    (this.pingTimer as { unref?: () => void }).unref?.();
  }

  private teardown(reason: string): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    const was = this.isConnected;
    this.isConnected = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new OfflineError(`connection ${reason}`));
      this.pending.delete(id);
    }
    if (was) this.emitter.emit("status", false);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const base = Math.min(this.opts.maxBackoffMs, this.opts.minBackoffMs * 2 ** this.attempt++);
    const delay = base / 2 + Math.random() * (base / 2);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }
}
