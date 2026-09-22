import WebSocket from "ws";

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcServerRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

export class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Handlers = {
  notification: (n: RpcNotification) => void;
  request: (r: RpcServerRequest) => void;
  close: () => void;
};

/**
 * A JSON-RPC client for `codex app-server` over WebSocket (JSON-RPC 2.0 with the "jsonrpc" field
 * omitted on the wire). mp-daemon is an *observer* client: it never answers approval requests, which
 * stay with the person in the Codex terminal UI.
 */
export class AppServerClient {
  private readonly url: string;
  private readonly token: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly handlers: { [K in keyof Handlers]: Set<Handlers[K]> } = {
    notification: new Set(),
    request: new Set(),
    close: new Set(),
  };

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  on<K extends keyof Handlers>(event: K, fn: Handlers[K]): () => void {
    (this.handlers[event] as Set<Handlers[K]>).add(fn);
    return () => (this.handlers[event] as Set<Handlers[K]>).delete(fn);
  }

  async connect(): Promise<void> {
    const ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.token}` } });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.on("message", (data) => this.onMessage(String(data)));
    ws.on("close", () => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new RpcError(-32000, "connection closed"));
        this.pending.delete(id);
      }
      for (const fn of this.handlers.close) fn();
    });
  }

  /** The app-server handshake: `initialize`, then the `initialized` notification. */
  async initialize(clientInfo: { name: string; title: string; version: string }): Promise<unknown> {
    const result = await this.request("initialize", { clientInfo, capabilities: null });
    this.notify("initialized");
    return result;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new RpcError(-32000, "not connected"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError(-32000, `${method} timed out`));
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      ws.send(JSON.stringify({ method, id, ...(params !== undefined ? { params } : {}) }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.ws?.send(JSON.stringify({ method, ...(params !== undefined ? { params } : {}) }));
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  private onMessage(text: string): void {
    let msg: { id?: string | number; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) {
      for (const fn of this.handlers.request) fn({ id: msg.id, method: msg.method, params: msg.params });
      return;
    }
    if (msg.method) {
      for (const fn of this.handlers.notification) fn({ method: msg.method, params: msg.params });
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new RpcError(msg.error.code, msg.error.message));
      else p.resolve(msg.result);
    }
  }
}
