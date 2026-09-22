import type { HookDecision, ToolIntentKind } from "@mp/protocol";

/** Claude Code hook events the multiplayer plugin subscribes to, as URL slugs. */
export const CLAUDE_EVENTS = {
  "session-start": "SessionStart",
  "user-prompt-submit": "UserPromptSubmit",
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  "permission-request": "PermissionRequest",
  stop: "Stop",
  "session-end": "SessionEnd",
} as const;

export type ClaudeEventSlug = keyof typeof CLAUDE_EVENTS;
export type ClaudeEventName = (typeof CLAUDE_EVENTS)[ClaudeEventSlug];

export function isClaudeEventSlug(s: string): s is ClaudeEventSlug {
  return Object.prototype.hasOwnProperty.call(CLAUDE_EVENTS, s);
}

/** The subset of Claude Code's hook input we use. Parsed leniently: unknown fields are ignored. */
export interface ClaudeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  /** SessionStart: startup | resume | clear | compact | fork */
  source?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Stop: true when Claude is already continuing because of a Stop hook. */
  stop_hook_active?: boolean;
  /** Present when the hook fires inside a subagent. */
  agent_id?: string;
}

export function asPayload(body: unknown): ClaudeHookPayload {
  return body && typeof body === "object" ? (body as ClaudeHookPayload) : {};
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);

/** Tools the PreToolUse hook needs to see. Everything else runs without a round trip to the daemon. */
export const PRE_TOOL_MATCHER = [...EDIT_TOOLS, ...SHELL_TOOLS].join("|");

export function toolKind(tool: string | undefined): ToolIntentKind {
  if (!tool) return "other";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (SHELL_TOOLS.has(tool)) return "bash";
  if (tool.startsWith("mcp__")) return "mcp";
  return "other";
}

/** Vendor-neutral view of a Claude tool hook (matches mp-daemon's HookInput). */
export interface NormalizedToolCall {
  cwd?: string;
  kind: ToolIntentKind;
  tool: string;
  paths: string[];
  command?: string;
}

export function normalizeToolCall(p: ClaudeHookPayload): NormalizedToolCall {
  const tool = p.tool_name ?? "unknown";
  const input = p.tool_input ?? {};
  const paths: string[] = [];
  for (const key of ["file_path", "notebook_path"]) {
    const v = input[key];
    if (typeof v === "string" && v) paths.push(v);
  }
  const command = typeof input.command === "string" ? input.command : undefined;
  return {
    ...(p.cwd ? { cwd: p.cwd } : {}),
    kind: toolKind(tool),
    tool,
    paths,
    ...(command !== undefined ? { command } : {}),
  };
}

/** Claude Code caps hook-provided context at 10,000 characters; stay under it with room to spare. */
export const CONTEXT_LIMIT = 9_500;

export function clampContext(text: string): string {
  if (text.length <= CONTEXT_LIMIT) return text;
  return text.slice(0, CONTEXT_LIMIT - 60) + "\n… (truncated; call mp_status or mp_inbox for the rest)";
}

export type ClaudeHookOutput = Record<string, unknown>;

/**
 * PreToolUse answer. We only ever deny or add context: an allow is expressed as no decision at all,
 * so Claude's own permission prompts still apply. We never return permissionDecision "allow".
 */
export function preToolUseOutput(d: HookDecision): ClaudeHookOutput {
  if (d.decision === "deny") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: clampContext(d.reason),
        ...(d.additionalContext ? { additionalContext: clampContext(d.additionalContext) } : {}),
      },
    };
  }
  if (d.decision === "allow" && d.additionalContext) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: clampContext(d.additionalContext) } };
  }
  return {};
}

function contextOutput(event: ClaudeEventName, context: string | undefined, extra: Record<string, unknown> = {}): ClaudeHookOutput {
  if (!context && !Object.keys(extra).length) return {};
  return { hookSpecificOutput: { hookEventName: event, ...(context ? { additionalContext: clampContext(context) } : {}), ...extra } };
}

export function postToolUseOutput(context?: string): ClaudeHookOutput {
  return contextOutput("PostToolUse", context);
}

export function userPromptSubmitOutput(context?: string): ClaudeHookOutput {
  return contextOutput("UserPromptSubmit", context);
}

export function sessionStartOutput(context?: string, sessionTitle?: string): ClaudeHookOutput {
  return contextOutput("SessionStart", context, sessionTitle ? { sessionTitle } : {});
}

/**
 * Stop answer. Additional context keeps Claude going (to handle an urgent message) through Claude
 * Code's own loop protection; callers must not continue again when `stop_hook_active` is set.
 */
export function stopOutput(context?: string): ClaudeHookOutput {
  return contextOutput("Stop", context);
}
