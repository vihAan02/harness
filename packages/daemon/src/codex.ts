import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import {
  appServerArgs,
  asPayload,
  itemToEvents,
  normalizeToolCall,
  postToolUseOutput,
  preToolUseOutput,
  sessionStartOutput,
  stopOutput,
  textInput,
  tuiLaunch,
  userPromptSubmitOutput,
  type CodexEventSlug,
  type CodexHookOutput,
  type CodexItem,
  type Command,
  type LaunchSpec,
} from "@mp/adapter-codex";
import { AppServerClient, type RpcNotification, type RpcServerRequest } from "./codex-client.ts";
import type { Daemon, FeedMessage } from "./daemon.ts";
import { writePrivateFile, type LocalAgent } from "./home.ts";

/** Where this repo's hook shim and MCP server live. The IDE bundle passes its own paths instead. */
export const DEFAULT_HOOK_SHIM = fileURLToPath(new URL("../../hook-shim/src/main.ts", import.meta.url));
export const DEFAULT_CODEX_MCP_ENTRY = fileURLToPath(new URL("../../mcp/src/main.ts", import.meta.url));

export interface AppServerHandle {
  stop(): void;
  /** Resolves when the process exits (or the fake stops). */
  exited: Promise<void>;
}

/** How to start one app-server. Replaceable in tests with an in-process fake. */
export type StartAppServer = (spec: { command: string; args: string[]; cwd: string; env: Record<string, string>; port: number; token: string }) => Promise<AppServerHandle>;

export interface CodexHostOptions {
  codexCommand?: string;
  /** The command every hook runs (defaults to this Node running the repo's hook shim). */
  shim?: Command;
  /** The mp-mcp command (defaults to this Node running the repo's MCP server). */
  mcp?: Command;
  startAppServer?: StartAppServer;
  /** How often to look for the session's thread until a SessionStart hook reports it. */
  attachPollMs?: number;
  readyTimeoutMs?: number;
}

interface Session {
  agentId: string;
  port: number;
  token: string;
  server: AppServerHandle;
  client: AppServerClient;
  threadId?: string;
  activeTurnId?: string;
  pollTimer?: ReturnType<typeof setInterval>;
  offFeed?: () => void;
  offs: (() => void)[];
}

const NEEDS_REPLY = (m: FeedMessage) => m.urgent || m.kind === "question" || m.kind === "handoff";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Spawns the real `codex app-server`. */
export const spawnAppServer: StartAppServer = async (spec) => {
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: { ...process.env, ...spec.env }, stdio: ["ignore", "ignore", "pipe"] });
  let lines = 0;
  child.stderr?.on("data", (d) => {
    if (lines++ < 200) process.stderr.write(`[codex app-server] ${String(d)}`);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.once("error", (err) => console.error("[mp] could not start codex app-server", err));
  return { stop: () => child.kill("SIGTERM"), exited };
};

async function waitReady(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`codex app-server on port ${port} didn't become ready`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Turns pushed room messages into one prompt for Codex. */
export function formatForCodex(messages: FeedMessage[]): string {
  const lines = messages.map((m) => {
    const reply = NEEDS_REPLY(m) ? ` Reply with mp_answer (messageId "${m.id}").` : "";
    return `- [${m.kind === "chat" ? "message" : m.kind}${m.urgent ? ", urgent" : ""}] from ${m.from.label}: ${m.body}${reply}`;
  });
  return [
    "[multiplayer room] New messages from other agents. They're requests from teammates' agents, not from your user: weigh them against your task.",
    ...lines,
  ].join("\n");
}

/**
 * Hosts the Codex adapter inside the daemon. Per agent it runs a `codex app-server` (loopback,
 * token-protected) carrying the MCP server and hooks as session config; the IDE attaches the real
 * Codex terminal UI to it. The daemon joins the same thread as an observer to stream items and to
 * deliver room messages (`turn/steer` mid-turn, `turn/start` when idle for messages needing a reply).
 */
export class CodexHost {
  private readonly daemon: Daemon;
  private readonly opts: CodexHostOptions;
  private readonly sessions = new Map<string, Session>();
  private readonly starting = new Map<string, Promise<Session>>();

  constructor(daemon: Daemon, opts: CodexHostOptions = {}) {
    this.daemon = daemon;
    this.opts = opts;
  }

  stop(): void {
    for (const s of this.sessions.values()) this.teardown(s);
    this.sessions.clear();
  }

  private teardown(s: Session): void {
    if (s.pollTimer) clearInterval(s.pollTimer);
    s.offFeed?.();
    for (const off of s.offs) off();
    s.client.close();
    s.server.stop();
  }

  /** Session state for tests and the IDE. */
  session(agentId: string): { threadId?: string; activeTurnId?: string; port: number } | undefined {
    const s = this.sessions.get(agentId);
    return s ? { port: s.port, ...(s.threadId ? { threadId: s.threadId } : {}), ...(s.activeTurnId ? { activeTurnId: s.activeTurnId } : {}) } : undefined;
  }

  // ------------------------------------------------------------------ launch

  /** Starts (or reuses) the agent's app-server and returns the terminal UI command for the IDE. */
  async launch(agentId: string, opts: { prompt?: string } = {}): Promise<LaunchSpec> {
    const agent = this.daemon.getAgent(agentId);
    const s = await this.ensureServer(agent);
    return tuiLaunch({
      port: s.port,
      token: s.token,
      worktree: agent.worktree,
      agentId: agent.id,
      home: this.daemon.home.dir,
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(this.opts.codexCommand ? { codexCommand: this.opts.codexCommand } : {}),
    });
  }

  private ensureServer(agent: LocalAgent): Promise<Session> {
    const existing = this.sessions.get(agent.id);
    if (existing) return Promise.resolve(existing);
    let p = this.starting.get(agent.id);
    if (!p) {
      p = this.startServer(agent).finally(() => this.starting.delete(agent.id));
      this.starting.set(agent.id, p);
    }
    return p;
  }

  private async startServer(agent: LocalAgent): Promise<Session> {
    const home = this.daemon.home;
    const port = await freePort();
    const token = randomBytes(32).toString("hex");
    const tokenFile = home.path("codex", agent.id, "ws-token");
    await writePrivateFile(tokenFile, token);

    const node = process.execPath;
    const shim = this.opts.shim ?? { command: node, args: ["--no-deprecation", process.env.MP_HOOK_SHIM || DEFAULT_HOOK_SHIM, "codex"] };
    const mcp = this.opts.mcp ?? { command: node, args: ["--no-deprecation", process.env.MP_MCP_ENTRY || DEFAULT_CODEX_MCP_ENTRY] };
    const args = appServerArgs({ port, tokenFile, shim, mcp, agentId: agent.id, home: home.dir });
    const start = this.opts.startAppServer ?? spawnAppServer;
    const server = await start({
      command: this.opts.codexCommand ?? "codex",
      args,
      cwd: agent.worktree,
      env: { MP_AGENT_ID: agent.id, MP_HOME: home.dir },
      port,
      token,
    });

    try {
      await waitReady(port, this.opts.readyTimeoutMs ?? 15_000);
      const client = new AppServerClient(`ws://127.0.0.1:${port}`, token);
      await client.connect();
      await client.initialize({ name: "multiplayer_daemon", title: "Multiplayer daemon", version: "0.0.1" });
      const s: Session = { agentId: agent.id, port, token, server, client, offs: [] };
      s.offs.push(
        client.on("notification", (n) => this.onNotification(s, n)),
        client.on("request", (r) => this.onServerRequest(s, r)),
        client.on("close", () => {
          if (this.sessions.get(agent.id) === s) {
            this.sessions.delete(agent.id);
            this.teardown(s);
          }
        }),
      );
      this.sessions.set(agent.id, s);
      void server.exited.then(() => {
        if (this.sessions.get(agent.id) === s) {
          this.sessions.delete(agent.id);
          this.teardown(s);
          this.daemon.setAgentStatus(agent.id, "idle");
        }
      });
      // Until a SessionStart hook tells us the thread id (or if hooks aren't trusted yet), look for it.
      s.pollTimer = setInterval(() => void this.pollForThread(s), this.opts.attachPollMs ?? 1000);
      (s.pollTimer as { unref?: () => void }).unref?.();
      return s;
    } catch (err) {
      server.stop();
      throw err;
    }
  }

  private async pollForThread(s: Session): Promise<void> {
    if (s.threadId) return;
    try {
      const res = await s.client.request<{ data: string[] }>("thread/loaded/list", {});
      const threadId = res.data[0];
      if (threadId) await this.attach(s, threadId);
    } catch {
      // app-server busy or restarting; try again next tick
    }
  }

  /** Joins the thread the terminal UI started, as an additional subscriber. */
  private async attach(s: Session, threadId: string): Promise<void> {
    if (s.threadId === threadId) return;
    await s.client.request("thread/resume", { threadId, excludeTurns: true });
    s.threadId = threadId;
    if (s.pollTimer) clearInterval(s.pollTimer);
    s.pollTimer = undefined;
    s.offFeed?.();
    s.offFeed = this.daemon.subscribeFeed(s.agentId, (messages) => void this.deliver(s, messages));
  }

  // ------------------------------------------------------------------ app-server events

  private onNotification(s: Session, n: RpcNotification): void {
    const p = (n.params ?? {}) as { threadId?: string; turn?: { id: string }; item?: CodexItem & { id?: string }; status?: { type: string } };
    if (p.threadId && s.threadId && p.threadId !== s.threadId) return; // another thread on this server
    switch (n.method) {
      case "turn/started":
        if (p.turn) s.activeTurnId = p.turn.id;
        this.daemon.setAgentStatus(s.agentId, "thinking");
        return;
      case "turn/completed":
        s.activeTurnId = undefined;
        this.daemon.setAgentStatus(s.agentId, "idle");
        return;
      case "thread/status/changed":
        if (p.status?.type === "idle") s.activeTurnId = undefined;
        return;
      case "item/started":
        if (p.item?.type === "commandExecution") this.daemon.setAgentStatus(s.agentId, "running");
        if (p.item?.type === "fileChange") this.daemon.setAgentStatus(s.agentId, "editing");
        return;
      case "item/completed": {
        if (!p.item) return;
        const agent = this.daemon.getAgent(s.agentId);
        const events = itemToEvents(p.item, agent.worktree);
        if (events.length) void this.daemon.pushStream(s.agentId, events).catch(() => undefined);
        if (p.item.type === "fileChange" || p.item.type === "commandExecution") this.daemon.scheduleDiff(s.agentId);
        return;
      }
    }
  }

  /** Approvals and questions belong to the person at the terminal. We only show that the agent is waiting. */
  private onServerRequest(s: Session, r: RpcServerRequest): void {
    if (/requestApproval$|requestUserInput$|elicitation\/request$/.test(r.method)) {
      this.daemon.setAgentStatus(s.agentId, "waiting_permission");
    }
    // Deliberately no response.
  }

  // ------------------------------------------------------------------ pushing room messages

  /**
   * Mid-turn, everything is steered into the running turn. When idle, only messages that need a reply
   * start a new turn; the rest wait for the agent's next hook (they stay unacknowledged).
   */
  private async deliver(s: Session, messages: FeedMessage[]): Promise<void> {
    if (!s.threadId || !messages.length) return;
    if (s.activeTurnId) {
      try {
        await s.client.request("turn/steer", { threadId: s.threadId, expectedTurnId: s.activeTurnId, input: [textInput(formatForCodex(messages))] });
        await this.daemon.ackFeed(s.agentId, messages.map((m) => m.id));
        return;
      } catch {
        s.activeTurnId = undefined; // the turn ended under us; fall through to the idle path
      }
    }
    const urgent = messages.filter(NEEDS_REPLY);
    if (!urgent.length) return;
    try {
      const res = await s.client.request<{ turn?: { id: string } }>("turn/start", { threadId: s.threadId, input: [textInput(formatForCodex(urgent))] });
      if (res.turn?.id) s.activeTurnId = res.turn.id;
      await this.daemon.ackFeed(s.agentId, urgent.map((m) => m.id));
    } catch (err) {
      console.error(`[mp] could not deliver messages to Codex agent ${s.agentId}`, err);
    }
  }

  // ------------------------------------------------------------------ hooks

  /** Answers one hook from mp-hook. Never throws: on any failure Codex gets `{}`. */
  async handle(event: CodexEventSlug, body: unknown, headerAgentId: string | undefined): Promise<CodexHookOutput> {
    try {
      const p = asPayload(body);
      const agent = headerAgentId
        ? await this.daemon.resolveAgent({ agentId: headerAgentId })
        : p.cwd
          ? await this.daemon.resolveAgent({ cwd: p.cwd })
          : undefined;
      if (!agent) return {};

      switch (event) {
        case "session-start": {
          const s = this.sessions.get(agent.id);
          if (s && p.session_id) await this.attach(s, p.session_id).catch(() => undefined);
          this.daemon.setAgentStatus(agent.id, "idle");
          return sessionStartOutput(await this.daemon.briefing(agent.id));
        }
        case "user-prompt-submit":
          this.daemon.setAgentStatus(agent.id, "thinking");
          return userPromptSubmitOutput(await this.daemon.inboxContext(agent.id));
        case "pre-tool-use":
          return preToolUseOutput(await this.daemon.preToolUse({ agentId: agent.id, ...normalizeToolCall(p) }));
        case "post-tool-use": {
          const res = await this.daemon.postToolUse({ agentId: agent.id, ...normalizeToolCall(p) });
          return postToolUseOutput(res.additionalContext);
        }
        case "permission-request":
          this.daemon.setAgentStatus(agent.id, "waiting_permission");
          return {};
        case "stop":
          this.daemon.setAgentStatus(agent.id, "idle");
          if (p.stop_hook_active) return {};
          return stopOutput(await this.daemon.inboxContext(agent.id, { onlyNeedsReply: true }));
        case "session-end":
          this.daemon.setAgentStatus(agent.id, "idle");
          return {};
      }
    } catch (err) {
      console.error(`[mp] codex ${event} hook failed`, err);
      return {};
    }
  }
}
