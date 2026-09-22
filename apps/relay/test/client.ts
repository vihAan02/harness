import { SELF } from "cloudflare:test";
import type { ServerMsg } from "@mp/protocol";

export const BASE = "https://relay.test";

export async function createRoom(): Promise<{ roomId: string; secret: string }> {
  const res = await SELF.fetch(`${BASE}/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repo: "github.com/acme/app" }),
  });
  if (res.status !== 201) throw new Error(`create room failed: ${res.status}`);
  return res.json();
}

type Pred = (m: ServerMsg) => boolean;

/** A minimal relay client for tests: an inbox you can take matching messages from. */
export class TestClient {
  readonly inbox: ServerMsg[] = [];
  /** Every message in arrival order, including ones already taken. */
  readonly log: ServerMsg[] = [];
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: Pred; resolve: (m: ServerMsg) => void }[] = [];
  private req = 0;
  private readonly ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(e.data as string) as ServerMsg;
      this.log.push(msg);
      const i = this.waiters.findIndex((w) => w.pred(msg));
      if (i >= 0) this.waiters.splice(i, 1)[0]!.resolve(msg);
      else this.inbox.push(msg);
    });
    ws.addEventListener("close", (e) => {
      this.closed = { code: e.code, reason: e.reason };
    });
  }

  static async connect(roomId: string): Promise<TestClient> {
    const res = await SELF.fetch(`${BASE}/rooms/${roomId}/ws`, { headers: { Upgrade: "websocket" } });
    if (res.status !== 101 || !res.webSocket) throw new Error(`upgrade failed: ${res.status}`);
    res.webSocket.accept();
    return new TestClient(res.webSocket);
  }

  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    this.ws.close(1000, "bye");
  }

  /** Resolves with (and removes) the first message matching `pred`, waiting if needed. */
  take(pred: Pred, timeoutMs = 3000): Promise<ServerMsg> {
    const i = this.inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]!);
    return new Promise((resolve, reject) => {
      const waiter = { pred, resolve: (m: ServerMsg) => (clearTimeout(timer), resolve(m)) };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for message; inbox: ${JSON.stringify(this.inbox).slice(0, 800)}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  event<T extends string>(type: T, timeoutMs?: number) {
    return this.take((m) => m.t === "event" && m.event.type === type, timeoutMs) as Promise<
      Extract<ServerMsg, { t: "event" }>
    >;
  }

  async hello(secret: string, member: { id: string; name: string }, lastSeq?: number) {
    this.send({ op: "hello", secret, member, deviceId: `${member.id}-laptop`, ...(lastSeq !== undefined ? { lastSeq } : {}) });
    return (await this.take((m) => m.t === "welcome" || m.t === "error")) as Extract<ServerMsg, { t: "welcome" | "error" }>;
  }

  async op(input: Record<string, unknown>) {
    const reqId = `q${++this.req}`;
    this.send({ ...input, reqId });
    return (await this.take((m) => m.t === "ack" && m.reqId === reqId)) as Extract<ServerMsg, { t: "ack" }>;
  }

  async ok(input: Record<string, unknown>) {
    const ack = await this.op(input);
    if (!ack.ok) throw new Error(`${String(input.op)} failed: ${JSON.stringify(ack.error)}`);
    return ack.result;
  }
}

export async function joined(roomId: string, secret: string, member: { id: string; name: string }) {
  const client = await TestClient.connect(roomId);
  const welcome = await client.hello(secret, member);
  if (welcome.t !== "welcome") throw new Error(`hello failed: ${JSON.stringify(welcome)}`);
  return { client, welcome };
}
