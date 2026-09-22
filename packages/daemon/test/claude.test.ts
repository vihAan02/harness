import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PLAN_REQUIRED, startServer, type Daemon, type LocalAgent, type ServerHandle } from "../src/index.ts";
import { cleanupTmp, eventually, LOOPBACK_INVITE, LoopbackRelay, makeDaemon, makeTeamRepos, ROOM_ID, tmp } from "../src/testing/index.ts";

const TOKEN = "claude-hook-token-xxxxxxxxxxxxxxxx";
let relay: LoopbackRelay;
let samD: Daemon;
let riaD: Daemon;
let http: ServerHandle;
let claude: LocalAgent;
let codex: LocalAgent;

beforeEach(async () => {
  const repos = await makeTeamRepos();
  relay = new LoopbackRelay(ROOM_ID);
  samD = await makeDaemon(relay, "Sam", { claude: { transcriptPollMs: 20, mcp: { command: "/usr/local/bin/node", args: ["/opt/mp/mcp/main.ts"] } } });
  riaD = await makeDaemon(relay, "Ria");
  await samD.joinRoom({ repoPath: repos.sam, invite: LOOPBACK_INVITE });
  await riaD.joinRoom({ repoPath: repos.ria, invite: LOOPBACK_INVITE });
  claude = await samD.createAgent({ repoPath: repos.sam, name: "auth-refactor", vendor: "claude", task: "Move the auth middleware" });
  codex = await riaD.createAgent({ repoPath: repos.ria, name: "billing", vendor: "codex" });
  http = await startServer(samD, { port: 0, token: TOKEN });
  await samD.home.writeDaemonInfo({ pid: process.pid, port: http.port, token: TOKEN, startedAt: Date.now() });
});

afterEach(async () => {
  await http.close();
  await samD.stop();
  await riaD.stop();
  await cleanupTmp();
});

/** Posts a hook exactly the way Claude Code's HTTP hooks do. */
async function hook(event: string, payload: Record<string, unknown>, opts: { agentHeader?: string | null } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", authorization: `Bearer ${TOKEN}` };
  const agentHeader = opts.agentHeader === undefined ? claude.id : opts.agentHeader;
  if (agentHeader !== null) headers["x-mp-agent-id"] = agentHeader;
  const res = await fetch(`http://127.0.0.1:${http.port}/v1/hooks/claude/${event}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ session_id: "sess-1", transcript_path: "/nonexistent", cwd: claude.worktree, ...payload }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

const edit = (rel: string) => hook("pre-tool-use", { hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(claude.worktree, rel), old_string: "a", new_string: "b" } });

describe("Claude hooks", () => {
  it("SessionStart briefs the agent on the room and names the session", async () => {
    await riaD.tool(codex.id, "plan", { title: "Stripe webhooks", steps: ["Add handler"] });
    const out = await hook("session-start", { hook_event_name: "SessionStart", source: "startup" });
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.sessionTitle).toBe("auth-refactor");
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain(`You are "auth-refactor" (agent id ${claude.id})`);
    expect(ctx).toContain("Your task: Move the auth middleware");
    expect(ctx).toContain("billing (Codex · Ria");
    expect(ctx).toContain("Stripe webhooks");
    expect(ctx).toContain("publish your plan with mp_plan");
  });

  it("PreToolUse denies without a plan, stays silent on allow, and explains locks", async () => {
    expect(await edit("src/auth/session.ts")).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: PLAN_REQUIRED },
    });
    await samD.tool(claude.id, "plan", { title: "Auth refactor", steps: ["Move middleware"] });
    // Allowed: no decision at all, so Claude's own permission prompt still applies.
    expect(await edit("src/auth/session.ts")).toEqual({});

    await riaD.tool(codex.id, "plan", { title: "Webhooks", steps: [] });
    await riaD.preToolUse({ agentId: codex.id, kind: "edit", tool: "Edit", paths: [join(codex.worktree, "src/routes.ts")] });
    const denied = await edit("src/routes.ts");
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("Ria's billing (Codex");
  });

  it("finds the agent from cwd when the agent header is missing, and ignores sessions it doesn't manage", async () => {
    expect((await hook("pre-tool-use", { tool_name: "Write", tool_input: { file_path: join(claude.worktree, "x.ts"), content: "" } }, { agentHeader: null })).hookSpecificOutput.permissionDecision).toBe("deny");
    const elsewhere = await tmp("not-an-agent");
    expect(await hook("pre-tool-use", { cwd: elsewhere, tool_name: "Write", tool_input: { file_path: join(elsewhere, "x") } }, { agentHeader: null })).toEqual({});
    expect(await hook("session-start", { cwd: elsewhere, source: "startup" }, { agentHeader: "" })).toEqual({});
  });

  it("PostToolUse and UserPromptSubmit deliver new messages once", async () => {
    await riaD.tool(codex.id, "message", { to: claude.id, body: "I'm renaming routes.ts" });
    const post = await hook("post-tool-use", { tool_name: "Read", tool_input: { file_path: join(claude.worktree, "README.md") }, tool_response: {} });
    expect(post.hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUse" });
    expect(post.hookSpecificOutput.additionalContext).toContain("from Ria's billing (Codex): I'm renaming routes.ts");
    expect(await hook("post-tool-use", { tool_name: "Read", tool_input: {} })).toEqual({});

    await riaD.tool(codex.id, "message", { to: claude.id, kind: "fyi", body: "done" });
    const prompt = await hook("user-prompt-submit", { prompt: "continue" });
    expect(prompt.hookSpecificOutput.additionalContext).toContain("[fyi] from Ria's billing (Codex): done");
  });

  it("Stop keeps Claude going only for messages that need a reply, and never twice in a row", async () => {
    await riaD.tool(codex.id, "message", { to: claude.id, kind: "fyi", body: "just so you know" });
    expect(await hook("stop", { stop_hook_active: false, last_assistant_message: "done" })).toEqual({});

    await riaD.tool(codex.id, "message", { to: claude.id, kind: "question", body: "Can I take src/routes.ts?" });
    expect(await hook("stop", { stop_hook_active: true })).toEqual({});
    const out = await hook("stop", { stop_hook_active: false });
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "Stop" });
    expect(out.hookSpecificOutput.additionalContext).toContain("[question] from Ria's billing (Codex): Can I take src/routes.ts?");
    expect(out.hookSpecificOutput.additionalContext).toContain("mp_answer");
  });

  it("drives presence: waiting for permission, then idle when Claude stops", async () => {
    await hook("permission-request", { tool_name: "Bash", tool_input: { command: "rm -rf build" } });
    await eventually(() => riaD.link(ROOM_ID).mirror.state.agents.get(claude.id)?.status === "waiting_permission");
    await hook("stop", { stop_hook_active: false });
    await eventually(() => riaD.link(ROOM_ID).mirror.state.agents.get(claude.id)?.status === "idle");
  });

  it("fails open: a malformed payload gets an empty answer, not an error", async () => {
    const res = await fetch(`http://127.0.0.1:${http.port}/v1/hooks/claude/pre-tool-use`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-mp-agent-id": claude.id },
      body: "{not json",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });
});

describe("transcript streaming", () => {
  it("streams the session's transcript into the room, without thinking", async () => {
    const transcript = join(await tmp("transcript"), "sess-1.jsonl");
    await writeFile(transcript, "");
    await hook("session-start", { source: "startup", transcript_path: transcript });

    const lines = [
      { type: "user", timestamp: new Date().toISOString(), message: { role: "user", content: "Move the auth middleware" } },
      {
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret plan", signature: "x" },
            { type: "text", text: "Starting with session.ts" },
            { type: "tool_use", id: "t1", name: "Edit", input: { file_path: join(claude.worktree, "src/auth/session.ts"), old_string: "a", new_string: "b" } },
          ],
        },
      },
    ];
    // Written in two chunks, the second one splitting a line, the way an async writer might.
    const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    await appendFile(transcript, text.slice(0, 50));
    await appendFile(transcript, text.slice(50));

    const stream = await eventually(() => {
      const s = riaD.link(ROOM_ID).mirror.state.streams.get(claude.id) ?? [];
      return s.length >= 3 ? s : null;
    });
    expect(stream.map((e) => [e.kind, e.role ?? e.tool, e.text ?? e.input])).toEqual([
      ["message", "user", "Move the auth middleware"],
      ["message", "assistant", "Starting with session.ts"],
      ["tool_call", "Edit", "src/auth/session.ts"],
    ]);
    expect(JSON.stringify(stream)).not.toContain("secret plan");
  });

  it("does not replay history when a session resumes", async () => {
    const transcript = join(await tmp("transcript"), "sess-2.jsonl");
    await writeFile(transcript, JSON.stringify({ type: "user", message: { content: "old prompt" } }) + "\n");
    await hook("session-start", { source: "resume", session_id: "sess-2", transcript_path: transcript });
    await appendFile(transcript, JSON.stringify({ type: "user", message: { content: "new prompt" } }) + "\n");
    const stream = await eventually(() => {
      const s = riaD.link(ROOM_ID).mirror.state.streams.get(claude.id) ?? [];
      return s.length ? s : null;
    });
    expect(stream.map((e) => e.text)).toEqual(["new prompt"]);
  });
});

describe("launch", () => {
  it("writes the plugin and MCP config and returns the command the IDE runs", async () => {
    const res = await fetch(`http://127.0.0.1:${http.port}/v1/agents/${claude.id}/launch/claude`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "Move the auth middleware" }),
    });
    expect(res.status).toBe(200);
    const spec = (await res.json()) as { command: string; args: string[]; env: Record<string, string>; cwd: string };
    const pluginDir = samD.home.path("claude", "plugin");
    const mcpPath = samD.home.path("claude", "agents", claude.id, "mcp.json");

    expect(spec).toEqual({
      command: "claude",
      args: ["--plugin-dir", pluginDir, "--mcp-config", mcpPath, "--dangerously-load-development-channels", "server:multiplayer", "Move the auth middleware"],
      env: { MP_AGENT_ID: claude.id, MP_DAEMON_TOKEN: TOKEN, MP_HOME: samD.home.dir },
      cwd: claude.worktree,
    });

    const hooks = JSON.parse(await readFile(join(pluginDir, "hooks/hooks.json"), "utf8")).hooks;
    expect(hooks.PreToolUse[0].hooks[0].url).toBe(`http://127.0.0.1:${http.port}/v1/hooks/claude/pre-tool-use`);
    expect(await readFile(join(pluginDir, "hooks/hooks.json"), "utf8")).not.toContain(TOKEN);
    expect(JSON.parse(await readFile(mcpPath, "utf8"))).toEqual({
      mcpServers: {
        multiplayer: {
          type: "stdio",
          command: "/usr/local/bin/node",
          args: ["/opt/mp/mcp/main.ts"],
          env: { MP_AGENT_ID: claude.id, MP_HOME: samD.home.dir, MP_CHANNELS: "1" },
        },
      },
    });
  });
});
