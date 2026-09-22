import { createServer, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { AppServerHandle, StartAppServer } from "../src/index.ts";

interface Received {
  method: string;
  params?: any;
  id?: number | string;
}

/**
 * An in-process stand-in for `codex app-server --listen ws://… --ws-auth capability-token`,
 * implementing the slice of the v2 protocol mp-daemon uses (see the Codex app-server docs).
 */
export class FakeAppServer {
  readonly received: Received[] = [];
  readonly responses: Received[] = [];
  loadedThreads: string[] = [];
  activeTurn: string | null = null;
  lastStartSpec: Parameters<StartAppServer>[0] | null = null;
  private http!: Server;
  private wss!: WebSocketServer;
  private readonly subscribers = new Set<WebSocket>();
  private turnCounter = 0;
  private reqCounter = 1000;

  static starter(fakes: FakeAppServer[]): StartAppServer {
    return async (spec) => {
      const fake = new FakeAppServer();
      fake.lastStartSpec = spec;
      fakes.push(fake);
      return fake.listen(spec.port, spec.token);
    };
  }

  async listen(port: number, token: string): Promise<AppServerHandle> {
    this.http = createServer((req, res) => {
      res.writeHead(req.url === "/readyz" ? 200 : 404);
      res.end();
    });
    this.wss = new WebSocketServer({
      noServer: true,
    });
    this.http.on("upgrade", (req, socket, head) => {
      if (req.headers.authorization !== `Bearer ${token}`) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    await new Promise<void>((r) => this.http.listen(port, "127.0.0.1", r));
    let resolveExit!: () => void;
    const exited = new Promise<void>((r) => (resolveExit = r));
    return {
      stop: () => {
        for (const c of this.wss.clients) c.terminate();
        this.wss.close();
        this.http.close(() => resolveExit());
      },
      exited,
    };
  }

  private onConnection(ws: WebSocket): void {
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Received & { result?: unknown };
      if (msg.method === undefined) {
        this.responses.push(msg);
        return;
      }
      this.received.push(msg);
      if (msg.id === undefined) return; // notification (initialized)
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result }));
      const fail = (message: string) => ws.send(JSON.stringify({ id: msg.id, error: { code: -32600, message } }));
      switch (msg.method) {
        case "initialize":
          return reply({ userAgent: "fake-codex/0.0.0", platformFamily: "unix", platformOs: "macos" });
        case "thread/loaded/list":
          return reply({ data: this.loadedThreads, nextCursor: null });
        case "thread/resume":
          this.subscribers.add(ws);
          return reply({ thread: { id: msg.params.threadId, sessionId: msg.params.threadId } });
        case "turn/steer":
          if (this.activeTurn !== msg.params.expectedTurnId) return fail("no matching active turn");
          return reply({ turnId: this.activeTurn });
        case "turn/start": {
          const id = this.beginTurn(msg.params.threadId);
          return reply({ turn: { id, items: [], status: "inProgress", error: null } });
        }
        default:
          return fail(`unexpected ${msg.method}`);
      }
    });
  }

  emit(method: string, params: unknown): void {
    for (const ws of this.subscribers) ws.send(JSON.stringify({ method, params }));
  }

  /** A server→client request, e.g. an approval. */
  request(method: string, params: unknown): number {
    const id = ++this.reqCounter;
    for (const ws of this.subscribers) ws.send(JSON.stringify({ id, method, params }));
    return id;
  }

  /** Simulates the terminal UI (or anyone) starting a turn. */
  beginTurn(threadId: string): string {
    const id = `turn_${++this.turnCounter}`;
    this.activeTurn = id;
    this.emit("turn/started", { threadId, turn: { id, items: [], status: "inProgress", error: null } });
    return id;
  }

  completeTurn(threadId: string): void {
    const id = this.activeTurn;
    this.activeTurn = null;
    this.emit("turn/completed", { threadId, turn: { id, items: [], status: "completed", error: null } });
  }

  sent(method: string): Received[] {
    return this.received.filter((r) => r.method === method);
  }
}
