import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CLAUDE_EVENTS, PRE_TOOL_MATCHER, type ClaudeEventName, type ClaudeEventSlug } from "./hooks.ts";

export const PLUGIN_NAME = "multiplayer";
/** The MCP server name. Channels are opted in per session with `server:<name>`. */
export const MCP_SERVER_NAME = "multiplayer";

/** Environment variables the plugin's HTTP hooks read into headers. */
export const ENV_TOKEN = "MP_DAEMON_TOKEN";
export const ENV_AGENT = "MP_AGENT_ID";

/** Seconds. PreToolUse can wait while a review freezes a file (the daemon holds up to 4 minutes). */
const TIMEOUTS: Record<ClaudeEventName, number> = {
  SessionStart: 15,
  UserPromptSubmit: 10,
  PreToolUse: 300,
  PostToolUse: 30,
  PermissionRequest: 5,
  Stop: 15,
  SessionEnd: 2,
};

function httpHook(port: number, slug: ClaudeEventSlug) {
  return {
    type: "http",
    url: `http://127.0.0.1:${port}/v1/hooks/claude/${slug}`,
    timeout: TIMEOUTS[CLAUDE_EVENTS[slug]],
    headers: { Authorization: `Bearer $${ENV_TOKEN}`, "X-MP-Agent-Id": `$${ENV_AGENT}` },
    allowedEnvVars: [ENV_TOKEN, ENV_AGENT],
  };
}

/**
 * The Claude Code plugin, as files. Its hooks call mp-daemon directly over HTTP: no process is
 * spawned per tool call, and if the daemon is down the connection failure is a non-blocking error,
 * so Claude simply works solo.
 */
export function pluginFiles(opts: { port: number; version?: string }): Record<string, string> {
  const events = Object.keys(CLAUDE_EVENTS) as ClaudeEventSlug[];
  const hooks: Record<string, unknown[]> = {};
  for (const slug of events) {
    const name = CLAUDE_EVENTS[slug];
    hooks[name] = [{ ...(name === "PreToolUse" ? { matcher: PRE_TOOL_MATCHER } : {}), hooks: [httpHook(opts.port, slug)] }];
  }
  const manifest = {
    name: PLUGIN_NAME,
    version: opts.version ?? "0.0.1",
    author: { name: "Multiplayer" },
    description: "Multiplayer room: plans, locks, live diffs and messages shared with other agents working on this repo.",
  };
  return {
    ".claude-plugin/plugin.json": JSON.stringify(manifest, null, 2) + "\n",
    "hooks/hooks.json": JSON.stringify({ description: "Connects this session to its multiplayer room via mp-daemon.", hooks }, null, 2) + "\n",
  };
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const target = join(dir, rel);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, content, { mode: 0o600 });
  }
}

export interface McpCommand {
  command: string;
  args: string[];
}

/** The `--mcp-config` file: our MCP server, told which agent it serves and to push over channels. */
export function mcpConfig(opts: { agentId: string; home: string; channels: boolean; mcp: McpCommand }): object {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        type: "stdio",
        command: opts.mcp.command,
        args: opts.mcp.args,
        env: {
          MP_AGENT_ID: opts.agentId,
          MP_HOME: opts.home,
          ...(opts.channels ? { MP_CHANNELS: "1" } : {}),
        },
      },
    },
  };
}

export interface LaunchSpec {
  command: string;
  args: string[];
  /** Added to the terminal's environment. */
  env: Record<string, string>;
  cwd: string;
}

/** The first prompt for a new agent: its task, plus a nudge to coordinate before editing. */
export function initialPrompt(task: string): string {
  return `${task.trim()}\n\nYou're working in a multiplayer room. Start with mp_status, then publish your plan (mp_plan) and claim your area (mp_claim) before editing.`;
}

/**
 * How the IDE starts a Claude Code agent: in its worktree, with the multiplayer plugin (hooks), the
 * MCP server (tools), and the MCP server opted in as a channel so room messages arrive live.
 */
export function buildLaunch(opts: {
  worktree: string;
  agentId: string;
  token: string;
  home: string;
  pluginDir: string;
  mcpConfigPath: string;
  channels: boolean;
  prompt?: string;
  claudeCommand?: string;
}): LaunchSpec {
  const args = ["--plugin-dir", opts.pluginDir, "--mcp-config", opts.mcpConfigPath];
  if (opts.channels) args.push("--dangerously-load-development-channels", `server:${MCP_SERVER_NAME}`);
  if (opts.prompt) args.push(opts.prompt);
  return {
    command: opts.claudeCommand ?? "claude",
    args,
    env: { [ENV_AGENT]: opts.agentId, [ENV_TOKEN]: opts.token, MP_HOME: opts.home },
    cwd: opts.worktree,
  };
}
