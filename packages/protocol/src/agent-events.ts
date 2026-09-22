import { z } from "zod";
import { AgentStatus, Id, RepoPath, Timestamp, Vendor } from "./entities.ts";

export const AgentEventKind = z.enum([
  "message",
  "reasoning_summary",
  "tool_call",
  "tool_result",
  "command",
  "file_change",
  "status",
  "approval_request",
]);
export type AgentEventKind = z.infer<typeof AgentEventKind>;

/**
 * One entry in an agent's live stream, normalized across vendors.
 * Adapters map Claude transcript lines and Codex app-server notifications onto this shape.
 */
export const AgentEvent = z.object({
  at: Timestamp,
  kind: AgentEventKind,
  text: z.string().max(8000).optional(),
  tool: z.string().max(200).optional(),
  /** Summarized tool input (e.g. the command, or the edited path). */
  input: z.string().max(4000).optional(),
  /** Truncated tool output. */
  output: z.string().max(8000).optional(),
  paths: z.array(RepoPath).max(100).optional(),
  exitCode: z.number().int().optional(),
  status: AgentStatus.optional(),
  turnId: z.string().max(128).optional(),
});
export type AgentEvent = z.infer<typeof AgentEvent>;

export const ToolIntentKind = z.enum(["edit", "bash", "mcp", "other"]);
export type ToolIntentKind = z.infer<typeof ToolIntentKind>;

/** A vendor-neutral view of a hook call, produced by an adapter's `normalizeHook`. */
export const ToolIntent = z.object({
  agentId: Id,
  vendor: Vendor,
  sessionId: z.string().max(200),
  phase: z.enum(["pre", "post"]),
  kind: ToolIntentKind,
  tool: z.string().max(200),
  /** Repo-relative paths the call touches (edits) or is predicted to touch. */
  paths: z.array(RepoPath).max(500),
  command: z.string().max(8000).optional(),
  cwd: z.string().max(4096),
});
export type ToolIntent = z.infer<typeof ToolIntent>;

/** What the policy engine tells an adapter to answer a hook with. */
export type HookDecision =
  | { decision: "allow"; additionalContext?: string }
  | { decision: "deny"; reason: string; additionalContext?: string }
  /** Hold the tool call until `until` resolves (a freeze), then re-evaluate. */
  | { decision: "hold"; reviewId: string; reason: string };
