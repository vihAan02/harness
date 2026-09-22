import { isAbsolute, relative, sep } from "node:path";
import { redact, type AgentEvent } from "@mp/protocol";

const MAX_TEXT = 2000;
const MAX_INPUT = 300;
const MAX_OUTPUT = 300;

function clip(text: string, max: number): string {
  const t = redact(text);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Subset of the app-server v2 `ThreadItem` union we turn into stream events. */
export type CodexItem =
  | { type: "userMessage"; id: string; content: { type: string; text?: string }[] }
  | { type: "agentMessage"; id: string; text: string }
  | { type: "reasoning"; id: string }
  | { type: "plan"; id: string; text: string }
  | { type: "commandExecution"; id: string; command: string; status: string; aggregatedOutput: string | null; exitCode: number | null }
  | { type: "fileChange"; id: string; status: string; changes: { path: string; kind: unknown; diff: string }[] }
  | { type: "mcpToolCall"; id: string; server: string; tool: string; status: string; arguments: unknown; error?: unknown }
  | { type: string; id?: string };

function repoPath(worktree: string, p: string): string | undefined {
  if (!p) return undefined;
  if (!isAbsolute(p)) return p.split(sep).join("/");
  const rel = relative(worktree, p);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/**
 * Maps a completed app-server item to stream events.
 * Shared: prompts, replies, plan updates, commands with short redacted output, edited paths, MCP calls.
 * Never shared: reasoning, and file contents (diffs travel separately as the live diff).
 */
export function itemToEvents(item: CodexItem, worktree: string, at: number = Date.now()): AgentEvent[] {
  switch (item.type) {
    case "userMessage": {
      const text = (item as Extract<CodexItem, { type: "userMessage" }>).content
        .map((c) => (c.type === "text" && typeof c.text === "string" ? c.text : ""))
        .join("\n")
        .trim();
      return text ? [{ at, kind: "message", role: "user", text: clip(text, MAX_TEXT) }] : [];
    }
    case "agentMessage": {
      const text = (item as Extract<CodexItem, { type: "agentMessage" }>).text.trim();
      return text ? [{ at, kind: "message", role: "assistant", text: clip(text, MAX_TEXT) }] : [];
    }
    case "plan": {
      const text = (item as Extract<CodexItem, { type: "plan" }>).text.trim();
      return text ? [{ at, kind: "message", role: "assistant", text: clip(`Plan:\n${text}`, MAX_TEXT) }] : [];
    }
    case "commandExecution": {
      const c = item as Extract<CodexItem, { type: "commandExecution" }>;
      const call: AgentEvent = { at, kind: "tool_call", tool: "Bash", input: clip(c.command, MAX_INPUT) };
      const result: AgentEvent = {
        at,
        kind: "tool_result",
        tool: "Bash",
        ...(c.exitCode !== null ? { exitCode: c.exitCode } : {}),
        ...(c.aggregatedOutput?.trim() ? { output: clip(c.aggregatedOutput.trim(), MAX_OUTPUT) } : {}),
      };
      return [call, result];
    }
    case "fileChange": {
      const f = item as Extract<CodexItem, { type: "fileChange" }>;
      const paths = f.changes.map((ch) => repoPath(worktree, ch.path)).filter((p): p is string => !!p);
      return [
        {
          at,
          kind: "file_change",
          tool: "apply_patch",
          input: paths.length ? paths.join(", ") : "(outside the worktree)",
          ...(paths.length ? { paths: paths.slice(0, 100) } : {}),
          ...(f.status !== "completed" ? { output: f.status } : {}),
        },
      ];
    }
    case "mcpToolCall": {
      const m = item as Extract<CodexItem, { type: "mcpToolCall" }>;
      return [
        {
          at,
          kind: "tool_call",
          tool: `mcp__${m.server}__${m.tool}`,
          input: clip(JSON.stringify(m.arguments ?? {}), MAX_INPUT),
          ...(m.status !== "completed" ? { output: m.status } : {}),
        },
      ];
    }
    default:
      // reasoning, web searches, compaction markers and anything new: not shared.
      return [];
  }
}

/** App-server `UserInput` for a plain text message. */
export function textInput(text: string): { type: "text"; text: string; text_elements: [] } {
  return { type: "text", text, text_elements: [] };
}
