import type { HookDecision, ToolIntentKind } from "@mp/protocol";
import { applyPatchPaths } from "./patch.ts";

/** Codex hook events the multiplayer hooks subscribe to, as URL slugs. */
export const CODEX_EVENTS = {
  "session-start": "SessionStart",
  "user-prompt-submit": "UserPromptSubmit",
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  "permission-request": "PermissionRequest",
  stop: "Stop",
  "session-end": "SessionEnd",
} as const;

export type CodexEventSlug = keyof typeof CODEX_EVENTS;
export type CodexEventName = (typeof CODEX_EVENTS)[CodexEventSlug];

export function isCodexEventSlug(s: string): s is CodexEventSlug {
  return Object.prototype.hasOwnProperty.call(CODEX_EVENTS, s);
}

/** `PreToolUse` → `pre-tool-use` */
export function eventSlug(hookEventName: string): string {
  return hookEventName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** The subset of Codex's hook input we use (see codex-rs/hooks/schema/generated). */
export interface CodexHookPayload {
  session_id?: string;
  transcript_path?: string | null;
  cwd?: string;
  hook_event_name?: string;
  model?: string;
  turn_id?: string;
  /** SessionStart: startup | resume | clear | compact */
  source?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
  agent_id?: string;
}

export function asPayload(body: unknown): CodexHookPayload {
  return body && typeof body === "object" ? (body as CodexHookPayload) : {};
}

/** Tools PreToolUse needs to see: shell commands and file edits (apply_patch also matches Edit/Write). */
export const PRE_TOOL_MATCHER = "^(Bash|apply_patch)$";

export function toolKind(tool: string | undefined): ToolIntentKind {
  if (tool === "apply_patch") return "edit";
  if (tool === "Bash") return "bash";
  if (tool?.startsWith("mcp__")) return "mcp";
  return "other";
}

export interface NormalizedToolCall {
  cwd?: string;
  kind: ToolIntentKind;
  tool: string;
  paths: string[];
  command?: string;
}

export function normalizeToolCall(p: CodexHookPayload): NormalizedToolCall {
  const tool = p.tool_name ?? "unknown";
  const kind = toolKind(tool);
  const input = p.tool_input && typeof p.tool_input === "object" ? (p.tool_input as Record<string, unknown>) : {};
  const command = typeof input.command === "string" ? input.command : undefined;
  const base = { ...(p.cwd ? { cwd: p.cwd } : {}), kind, tool };
  if (kind === "edit") return { ...base, paths: command ? applyPatchPaths(command, p.cwd) : [] };
  return { ...base, paths: [], ...(kind === "bash" && command !== undefined ? { command } : {}) };
}

/**
 * Codex spills model-visible hook output past ~2,500 tokens to a file and shows a preview instead.
 * Keep each context well under that.
 */
export const CONTEXT_LIMIT = 8_000;

export function clampContext(text: string): string {
  if (text.length <= CONTEXT_LIMIT) return text;
  return text.slice(0, CONTEXT_LIMIT - 60) + "\n… (truncated; call mp_status or mp_inbox for the rest)";
}

export type CodexHookOutput = Record<string, unknown>;

/**
 * PreToolUse answer. We only deny or add context. Codex doesn't support `permissionDecision: "ask"`,
 * and we never return `"allow"`, so Codex's own approval flow is untouched.
 */
export function preToolUseOutput(d: HookDecision): CodexHookOutput {
  if (d.decision === "deny") {
    return {
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: clampContext(d.reason) },
    };
  }
  if (d.decision === "allow" && d.additionalContext) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: clampContext(d.additionalContext) } };
  }
  return {};
}

function contextOutput(event: CodexEventName, context: string | undefined): CodexHookOutput {
  return context ? { hookSpecificOutput: { hookEventName: event, additionalContext: clampContext(context) } } : {};
}

export const postToolUseOutput = (context?: string) => contextOutput("PostToolUse", context);
export const userPromptSubmitOutput = (context?: string) => contextOutput("UserPromptSubmit", context);
export const sessionStartOutput = (context?: string) => contextOutput("SessionStart", context);

/**
 * Stop answer. `decision: "block"` makes Codex continue with `reason` as a new prompt. Callers must
 * not do this when `stop_hook_active` is set.
 */
export function stopOutput(reason?: string): CodexHookOutput {
  return reason ? { decision: "block", reason: clampContext(reason) } : {};
}
