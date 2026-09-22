import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { AgentEvent, ToolIntentKind, Vendor } from "@mp/protocol";
import { Daemon, DaemonError, type HookInput } from "./daemon.ts";
import { initialPrompt, isClaudeEventSlug } from "@mp/adapter-claude";
import { isCodexEventSlug } from "@mp/adapter-codex";
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
  ack: z.object({ ids: z.array(z.string().min(1)).max(1000) }),
  launch: z.object({
    prompt: z.string().max(20_000).optional(),
    /** A task for a new agent: becomes its first prompt, with a nudge to coordinate first. */
    task: z.string().max(20_000).optional(),
    channels: z.boolean().optional(),
  }),
  humanMessage: z.object({
    to: z.array(z.object({ type: z.enum(["agent", "member"]), id: z.string().min(1) })).max(50).default([]),
    body: z.string().min(1).max(16_000),
    kind: z.enum(["chat", "fyi", "question", "handoff"]).default("chat"),
    threadId: z.string().optional(),
    urgent: z.boolean().optional(),
  }),
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
    ["GET", /^\/v1\/repos\/resolve$/, async ({ url }) => {
      const path = url.searchParams.get("path");
      if (!path) throw new HttpError(400, "bad_request", "path is required");
      return daemon.resolveRepo(path);
    }],
    ["POST", /^\/v1\/rooms$/, async ({ body }) => daemon.createRoom(parse(Bodies.createRoom, await body()))],
    ["POST", /^\/v1\/rooms\/join$/, async ({ body }) => daemon.joinRoom(parse(Bodies.joinRoom, await body()))],
    ["GET", /^\/v1\/rooms\/([^/]+)\/status$/, async ({ params }) => daemon.roomStatus(params[0]!)],
    ["POST", /^\/v1\/rooms\/([^/]+)\/messages$/, async ({ params, body }) => {
      const m = parse(Bodies.humanMessage, await body());
      return daemon.link(params[0]!).request({
        op: "message.send",
        from: { type: "member", id: daemon.identity.memberId },
        to: m.to,
        kind: m.kind,
        body: m.body,
        ...(m.threadId ? { threadId: m.threadId } : {}),
        ...(m.urgent !== undefined ? { urgent: m.urgent } : {}),
      });
    }],
    ["GET", /^\/v1\/agents$/, async () => daemon.listAgents()],
    ["GET", /^\/v1\/agents\/resolve$/, async ({ url }) => {
      const cwd = url.searchParams.get("cwd");
      if (!cwd) throw new HttpError(400, "bad_request", "cwd is required");
      const agent = await daemon.resolveAgent({ cwd });
      if (!agent) throw new HttpError(404, "no_agent", `no agent works in ${cwd}`);
      return agent;
    }],
    ["POST", /^\/v1\/agents\/([^/]+)\/feed\/ack$/, async ({ params, body }) => {
      await daemon.ackFeed(params[0]!, parse(Bodies.ack, await body()).ids);
      return { acked: true };
    }],
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
    ["POST", /^\/v1\/agents\/([^/]+)\/launch\/claude$/, async ({ params, body }) => {
      const input = parse(Bodies.launch, await body());
      const prompt = input.prompt ?? (input.task ? initialPrompt(input.task) : undefined);
      return daemon.claude.launch(params[0]!, {
        ...(prompt ? { prompt } : {}),
        ...(input.channels !== undefined ? { channels: input.channels } : {}),
      });
    }],
    ["POST", /^\/v1\/agents\/([^/]+)\/launch\/codex$/, async ({ params, body }) => {
      const input = parse(Bodies.launch, await body());
      const prompt = input.prompt ?? (input.task ? initialPrompt(input.task) : undefined);
      return daemon.codex.launch(params[0]!, prompt ? { prompt } : {});
    }],
    // Codex hooks, forwarded by mp-hook. Always 200 with Codex-shaped JSON; failures mean "carry on".
    ["POST", /^\/v1\/hooks\/codex\/([a-z-]+)$/, async ({ params, req, body }) => {
      const event = params[0]!;
      if (!isCodexEventSlug(event)) return {};
      const raw = await body().catch(() => ({}));
      const header = req.headers["x-mp-agent-id"];
      return daemon.codex.handle(event, raw, typeof header === "string" && header ? header : undefined);
    }],
    // Claude Code's plugin hooks. Always answer 200 with Claude-shaped JSON; failures mean "carry on".
    ["POST", /^\/v1\/hooks\/claude\/([a-z-]+)$/, async ({ params, req, body }) => {
      const event = params[0]!;
      if (!isClaudeEventSlug(event)) throw new HttpError(404, "not_found", `unknown Claude hook ${event}`);
      const raw = await body().catch(() => ({}));
      const header = req.headers["x-mp-agent-id"];
      return daemon.claude.handle(event, raw, typeof header === "string" && header ? header : undefined);
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
      const feed = /^\/v1\/agents\/([^/]+)\/feed$/.exec(url.pathname);
      if (feed && req.method === "GET") return openFeed(daemon, decodeURIComponent(feed[1]!), req, res);
      const roomEvents = /^\/v1\/rooms\/([^/]+)\/events$/.exec(url.pathname);
      if (roomEvents && req.method === "GET") return openRoomEvents(daemon, decodeURIComponent(roomEvents[1]!), req, res);
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
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // ends open feed streams
      }),
  };
}

const FEED_PING_MS = 15_000;

/**
 * The live room for UIs (the IDE): `snapshot` first (room state, connection, this machine's agents
 * and identity), then every `event`, `stream` and `status` change as it happens.
 */
function openRoomEvents(daemon: Daemon, roomId: string, req: IncomingMessage, res: ServerResponse): void {
  let link;
  try {
    link = daemon.link(roomId);
  } catch (err) {
    const e = err as DaemonError;
    return send(res, e.status ?? 404, { error: { code: e.code ?? "no_room", message: e.message } });
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const write = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  write("snapshot", {
    connected: link.connected,
    room: link.mirror.stateSnapshot(),
    localAgents: daemon.listAgents().filter((a) => a.roomId === roomId),
    identity: daemon.identity,
  });
  const offs = [
    link.on("event", (event) => write("event", event)),
    link.on("stream", (agentId, events) => write("stream", { agentId, events })),
    link.on("status", (connected) => {
      write("status", { connected });
      // After a reconnect the mirror may have been replaced wholesale; resend it.
      if (connected) write("snapshot", { connected, room: link.mirror.stateSnapshot(), localAgents: daemon.listAgents().filter((a) => a.roomId === roomId), identity: daemon.identity });
    }),
  ];
  const ping = setInterval(() => res.write(": ping\n\n"), FEED_PING_MS);
  req.on("close", () => {
    clearInterval(ping);
    for (const off of offs) off();
  });
}

/** Server-sent events: `event: messages` with a JSON array of FeedMessage, plus keep-alive comments. */
function openFeed(daemon: Daemon, agentId: string, req: IncomingMessage, res: ServerResponse): void {
  let unsubscribe: () => void;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": connected\n\n");
  try {
    unsubscribe = daemon.subscribeFeed(agentId, (messages) => {
      res.write(`event: messages\ndata: ${JSON.stringify(messages)}\n\n`);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.end(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
    return;
  }
  const ping = setInterval(() => res.write(": ping\n\n"), FEED_PING_MS);
  req.on("close", () => {
    clearInterval(ping);
    unsubscribe();
  });
}
