import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FeedMessage, LocalAgent } from "@mp/daemon";

/** The daemon isn't running or can't be reached. */
export class DaemonUnavailable extends Error {}

/** The daemon answered with an error. */
export class DaemonRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export interface DaemonClientOptions {
  /** MP_HOME; defaults to ~/.multiplayer. The daemon's port and token are read from `daemon.json` there. */
  home?: string | undefined;
  /** Explicit endpoint (MP_DAEMON_URL / MP_DAEMON_TOKEN), overriding daemon.json. */
  url?: string | undefined;
  token?: string | undefined;
}

interface Endpoint {
  url: string;
  token: string;
}

/** A small client for mp-daemon's localhost API. Rediscovers the daemon if it restarts on a new port. */
export class DaemonClient {
  private readonly home: string;
  private readonly fixed: Endpoint | null;
  private cached: Endpoint | null = null;

  constructor(opts: DaemonClientOptions = {}) {
    this.home = opts.home || process.env.MP_HOME || join(homedir(), ".multiplayer");
    this.fixed = opts.url && opts.token ? { url: opts.url.replace(/\/+$/, ""), token: opts.token } : null;
  }

  private async endpoint(refresh: boolean): Promise<Endpoint> {
    if (this.fixed) return this.fixed;
    if (this.cached && !refresh) return this.cached;
    let info: { port: number; token: string };
    try {
      info = JSON.parse(await readFile(join(this.home, "daemon.json"), "utf8"));
    } catch {
      throw new DaemonUnavailable(`mp-daemon is not running (no ${join(this.home, "daemon.json")})`);
    }
    this.cached = { url: `http://127.0.0.1:${info.port}`, token: info.token };
    return this.cached;
  }

  private async send(method: string, path: string, body: unknown, refresh: boolean, signal?: AbortSignal): Promise<Response> {
    const ep = await this.endpoint(refresh);
    return fetch(`${ep.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${ep.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  }

  /** Sends a request, retrying once with a fresh daemon.json if the daemon moved or restarted. */
  private async raw(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await this.send(method, path, body, false, signal);
      if (res.status !== 401) return res;
    } catch (err) {
      if (signal?.aborted) throw err;
    }
    try {
      return await this.send(method, path, body, true, signal);
    } catch (err) {
      if (signal?.aborted || err instanceof DaemonUnavailable) throw err;
      throw new DaemonUnavailable(`mp-daemon is not reachable: ${(err as Error).message}`);
    }
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      const e = (json as { error?: { code?: string; message?: string } }).error;
      throw new DaemonRequestError(res.status, e?.code ?? "error", e?.message ?? `daemon returned ${res.status}`);
    }
    return json as T;
  }

  resolveAgent(cwd: string): Promise<LocalAgent> {
    return this.request("GET", `/v1/agents/resolve?cwd=${encodeURIComponent(cwd)}`);
  }

  tool(agentId: string, name: string, args: unknown): Promise<{ text: string; data?: unknown }> {
    return this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/tools/${name}`, { args });
  }

  async ack(agentId: string, ids: string[]): Promise<void> {
    await this.request("POST", `/v1/agents/${encodeURIComponent(agentId)}/feed/ack`, { ids });
  }

  /** Yields batches of messages for the agent as they arrive. Ends (or throws) when the stream drops. */
  async *feed(agentId: string, signal: AbortSignal): AsyncGenerator<FeedMessage[]> {
    const res = await this.raw("GET", `/v1/agents/${encodeURIComponent(agentId)}/feed`, undefined, signal);
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new DaemonRequestError(res.status, "feed_failed", text || `feed returned ${res.status}`);
    }
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        if (!data.length) continue; // keep-alive comment
        const payload = JSON.parse(data.join("\n")) as unknown;
        if (event === "messages") yield payload as FeedMessage[];
        else if (event === "error") throw new DaemonRequestError(404, "feed_failed", (payload as { message?: string }).message ?? "feed error");
      }
    }
  }
}
