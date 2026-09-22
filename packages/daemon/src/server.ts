import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { AgentEvent, ToolIntentKind, Vendor } from "@mp/protocol";
import { Daemon, DaemonError, type HookInput } from "./daemon.ts";
import { ToolError } from "./tools.ts";

const MAX_BODY = 2 * 1024 * 1024;

const Bodies = {
  createRoom: z.object({ repoPath: z.string().min(1), relayUrl: z.string().url() }),
  joinRoom: z.object({ repoPath: z.string().min(1), invite: z.string().min(1) }),
  identity: z.object({ name: z.string().min(1).max(80) }),
  createAgent: z.object({
    repoPath: z.string().min(1),
    name: z.string().min(1).max(80),
    vendor: Vendor,
    task: z.string().max(500).optional(),
    baseBranch: z.string().min(1).optional(),
  }),
  stream: z.object({ events: z.array(AgentEvent).min(1).max(500) }),
  hook: z.object({
    agentId: z.string().optional(),
    cwd: z.string().optional(),
    kind: ToolIntentKind,
    tool: z.string().max(200),
    paths: z.array(z.string().max(4096)).max(500).optional(),
    command: z.string().max(8000).optional(),
  }),
};

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "too_large", "request body too large");
    chunks.push(chunk as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "invalid JSON body");
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, "bad_request", r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
}

function tokenOk(header: string | undefined, token: string): boolean {
  const given = Buffer.from(header?.startsWith("Bearer ") ? header.slice(7) : "");
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

type Handler = (ctx: { req: IncomingMessage; url: URL; params: string[]; body: () => Promise<unknown> }) => Promise<unknown>;

export interface ServerHandle {
  server: Server;
  port: number;
  close(): Promise<void>;
}

/**
 * The daemon's localhost API, used by hook shims, the MCP server and the IDE.
 * Bound to 127.0.0.1, bearer-token protected, and it refuses browser requests (Origin header)
 * and foreign Host headers so web pages can't reach it via DNS rebinding.
 */
export async function startServer(daemon: Daemon, opts: { port: number; token: string }): Promise<ServerHandle> {
  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/v1\/health$/, async () => ({ ok: true, rooms: daemon.listRooms().length, agents: daemon.listAgents().length })],
    ["GET", /^\/v1\/identity$/, async () => daemon.identity],
    ["PUT", /^\/v1\/identity$/, async ({ body }) => {
      const { name } = parse(Bodies.identity, await body());
      daemon.identity = await daemon.home.setName(name);
      return daemon.identity;
    }],
    ["GET", /^\/v1\/rooms$/, async () => daemon.listRooms()],
    ["POST", /^\/v1\/rooms$/, async ({ body }) => daemon.createRoom(parse(Bodies.createRoom, await body()))],
    ["POST", /^\/v1\/rooms\/join$/, async ({ body }) => daemon.joinRoom(parse(Bodies.joinRoom, await body()))],
    ["GET", /^\/v1\/rooms\/([^/]+)\/status$/, async ({ params }) => daemon.roomStatus(params[0]!)],
    ["GET", /^\/v1\/agents$/, async () => daemon.listAgents()],
    ["POST", /^\/v1\/agents$/, async ({ body }) => daemon.createAgent(parse(Bodies.createAgent, await body()))],
    ["DELETE", /^\/v1\/agents\/([^/]+)$/, async ({ params, url }) => {
      await daemon.removeAgent(params[0]!, {
        keepWorktree: url.searchParams.get("keepWorktree") === "1",
        force: url.searchParams.get("force") === "1",
      });
      return { removed: params[0] };
    }],
    ["POST", /^\/v1\/agents\/([^/]+)\/stream$/, async ({ params, body }) => {
      await daemon.pushStream(params[0]!, parse(Bodies.stream, await body()).events);
      return { queued: true };
    }],
    ["POST", /^\/v1\/agents\/([^/]+)\/tools\/([a-z_]+)$/, async ({ params, body }) => {
      const raw = (await body()) as { args?: unknown };
      return daemon.tool(params[0]!, params[1]!, raw?.args ?? {});
    }],
    ["POST", /^\/v1\/hooks\/pre$/, async ({ body }) => daemon.preToolUse(parse(Bodies.hook, await body()) as HookInput)],
    ["POST", /^\/v1\/hooks\/post$/, async ({ body }) => daemon.postToolUse(parse(Bodies.hook, await body()) as HookInput)],
  ];

  let port = opts.port;
  const server = createServer(async (req, res) => {
    try {
      const host = (req.headers.host ?? "").toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new HttpError(421, "bad_host", "unexpected Host header");
      if (req.headers.origin) throw new HttpError(403, "browser_forbidden", "browser requests are not allowed");
      if (!tokenOk(req.headers.authorization, opts.token)) throw new HttpError(401, "unauthorized", "missing or wrong bearer token");

      const url = new URL(req.url ?? "/", `http://${host}`);
      for (const [method, pattern, handler] of routes) {
        const m = pattern.exec(url.pathname);
        if (!m || req.method !== method) continue;
        const params = m.slice(1).map((p) => decodeURIComponent(p));
        const result = await handler({ req, url, params, body: () => readJson(req) });
        return send(res, 200, result ?? {});
      }
      throw new HttpError(404, "not_found", `${req.method} ${url.pathname}`);
    } catch (err) {
      if (err instanceof HttpError || err instanceof DaemonError) return send(res, err.status, { error: { code: err.code, message: err.message } });
      if (err instanceof ToolError) return send(res, 400, { error: { code: "bad_tool_args", message: err.message } });
      console.error("[mp] request failed", err);
      return send(res, 500, { error: { code: "internal", message: "internal error" } });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
