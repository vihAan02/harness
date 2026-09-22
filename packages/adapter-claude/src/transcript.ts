import { isAbsolute, relative, sep } from "node:path";
import type { AgentEvent } from "@mp/protocol";

const MAX_TEXT = 2000;
const MAX_INPUT = 300;
const MAX_OUTPUT = 300;

/** Tools whose results are file contents or search hits: we report the activity, never the content. */
const CONTENT_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead", "LS"]);

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Stripe/Anthropic-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  // KEY=value and "key": "value" where the key names a credential (DB_PASSWORD, api_key, clientSecret, …).
  /\b([A-Za-z0-9_]*?(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|authorization|credential|private[_-]?key)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?(?!Bearer\b|\[redacted\])[^\s"']{6,}/gi,
];

/** Best-effort removal of obvious credentials before anything leaves the machine. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m: string, key?: unknown) => {
      if (typeof key === "string" && m.startsWith(key)) return `${key}=[redacted]`;
      return m.startsWith("Bearer") ? "Bearer [redacted]" : "[redacted]";
    });
  }
  return out;
}

/** Redacts before truncating, so a secret cut in half at the limit can't slip past the patterns. */
function clip(text: string, max: number): string {
  const t = redact(text);
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

interface Block {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface Line {
  type?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: { content?: unknown };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Turns Claude Code transcript lines into stream events for the room.
 * Shared: the user's prompts, Claude's visible replies, tool calls, and short, redacted results.
 * Never shared: thinking blocks, file contents from reads and searches, or subagent side chains.
 */
export class TranscriptParser {
  private readonly worktree: string;
  private readonly toolNames = new Map<string, string>();

  constructor(worktree: string) {
    this.worktree = worktree;
  }

  private repoPath(p: unknown): string | undefined {
    if (typeof p !== "string" || !p) return undefined;
    if (!isAbsolute(p)) return p.split(sep).join("/");
    const rel = relative(this.worktree, p);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return rel.split(sep).join("/");
  }

  private describeInput(name: string, input: Record<string, unknown>): { input?: string; paths?: string[] } {
    const path = this.repoPath(input.file_path ?? input.notebook_path);
    if (path) return { input: path, paths: [path] };
    if (typeof input.file_path === "string" || typeof input.notebook_path === "string") return { input: "(outside the worktree)" };
    if (typeof input.command === "string") return { input: clip(input.command, MAX_INPUT) };
    if (typeof input.pattern === "string") return { input: clip(input.pattern, MAX_INPUT) };
    if (typeof input.url === "string") return { input: clip(input.url, MAX_INPUT) };
    if (typeof input.description === "string") return { input: clip(input.description, MAX_INPUT) };
    if (name.startsWith("mcp__")) return { input: clip(JSON.stringify(input), MAX_INPUT) };
    return {};
  }

  /** Parses one JSONL line. Malformed or irrelevant lines yield nothing. */
  parse(raw: string): AgentEvent[] {
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      return [];
    }
    if (line.isSidechain) return [];
    if (line.type !== "user" && line.type !== "assistant") return [];
    const at = line.timestamp ? Date.parse(line.timestamp) || Date.now() : Date.now();
    const content = line.message?.content;
    const out: AgentEvent[] = [];

    if (typeof content === "string") {
      if (line.type === "user" && content.trim() && !content.startsWith("<")) {
        out.push({ at, kind: "message", role: "user", text: clip(content.trim(), MAX_TEXT) });
      }
      return out;
    }
    if (!Array.isArray(content)) return out;

    for (const b of content as Block[]) {
      switch (b.type) {
        case "text":
          if (b.text?.trim()) {
            out.push({ at, kind: "message", role: line.type === "assistant" ? "assistant" : "user", text: clip(b.text.trim(), MAX_TEXT) });
          }
          break;
        case "tool_use": {
          const name = b.name ?? "tool";
          if (b.id) this.toolNames.set(b.id, name);
          out.push({ at, kind: "tool_call", tool: name, ...this.describeInput(name, b.input ?? {}) });
          break;
        }
        case "tool_result": {
          const name = (b.tool_use_id && this.toolNames.get(b.tool_use_id)) || "tool";
          if (b.tool_use_id) this.toolNames.delete(b.tool_use_id);
          const text = resultText(b.content);
          const event: AgentEvent = { at, kind: "tool_result", tool: name, ...(b.is_error ? { exitCode: 1 } : {}) };
          if (CONTENT_TOOLS.has(name)) {
            const lines = text ? text.split("\n").length : 0;
            event.output = `(${lines} line${lines === 1 ? "" : "s"})`;
          } else if (text) {
            event.output = clip(text.trim(), MAX_OUTPUT);
          }
          out.push(event);
          break;
        }
        // "thinking" and anything else: never shared.
      }
    }
    return out;
  }
}
