import { CODEX_EVENTS, PRE_TOOL_MATCHER, type CodexEventName } from "./hooks.ts";

export const MCP_SERVER_NAME = "multiplayer";
/** Environment variable the terminal UI reads the app-server capability token from. */
export const ENV_REMOTE_TOKEN = "MP_CODEX_REMOTE_TOKEN";

/** Seconds. PreToolUse can wait while a review freezes a file (the daemon holds up to 4 minutes). */
const TIMEOUTS: Record<CodexEventName, number> = {
  SessionStart: 15,
  UserPromptSubmit: 15,
  PreToolUse: 300,
  PostToolUse: 30,
  PermissionRequest: 5,
  Stop: 15,
  SessionEnd: 3,
};

/** A TOML basic string. */
export function tomlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

/** A POSIX shell word (Codex runs hook commands through a shell). */
export function shellWord(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface Command {
  command: string;
  args: string[];
}

/**
 * The shim command every hook runs. It is identical for all events and never contains ports or
 * tokens, so its hash is stable: Codex asks the user to trust it once, not on every launch.
 */
export function hookCommand(shim: Command): string {
  return [shim.command, ...shim.args].map(shellWord).join(" ");
}

/** `-c hooks.<Event>=[...]` overrides: session-level hooks, so nothing is written to the repo or ~/.codex. */
export function hookOverrides(shim: Command): string[] {
  const command = hookCommand(shim);
  const out: string[] = [];
  for (const name of Object.values(CODEX_EVENTS)) {
    const matcher = name === "PreToolUse" ? `matcher=${tomlString(PRE_TOOL_MATCHER)},` : "";
    out.push("-c", `hooks.${name}=[{${matcher}hooks=[{type="command",command=${tomlString(command)},timeout=${TIMEOUTS[name]}}]}]`);
  }
  return out;
}

/** `-c mcp_servers.multiplayer.*` overrides for the mp_* tools. */
export function mcpOverrides(opts: { mcp: Command; agentId: string; home: string }): string[] {
  const prefix = `mcp_servers.${MCP_SERVER_NAME}`;
  return [
    "-c",
    `${prefix}.command=${tomlString(opts.mcp.command)}`,
    "-c",
    `${prefix}.args=[${opts.mcp.args.map(tomlString).join(",")}]`,
    "-c",
    `${prefix}.env={MP_AGENT_ID=${tomlString(opts.agentId)},MP_HOME=${tomlString(opts.home)}}`,
  ];
}

/**
 * Arguments for the per-agent `codex app-server` that mp-daemon runs. It listens on loopback with
 * capability-token auth (the token lives in a 0600 file), and carries the MCP server and hooks as
 * session config.
 */
export function appServerArgs(opts: {
  port: number;
  tokenFile: string;
  shim: Command;
  mcp: Command;
  agentId: string;
  home: string;
}): string[] {
  return [
    "app-server",
    "--listen",
    `ws://127.0.0.1:${opts.port}`,
    "--ws-auth",
    "capability-token",
    "--ws-token-file",
    opts.tokenFile,
    ...mcpOverrides(opts),
    ...hookOverrides(opts.shim),
  ];
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

/** What the IDE runs in a terminal: the real Codex terminal UI, attached to the agent's app-server. */
export function tuiLaunch(opts: {
  port: number;
  token: string;
  worktree: string;
  agentId: string;
  home: string;
  prompt?: string;
  codexCommand?: string;
}): LaunchSpec {
  const args = ["--remote", `ws://127.0.0.1:${opts.port}`, "--remote-auth-token-env", ENV_REMOTE_TOKEN];
  if (opts.prompt) args.push(opts.prompt);
  return {
    command: opts.codexCommand ?? "codex",
    args,
    env: { [ENV_REMOTE_TOKEN]: opts.token, MP_AGENT_ID: opts.agentId, MP_HOME: opts.home },
    cwd: opts.worktree,
  };
}
