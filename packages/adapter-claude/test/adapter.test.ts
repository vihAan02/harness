import { describe, expect, it } from "vitest";
import {
  buildLaunch,
  CONTEXT_LIMIT,
  initialPrompt,
  mcpConfig,
  normalizeToolCall,
  pluginFiles,
  preToolUseOutput,
  redact,
  sessionStartOutput,
  stopOutput,
  TranscriptParser,
} from "../src/index.ts";

describe("hook payloads", () => {
  it("maps file tools to edits with their absolute paths", () => {
    expect(
      normalizeToolCall({ tool_name: "Edit", cwd: "/w", tool_input: { file_path: "/w/src/a.ts", old_string: "x", new_string: "y" } }),
    ).toEqual({ cwd: "/w", kind: "edit", tool: "Edit", paths: ["/w/src/a.ts"] });
    expect(normalizeToolCall({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/w/nb.ipynb" } })).toMatchObject({
      kind: "edit",
      paths: ["/w/nb.ipynb"],
    });
    expect(normalizeToolCall({ tool_name: "Bash", tool_input: { command: "npm test" } })).toMatchObject({ kind: "bash", command: "npm test" });
    expect(normalizeToolCall({ tool_name: "mcp__multiplayer__mp_status", tool_input: {} })).toMatchObject({ kind: "mcp" });
    expect(normalizeToolCall({ tool_name: "Read", tool_input: { file_path: "/w/a" } })).toMatchObject({ kind: "other" });
  });

  it("never returns permissionDecision 'allow': allows stay silent so Claude's own prompts still apply", () => {
    expect(preToolUseOutput({ decision: "allow" })).toEqual({});
    expect(preToolUseOutput({ decision: "allow", additionalContext: "heads up" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "heads up" },
    });
    expect(preToolUseOutput({ decision: "deny", reason: "locked" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "locked" },
    });
    expect(JSON.stringify(preToolUseOutput({ decision: "allow", additionalContext: "x" }))).not.toContain('"allow"');
  });

  it("keeps hook context under Claude Code's 10,000 character cap", () => {
    const out = stopOutput("x".repeat(20_000)) as { hookSpecificOutput: { additionalContext: string } };
    expect(out.hookSpecificOutput.additionalContext.length).toBeLessThanOrEqual(CONTEXT_LIMIT);
    expect(out.hookSpecificOutput.additionalContext).toContain("truncated");
    expect(sessionStartOutput(undefined, "auth-refactor")).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", sessionTitle: "auth-refactor" } });
    expect(stopOutput()).toEqual({});
  });
});

describe("plugin and launch", () => {
  it("generates a plugin whose hooks call the daemon over HTTP with env-provided headers", () => {
    const files = pluginFiles({ port: 47800 });
    expect(JSON.parse(files[".claude-plugin/plugin.json"]!)).toMatchObject({ name: "multiplayer" });
    const { hooks } = JSON.parse(files["hooks/hooks.json"]!);
    expect(Object.keys(hooks).sort()).toEqual(
      ["PermissionRequest", "PostToolUse", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"].sort(),
    );
    const pre = hooks.PreToolUse[0];
    expect(pre.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell");
    expect(pre.hooks[0]).toEqual({
      type: "http",
      url: "http://127.0.0.1:47800/v1/hooks/claude/pre-tool-use",
      timeout: 300,
      headers: { Authorization: "Bearer $MP_DAEMON_TOKEN", "X-MP-Agent-Id": "$MP_AGENT_ID" },
      allowedEnvVars: ["MP_DAEMON_TOKEN", "MP_AGENT_ID"],
    });
    // PostToolUse runs for every tool so messages reach the agent between any two steps.
    expect(hooks.PostToolUse[0].matcher).toBeUndefined();
    // The token is never written into the plugin files.
    expect(files["hooks/hooks.json"]).not.toMatch(/Bearer [A-Za-z0-9]{10,}/);
  });

  it("builds the MCP config and the launch command with channels opted in", () => {
    const cfg = mcpConfig({ agentId: "a1", home: "/h", channels: true, mcp: { command: "/usr/bin/node", args: ["/mcp/main.ts"] } });
    expect(cfg).toEqual({
      mcpServers: {
        multiplayer: { type: "stdio", command: "/usr/bin/node", args: ["/mcp/main.ts"], env: { MP_AGENT_ID: "a1", MP_HOME: "/h", MP_CHANNELS: "1" } },
      },
    });
    const spec = buildLaunch({
      worktree: "/w",
      agentId: "a1",
      token: "tok",
      home: "/h",
      pluginDir: "/h/claude/plugin",
      mcpConfigPath: "/h/claude/agents/a1/mcp.json",
      channels: true,
      prompt: initialPrompt("Move the auth middleware"),
    });
    expect(spec.command).toBe("claude");
    expect(spec.cwd).toBe("/w");
    expect(spec.args.slice(0, 6)).toEqual([
      "--plugin-dir",
      "/h/claude/plugin",
      "--mcp-config",
      "/h/claude/agents/a1/mcp.json",
      "--dangerously-load-development-channels",
      "server:multiplayer",
    ]);
    expect(spec.args[6]).toContain("Move the auth middleware");
    expect(spec.env).toEqual({ MP_AGENT_ID: "a1", MP_DAEMON_TOKEN: "tok", MP_HOME: "/h" });
    expect(buildLaunch({ ...spec, worktree: "/w", agentId: "a1", token: "t", home: "/h", pluginDir: "p", mcpConfigPath: "m", channels: false }).args).not.toContain(
      "--dangerously-load-development-channels",
    );
  });
});

describe("transcript → stream", () => {
  const line = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type, timestamp: "2026-09-22T10:00:00.000Z", message: { role: type, content }, ...extra });

  it("shares prompts, replies, tool calls and short results, but never thinking or file contents", () => {
    const p = new TranscriptParser("/w");
    const events = [
      line("user", "Move the auth middleware"),
      line("assistant", [
        { type: "thinking", thinking: "private reasoning", signature: "s" },
        { type: "text", text: "I'll start with session.ts." },
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/src/auth/session.ts" } },
      ]),
      line("user", [{ type: "tool_result", tool_use_id: "t1", content: "line1\nline2\nSECRET=hunter22222" }]),
      line("assistant", [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "npm test" } }]),
      line("user", [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "3 passing" }], is_error: false }]),
      line("assistant", [{ type: "tool_use", id: "t3", name: "Write", input: { file_path: "/w/src/new.ts", content: "export const x = 1;" } }]),
    ].flatMap((l) => p.parse(l));

    expect(events.map((e) => [e.kind, e.role ?? e.tool, e.text ?? e.input ?? e.output])).toEqual([
      ["message", "user", "Move the auth middleware"],
      ["message", "assistant", "I'll start with session.ts."],
      ["tool_call", "Read", "src/auth/session.ts"],
      ["tool_result", "Read", "(3 lines)"],
      ["tool_call", "Bash", "npm test"],
      ["tool_result", "Bash", "3 passing"],
      ["tool_call", "Write", "src/new.ts"],
    ]);
    expect(events[2]!.paths).toEqual(["src/auth/session.ts"]);
    const all = JSON.stringify(events);
    expect(all).not.toContain("private reasoning");
    expect(all).not.toContain("hunter2");
    expect(all).not.toContain("export const x");
    expect(events[0]!.at).toBe(Date.parse("2026-09-22T10:00:00.000Z"));
  });

  it("skips subagent side chains, system reminders and junk", () => {
    const p = new TranscriptParser("/w");
    expect(p.parse(line("assistant", [{ type: "text", text: "sub" }], { isSidechain: true }))).toEqual([]);
    expect(p.parse(line("user", "<system-reminder>x</system-reminder>"))).toEqual([]);
    expect(p.parse("not json")).toEqual([]);
    expect(p.parse(JSON.stringify({ type: "file-history-snapshot" }))).toEqual([]);
  });

  it("hides paths outside the worktree", () => {
    const p = new TranscriptParser("/w");
    const [e] = p.parse(line("assistant", [{ type: "tool_use", id: "t", name: "Edit", input: { file_path: "/etc/hosts" } }]));
    expect(e).toMatchObject({ kind: "tool_call", input: "(outside the worktree)" });
    expect(e!.paths).toBeUndefined();
  });
});

describe("redact", () => {
  it.each([
    ["key sk-ant-api03-abcdefghijklmnopqrstuvwxyz", "key [redacted]"],
    ["export GITHUB=ghp_abcdefghijklmnopqrstuvwxyz123456", "export GITHUB=[redacted]"],
    ["AWS AKIAABCDEFGHIJKLMNOP here", "AWS [redacted] here"],
    ["DB_PASSWORD=s3cr3tpass", "DB_PASSWORD=[redacted]"],
    ['"api_key": "abcdef123456"', '"api_key=[redacted]"'],
    ["Authorization: Bearer abcdef1234567890", "Authorization: Bearer [redacted]"],
    ["clientSecret: 'abcdef123456'", "clientSecret=[redacted]'"],
    ["Author: Samantha Jones", "Author: Samantha Jones"],
    ["plain text stays", "plain text stays"],
  ])("%s", (input, expected) => {
    expect(redact(input)).toBe(expected);
  });
});
