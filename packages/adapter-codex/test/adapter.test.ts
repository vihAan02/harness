import { describe, expect, it } from "vitest";
import {
  appServerArgs,
  applyPatchPaths,
  eventSlug,
  hookOverrides,
  itemToEvents,
  normalizeToolCall,
  preToolUseOutput,
  shellWord,
  stopOutput,
  textInput,
  tomlString,
  tuiLaunch,
} from "../src/index.ts";

const PATCH = [
  "*** Begin Patch",
  "*** Update File: src/auth/session.ts",
  "@@",
  "-export const ttl = 60;",
  "+export const ttl = 120;",
  "*** Update File: src/routes.ts",
  "*** Move to: src/router.ts",
  "@@",
  " export const a = 1;",
  "*** Add File: src/new.ts",
  "+export const x = 1;",
  "*** Delete File: /w/old.ts",
  "*** End Patch",
].join("\n");

describe("apply_patch", () => {
  it("finds every file a patch touches, resolving relative paths against the cwd", () => {
    expect(applyPatchPaths(PATCH, "/w")).toEqual(["/w/src/auth/session.ts", "/w/src/routes.ts", "/w/src/router.ts", "/w/src/new.ts", "/w/old.ts"]);
    expect(applyPatchPaths("no patch here")).toEqual([]);
  });
});

describe("hook payloads", () => {
  it("normalizes apply_patch, Bash, MCP and other tools", () => {
    expect(normalizeToolCall({ tool_name: "apply_patch", cwd: "/w", tool_input: { command: PATCH } })).toMatchObject({
      kind: "edit",
      tool: "apply_patch",
      paths: ["/w/src/auth/session.ts", "/w/src/routes.ts", "/w/src/router.ts", "/w/src/new.ts", "/w/old.ts"],
    });
    expect(normalizeToolCall({ tool_name: "Bash", cwd: "/w", tool_input: { command: "npm test" } })).toEqual({
      cwd: "/w",
      kind: "bash",
      tool: "Bash",
      paths: [],
      command: "npm test",
    });
    expect(normalizeToolCall({ tool_name: "mcp__multiplayer__mp_status", tool_input: {} })).toMatchObject({ kind: "mcp" });
    expect(normalizeToolCall({ tool_name: "update_plan", tool_input: { plan: [] } })).toMatchObject({ kind: "other", paths: [] });
  });

  it("converts event names to URL slugs", () => {
    expect(eventSlug("PreToolUse")).toBe("pre-tool-use");
    expect(eventSlug("SessionStart")).toBe("session-start");
    expect(eventSlug("Stop")).toBe("stop");
  });

  it("only ever denies or adds context on PreToolUse", () => {
    expect(preToolUseOutput({ decision: "allow" })).toEqual({});
    expect(preToolUseOutput({ decision: "deny", reason: "locked" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "locked" },
    });
    expect(preToolUseOutput({ decision: "allow", additionalContext: "heads up" })).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "heads up" },
    });
  });

  it("continues Codex at Stop with the reason as the next prompt", () => {
    expect(stopOutput("Answer Ria's question")).toEqual({ decision: "block", reason: "Answer Ria's question" });
    expect(stopOutput()).toEqual({});
  });
});

describe("launch", () => {
  const shim = { command: "/usr/local/bin/node", args: ["--no-deprecation", "/opt/mp/hook shim/main.ts", "codex"] };
  const mcp = { command: "/usr/local/bin/node", args: ["--no-deprecation", "/opt/mp/mcp/main.ts"] };

  it("quotes TOML and shell values safely", () => {
    expect(tomlString('a "b" \\ c')).toBe('"a \\"b\\" \\\\ c"');
    expect(shellWord("/usr/bin/node")).toBe("/usr/bin/node");
    expect(shellWord("/opt/hook shim/main.ts")).toBe("'/opt/hook shim/main.ts'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
  });

  it("builds session hook overrides with one stable command for every event", () => {
    const args = hookOverrides(shim);
    expect(args.filter((a) => a === "-c")).toHaveLength(7);
    const pre = args.find((a) => a.startsWith("hooks.PreToolUse="))!;
    expect(pre).toBe(
      `hooks.PreToolUse=[{matcher="^(Bash|apply_patch)$",hooks=[{type="command",command="/usr/local/bin/node --no-deprecation '/opt/mp/hook shim/main.ts' codex",timeout=300}]}]`,
    );
    const commands = new Set(args.filter((a) => a.startsWith("hooks.")).map((a) => /command="([^"]*)"/.exec(a)![1]));
    expect(commands.size).toBe(1);
    expect(args.join(" ")).not.toMatch(/token|port/i);
  });

  it("builds the app-server command with loopback auth, MCP and hooks", () => {
    const args = appServerArgs({ port: 4501, tokenFile: "/h/codex/a1/ws-token", shim, mcp, agentId: "a1", home: "/h" });
    expect(args.slice(0, 7)).toEqual(["app-server", "--listen", "ws://127.0.0.1:4501", "--ws-auth", "capability-token", "--ws-token-file", "/h/codex/a1/ws-token"]);
    expect(args).toContain('mcp_servers.multiplayer.command="/usr/local/bin/node"');
    expect(args).toContain('mcp_servers.multiplayer.args=["--no-deprecation","/opt/mp/mcp/main.ts"]');
    expect(args).toContain('mcp_servers.multiplayer.env={MP_AGENT_ID="a1",MP_HOME="/h"}');
  });

  it("builds the terminal UI command, with the token passed by environment name only", () => {
    const spec = tuiLaunch({ port: 4501, token: "tok", worktree: "/w", agentId: "a1", home: "/h", prompt: "Add webhooks" });
    expect(spec).toEqual({
      command: "codex",
      args: ["--remote", "ws://127.0.0.1:4501", "--remote-auth-token-env", "MP_CODEX_REMOTE_TOKEN", "Add webhooks"],
      env: { MP_CODEX_REMOTE_TOKEN: "tok", MP_AGENT_ID: "a1", MP_HOME: "/h" },
      cwd: "/w",
    });
  });
});

describe("app-server items → stream", () => {
  it("shares prompts, replies, commands and edited paths, never reasoning or diffs", () => {
    const at = 1;
    const events = [
      { type: "userMessage", id: "1", content: [{ type: "text", text: "Add Stripe webhooks" }] },
      { type: "reasoning", id: "2", summary: ["private"], content: ["private"] },
      { type: "agentMessage", id: "3", text: "Adding a handler." },
      { type: "commandExecution", id: "4", command: "npm test", status: "completed", aggregatedOutput: "5 passing\nSTRIPE_SECRET=sk_live_abcdefghijklmnop", exitCode: 0 },
      { type: "fileChange", id: "5", status: "completed", changes: [{ path: "/w/src/billing/stripe.ts", kind: {}, diff: "+secret code" }] },
      { type: "mcpToolCall", id: "6", server: "multiplayer", tool: "mp_status", status: "completed", arguments: {} },
      { type: "webSearch", id: "7" },
    ].flatMap((item) => itemToEvents(item as never, "/w", at));

    expect(events.map((e) => [e.kind, e.role ?? e.tool, e.text ?? e.input])).toEqual([
      ["message", "user", "Add Stripe webhooks"],
      ["message", "assistant", "Adding a handler."],
      ["tool_call", "Bash", "npm test"],
      ["tool_result", "Bash", undefined],
      ["file_change", "apply_patch", "src/billing/stripe.ts"],
      ["tool_call", "mcp__multiplayer__mp_status", "{}"],
    ]);
    expect(events[3]).toMatchObject({ exitCode: 0 });
    expect(events[3]!.output).toContain("5 passing");
    const all = JSON.stringify(events);
    expect(all).not.toContain("private");
    expect(all).not.toContain("sk_live");
    expect(all).not.toContain("secret code");
    expect(events[4]!.paths).toEqual(["src/billing/stripe.ts"]);
  });

  it("builds text input the app-server accepts", () => {
    expect(textInput("hi")).toEqual({ type: "text", text: "hi", text_elements: [] });
  });
});
