import { DurableObject } from "cloudflare:workers";
import { ClientOp, Hello, type AgentEvent, type OpError, type RoomEvent, type ServerMsg } from "@mp/protocol";
import { RoomEngine, type ApplyResult } from "@mp/room";
import { engineOptionsFromEnv, type Env } from "./env.ts";
import { secretMatches } from "./secrets.ts";
import { RoomStore, type RoomMeta } from "./store.ts";

/** Per-socket state that survives hibernation. */
type Attachment =
  | { authed: false; connectedAt: number }
  | { authed: true; memberId: string; deviceId: string; connectedAt: number };

const MAX_MESSAGE_BYTES = 1_000_000;
const HELLO_TIMEOUT_MS = 10_000;
const STREAM_TAIL = 50;
/** Token bucket per socket: sustained ops/sec and burst. */
const RATE_PER_SEC = 50;
const RATE_BURST = 200;

/**
 * One Durable Object per room. It runs the RoomEngine authoritatively, persists every change to
 * SQLite, and fans events out over hibernatable WebSockets.
 */
export class RoomDO extends DurableObject<Env> {
  private readonly store: RoomStore;
  private meta: RoomMeta | null = null;
  private engine: RoomEngine | null = null;
  private readonly buckets = new WeakMap<WebSocket, { tokens: number; at: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new RoomStore(ctx.storage);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    void ctx.blockConcurrencyWhile(async () => {
      this.store.migrate();
      this.meta = this.store.getMeta();
      if (this.meta) {
        this.engine = RoomEngine.fromSnapshot(this.store.load(this.meta.roomId), engineOptionsFromEnv(env));
      }
    });
  }

  /** RPC from the Worker when a room is created. */
  async init(roomId: string, secretHash: string, repo?: string): Promise<void> {
    if (this.meta) throw new Error("room already exists");
    const meta: RoomMeta = { roomId, secretHash, createdAt: Date.now(), ...(repo ? { repo } : {}) };
    this.store.init(meta);
    this.meta = meta;
    this.engine = new RoomEngine(roomId, engineOptionsFromEnv(this.env));
  }

  override async fetch(request: Request): Promise<Response> {
    if (!this.meta || !this.engine) return new Response("room not found", { status: 404 });
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected a WebSocket upgrade", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ authed: false, connectedAt: Date.now() } satisfies Attachment);
    await this.scheduleAlarm(Date.now() + HELLO_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return this.reject(ws, { code: "bad_request", message: "binary frames are not supported" });
    if (raw.length > MAX_MESSAGE_BYTES) return this.reject(ws, { code: "bad_request", message: "message too large" });

    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return this.reject(ws, { code: "bad_request", message: "invalid JSON" });
    }

    const att = ws.deserializeAttachment() as Attachment;
    if (!att.authed) return this.handleHello(ws, data);

    const reqId = typeof (data as { reqId?: unknown })?.reqId === "string" ? (data as { reqId: string }).reqId : "";
    if (!this.takeToken(ws)) {
      return this.send(ws, { t: "ack", reqId, ok: false, error: { code: "rate_limited", message: "slow down" } });
    }
    const parsed = ClientOp.safeParse(data);
    if (!parsed.success) {
      const message = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500);
      return this.send(ws, { t: "ack", reqId, ok: false, error: { code: "bad_request", message } });
    }

    const engine = this.engine!;
    let result: ApplyResult;
    try {
      result = engine.apply({ memberId: att.memberId, now: Date.now() }, parsed.data);
    } catch (err) {
      console.error("engine failure", parsed.data.op, err);
      return this.send(ws, { t: "ack", reqId, ok: false, error: { code: "internal", message: "internal error" } });
    }

    if (!result.ok) {
      return this.send(ws, { t: "ack", reqId, ok: false, error: result.error! });
    }
    this.store.save(result, engine.state.seq);
    // Events before the ack: a client's mirror always includes its own write by the time the write
    // resolves (read-your-writes). WebSocket frames on one socket are delivered in order.
    this.broadcast(result.events);
    if (result.stream) this.broadcastStream(result.stream.agentId, result.stream.events, ws);
    this.send(ws, { t: "ack", reqId, ok: true, ...(result.result !== undefined ? { result: result.result } : {}) });
    await this.scheduleFromEngine();
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    this.onGone(ws);
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.onGone(ws);
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    // Drop sockets that never said hello.
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att && !att.authed && now - att.connectedAt > HELLO_TIMEOUT_MS) {
        ws.close(1008, "hello timeout");
      }
    }
    if (this.engine) {
      const result = this.engine.tick(now);
      this.store.save(result, this.engine.state.seq);
      this.broadcast(result.events);
    }
    await this.scheduleFromEngine();
  }

  // ------------------------------------------------------------------ internals

  private async handleHello(ws: WebSocket, data: unknown): Promise<void> {
    const parsed = Hello.safeParse(data);
    if (!parsed.success) return this.reject(ws, { code: "unauthorized", message: "first message must be hello" }, true);
    const hello = parsed.data;
    if (!(await secretMatches(hello.secret, this.meta!.secretHash))) {
      return this.reject(ws, { code: "unauthorized", message: "bad room secret" }, true);
    }

    const engine = this.engine!;
    const connectedAt = (ws.deserializeAttachment() as Attachment).connectedAt;
    ws.serializeAttachment({
      authed: true,
      memberId: hello.member.id,
      deviceId: hello.deviceId,
      connectedAt,
    } satisfies Attachment);

    const connected = engine.connect(hello.member, Date.now());
    this.store.save(connected, engine.state.seq);

    const replay = hello.lastSeq !== undefined ? this.store.eventsAfter(hello.lastSeq, engine.state.seq) : null;
    if (replay) {
      const snap = engine.state.streams;
      const streamTails: Record<string, AgentEvent[]> = {};
      for (const [agentId, events] of snap) streamTails[agentId] = events.slice(-STREAM_TAIL);
      this.send(ws, {
        t: "welcome",
        roomId: this.meta!.roomId,
        memberId: hello.member.id,
        seq: engine.state.seq,
        mode: "replay",
        events: replay,
        streamTails,
      });
    } else {
      this.send(ws, {
        t: "welcome",
        roomId: this.meta!.roomId,
        memberId: hello.member.id,
        seq: engine.state.seq,
        mode: "snapshot",
        snapshot: engine.snapshot(),
      });
    }
    // The newcomer already has these events via the welcome.
    this.broadcast(connected.events, ws);
  }

  private onGone(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.authed || !this.engine) return;
    const stillHere = this.ctx.getWebSockets().some((other) => {
      if (other === ws || other.readyState !== WebSocket.OPEN) return false;
      const a = other.deserializeAttachment() as Attachment | null;
      return a?.authed === true && a.memberId === att.memberId;
    });
    if (stillHere) return;
    const result = this.engine.disconnect(att.memberId, Date.now());
    this.store.save(result, this.engine.state.seq);
    this.broadcast(result.events, ws);
  }

  private authedSockets(except?: WebSocket): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      if (ws === except || ws.readyState !== WebSocket.OPEN) return false;
      return (ws.deserializeAttachment() as Attachment | null)?.authed === true;
    });
  }

  private broadcast(events: RoomEvent[], except?: WebSocket): void {
    if (!events.length) return;
    const sockets = this.authedSockets(except);
    for (const event of events) {
      const frame = JSON.stringify({ t: "event", event } satisfies ServerMsg);
      for (const ws of sockets) this.sendRaw(ws, frame);
    }
  }

  private broadcastStream(agentId: string, events: AgentEvent[], except: WebSocket): void {
    const frame = JSON.stringify({ t: "stream", agentId, events } satisfies ServerMsg);
    for (const ws of this.authedSockets(except)) this.sendRaw(ws, frame);
  }

  private send(ws: WebSocket, msg: ServerMsg): void {
    this.sendRaw(ws, JSON.stringify(msg));
  }

  private sendRaw(ws: WebSocket, frame: string): void {
    try {
      ws.send(frame);
    } catch {
      // The socket is closing; its close handler will clean up.
    }
  }

  private reject(ws: WebSocket, error: OpError, close = false): void {
    this.send(ws, { t: "error", error });
    if (close) ws.close(1008, error.message.slice(0, 120));
  }

  private takeToken(ws: WebSocket): boolean {
    const now = Date.now();
    const b = this.buckets.get(ws) ?? { tokens: RATE_BURST, at: now };
    b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) / 1000) * RATE_PER_SEC);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(ws, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(ws, b);
    return true;
  }

  private async scheduleFromEngine(): Promise<void> {
    const deadline = this.engine?.nextDeadline();
    if (deadline !== null && deadline !== undefined) await this.scheduleAlarm(deadline);
  }

  /** Keeps the earliest pending alarm. */
  private async scheduleAlarm(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || at < current) await this.ctx.storage.setAlarm(Math.max(at, Date.now()));
  }
}
