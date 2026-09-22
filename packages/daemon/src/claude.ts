import { fileURLToPath } from "node:url";
import {
  asPayload,
  buildLaunch,
  mcpConfig,
  normalizeToolCall,
  pluginFiles,
  postToolUseOutput,
  preToolUseOutput,
  sessionStartOutput,
  stopOutput,
  TranscriptParser,
  userPromptSubmitOutput,
  writeFiles,
  type ClaudeEventSlug,
  type ClaudeHookOutput,
  type LaunchSpec,
  type McpCommand,
} from "@mp/adapter-claude";
import type { Daemon } from "./daemon.ts";
import type { LocalAgent } from "./home.ts";
import { JsonlTail } from "./tail.ts";

/** Where mp-mcp lives in this repo. The IDE bundle passes its own path instead. */
export const DEFAULT_MCP_ENTRY = fileURLToPath(new URL("../../mcp/src/main.ts", import.meta.url));

interface Session {
  sessionId: string;
  transcriptPath: string;
  tail: JsonlTail;
}

export interface ClaudeHostOptions {
  /** How to run mp-mcp. Defaults to this Node binary running the repo's mcp entry. */
  mcp?: McpCommand;
  claudeCommand?: string;
  transcriptPollMs?: number;
}

/**
 * Hosts the Claude adapter inside the daemon: answers the multiplayer plugin's HTTP hooks, streams
 * each session's transcript into the room, and prepares launch specs for the IDE.
 */
export class ClaudeHost {
  private readonly daemon: Daemon;
  private readonly opts: ClaudeHostOptions;
  private readonly sessions = new Map<string, Session>(); // by agent id

  constructor(daemon: Daemon, opts: ClaudeHostOptions = {}) {
    this.daemon = daemon;
    this.opts = opts;
  }

  stop(): void {
    for (const s of this.sessions.values()) s.tail.stop();
    this.sessions.clear();
  }

  private async agentFor(headerAgentId: string | undefined, cwd: string | undefined): Promise<LocalAgent | undefined> {
    if (headerAgentId) {
      const byId = await this.daemon.resolveAgent({ agentId: headerAgentId });
      if (byId) return byId;
    }
    return cwd ? this.daemon.resolveAgent({ cwd }) : undefined;
  }

  /** Answers one hook. Never throws: on any failure Claude gets `{}`, which means "carry on". */
  async handle(event: ClaudeEventSlug, body: unknown, headerAgentId: string | undefined): Promise<ClaudeHookOutput> {
    try {
      const p = asPayload(body);
      const agent = await this.agentFor(headerAgentId, p.cwd);
      if (!agent) return {};

      switch (event) {
        case "session-start": {
          if (p.session_id && p.transcript_path) await this.attach(agent, p.session_id, p.transcript_path, p.source === "startup" || p.source === "clear");
          this.daemon.setAgentStatus(agent.id, "idle");
          return sessionStartOutput(await this.daemon.briefing(agent.id), agent.name);
        }
        case "user-prompt-submit": {
          this.daemon.setAgentStatus(agent.id, "thinking");
          return userPromptSubmitOutput(await this.daemon.inboxContext(agent.id));
        }
        case "pre-tool-use": {
          const call = normalizeToolCall(p);
          return preToolUseOutput(await this.daemon.preToolUse({ agentId: agent.id, ...call }));
        }
        case "post-tool-use": {
          const call = normalizeToolCall(p);
          const res = await this.daemon.postToolUse({ agentId: agent.id, ...call });
          void this.sessions.get(agent.id)?.tail.poll();
          return postToolUseOutput(res.additionalContext);
        }
        case "permission-request": {
          this.daemon.setAgentStatus(agent.id, "waiting_permission");
          return {};
        }
        case "stop": {
          this.daemon.setAgentStatus(agent.id, "idle");
          void this.sessions.get(agent.id)?.tail.poll();
          // Claude Code's loop protection: never keep it going twice in a row.
          if (p.stop_hook_active) return {};
          return stopOutput(await this.daemon.inboxContext(agent.id, { onlyNeedsReply: true }));
        }
        case "session-end": {
          const s = this.sessions.get(agent.id);
          if (s) {
            await s.tail.poll();
            s.tail.stop();
            this.sessions.delete(agent.id);
          }
          this.daemon.setAgentStatus(agent.id, "idle");
          return {};
        }
      }
    } catch (err) {
      console.error(`[mp] claude ${event} hook failed`, err);
      return {};
    }
  }

  private async attach(agent: LocalAgent, sessionId: string, transcriptPath: string, fromStart: boolean): Promise<void> {
    const existing = this.sessions.get(agent.id);
    if (existing?.transcriptPath === transcriptPath) return;
    existing?.tail.stop();
    const parser = new TranscriptParser(agent.worktree);
    const tail = new JsonlTail(
      transcriptPath,
      (lines) => {
        const events = lines.flatMap((l) => parser.parse(l));
        if (events.length) void this.daemon.pushStream(agent.id, events).catch(() => undefined);
      },
      { fromStart, ...(this.opts.transcriptPollMs ? { pollMs: this.opts.transcriptPollMs } : {}) },
    );
    this.sessions.set(agent.id, { sessionId, transcriptPath, tail });
    await tail.start();
  }

  /**
   * Everything the IDE needs to start this agent in a terminal: writes the plugin (hooks pointing at
   * this daemon) and the agent's MCP config, and returns the command, arguments and environment.
   */
  async launch(agentId: string, opts: { prompt?: string; channels?: boolean } = {}): Promise<LaunchSpec> {
    const agent = this.daemon.getAgent(agentId);
    const info = await this.daemon.home.daemonInfo();
    if (!info) throw new Error("the daemon's endpoint isn't published yet (no daemon.json)");
    const home = this.daemon.home;
    const pluginDir = home.path("claude", "plugin");
    await writeFiles(pluginDir, pluginFiles({ port: info.port }));

    const channels = opts.channels ?? true;
    const mcp = this.opts.mcp ?? { command: process.execPath, args: ["--no-deprecation", process.env.MP_MCP_ENTRY || DEFAULT_MCP_ENTRY] };
    const mcpConfigPath = home.path("claude", "agents", agent.id, "mcp.json");
    await writeFiles(home.path("claude", "agents", agent.id), {
      "mcp.json": JSON.stringify(mcpConfig({ agentId: agent.id, home: home.dir, channels, mcp }), null, 2) + "\n",
    });

    return buildLaunch({
      worktree: agent.worktree,
      agentId: agent.id,
      token: info.token,
      home: home.dir,
      pluginDir,
      mcpConfigPath,
      channels,
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(this.opts.claudeCommand ? { claudeCommand: this.opts.claudeCommand } : {}),
    });
  }
}
