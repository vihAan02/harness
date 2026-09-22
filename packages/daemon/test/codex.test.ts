import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type Daemon, type LocalAgent, type ServerHandle } from "../src/index.ts";
import { cleanupTmp, eventually, LOOPBACK_INVITE, LoopbackRelay, makeDaemon, makeTeamRepos, ROOM_ID, sleep } from "../src/testing/index.ts";
import { FakeAppServer } from "./fake-app-server.ts";

const TOKEN = "codex-hook-token-xxxxxxxxxxxxxxxxx";
let relay: LoopbackRelay;
let samD: Daemon;
let riaD: Daemon;
let http: ServerHandle;
let codex: LocalAgent;
let claude: LocalAgent;
let fakes: FakeAppServer[];

beforeEach(async () => {
  fakes = [];
  const repos = await makeTeamRepos();
  relay = new LoopbackRelay(ROOM_ID);
  samD = await makeDaemon(relay, "Sam", {
    feedAckTimeoutMs: 100,
    codex: {
      startAppServer: FakeAppServer.starter(fakes),
      attachPollMs: 20,
      shim: { command: "/usr/local/bin/node", args: ["--no-deprecation", "/opt/mp/hook-shim/main.ts", "codex"] },
      mcp: { command: "/usr/local/bin/node", args: ["--no-deprecation", "/opt/mp/mcp/main.ts"] },
    },
  });
  riaD = await makeDaemon(relay, "Ria");
  await samD.joinRoom({ repoPath: repos.sam, invite: LOOPBACK_INVITE });
  await riaD.joinRoom({ repoPath: repos.ria, invite: LOOPBACK_INVITE });
  codex = await samD.createAgent({ repoPath: repos.sam, name: "billing", vendor: "codex", task: "Stripe webhooks" });
  claude = await riaD.createAgent({ repoPath: repos.ria, name: "auth-refactor", vendor: "claude" });
  http = await startServer(samD, { port: 0, token: TOKEN });
  await samD.home.writeDaemonInfo({ pid: process.pid, port: http.port, token: TOKEN, startedAt: Date.now() });
});

afterEach(async () => {
  await http.close();
  await samD.stop();
  await riaD.stop();
  await cleanupTmp();
});

async function launch() {
  const res = await fetch(`http://127.0.0.1:${http.port}/v1/agents/${codex.id}/launch/codex`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ prompt: "Add Stripe webhooks" }),
  });
  expect(res.status).toBe(200);
  return { spec: (await res.json()) as { command: string; args: string[]; env: Record<string, string>; cwd: string }, fake: fakes[0]! };
}

async function hook(event: string, payload: Record<string, unknown>) {
  const res = await fetch(`http://127.0.0.1:${http.port}/v1/hooks/codex/${event}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", "x-mp-agent-id": codex.id },
    body: JSON.stringify({ session_id: "thr_1", cwd: codex.worktree, model: "gpt", permission_mode: "default", transcript_path: null, ...payload }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, any>;
}

describe("launch", () => {
  it("starts a token-protected app-server with MCP and hooks, and returns the terminal UI command", async () => {
    const { spec, fake } = await launch();
    const start = fake.lastStartSpec!;
    expect(start.command).toBe("codex");
    expect(start.cwd).toBe(codex.worktree);
    expect(start.env).toEqual({ MP_AGENT_ID: codex.id, MP_HOME: samD.home.dir });
    expect(start.args.slice(0, 5)).toEqual(["app-server", "--listen", `ws://127.0.0.1:${start.port}`, "--ws-auth", "capability-token"]);
    expect(start.args).toContain(`mcp_servers.multiplayer.env={MP_AGENT_ID="${codex.id}",MP_HOME="${samD.home.dir}"}`);
    expect(start.args.some((a) => a.startsWith("hooks.PreToolUse="))).toBe(true);

    const tokenFile = samD.home.path("codex", codex.id, "ws-token");
    expect(start.args).toContain(tokenFile);
    expect(await readFile(tokenFile, "utf8")).toBe(start.token);
    expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);

    expect(spec).toEqual({
      command: "codex",
      args: ["--remote", `ws://127.0.0.1:${start.port}`, "--remote-auth-token-env", "MP_CODEX_REMOTE_TOKEN", "Add Stripe webhooks"],
      env: { MP_CODEX_REMOTE_TOKEN: start.token, MP_AGENT_ID: codex.id, MP_HOME: samD.home.dir },
      cwd: codex.worktree,
    });
    // The daemon connected and did the app-server handshake.
    expect(fake.sent("initialize")[0]?.params.clientInfo.name).toBe("multiplayer_daemon");
    expect(fake.sent("initialized")).toHaveLength(1);

    // Launching again reuses the running app-server.
    await launch();
    expect(fakes).toHaveLength(1);
  });
});

describe("attaching to the session", () => {
  it("finds the terminal UI's thread by polling when no hook has reported it", async () => {
    const { fake } = await launch();
    fake.loadedThreads = ["thr_1"];
    await eventually(() => samD.codex.session(codex.id)?.threadId === "thr_1");
    expect(fake.sent("thread/resume")[0]?.params).toEqual({ threadId: "thr_1", excludeTurns: true });
  });

  it("attaches immediately from the SessionStart hook and briefs the agent", async () => {
    const { fake } = await launch();
    const out = await hook("session-start", { hook_event_name: "SessionStart", source: "startup" });
    expect(samD.codex.session(codex.id)?.threadId).toBe("thr_1");
    expect(fake.sent("thread/resume")).toHaveLength(1);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain(`You are "billing" (agent id ${codex.id})`);
    expect(out.hookSpecificOutput.additionalContext).toContain("auth-refactor (Claude · Ria");
  });
});

describe("streaming", () => {
  it("turns app-server items into the agent's stream, without reasoning", async () => {
    const { fake } = await launch();
    await hook("session-start", { source: "startup" });
    const at = { threadId: "thr_1", turnId: "turn_x", completedAtMs: Date.now() };
    fake.emit("item/completed", { ...at, item: { type: "userMessage", id: "i1", clientId: null, content: [{ type: "text", text: "Add Stripe webhooks", text_elements: [] }] } });
    fake.emit("item/completed", { ...at, item: { type: "reasoning", id: "i2", summary: ["secret"], content: ["secret"] } });
    fake.emit("item/completed", { ...at, item: { type: "agentMessage", id: "i3", text: "Adding a handler", phase: null } });
    fake.emit("item/completed", { ...at, item: { type: "commandExecution", id: "i4", command: "npm test", status: "completed", aggregatedOutput: "3 passing", exitCode: 0 } });
    fake.emit("item/completed", { threadId: "thr_other", turnId: "t", completedAtMs: 0, item: { type: "agentMessage", id: "i5", text: "other thread", phase: null } });
    await samD.settle();
    const stream = await eventually(() => {
      const s = riaD.link(ROOM_ID).mirror.state.streams.get(codex.id) ?? [];
      return s.length >= 4 ? s : null;
    });
    expect(stream.map((e) => [e.kind, e.text ?? e.input ?? e.output])).toEqual([
      ["message", "Add Stripe webhooks"],
      ["message", "Adding a handler"],
      ["tool_call", "npm test"],
      ["tool_result", "3 passing"],
    ]);
    expect(JSON.stringify(stream)).not.toContain("secret");
  });

  it("tracks turns for presence", async () => {
    const { fake } = await launch();
    await hook("session-start", { source: "startup" });
    fake.beginTurn("thr_1");
    await eventually(() => riaD.link(ROOM_ID).mirror.state.agents.get(codex.id)?.status === "thinking");
    fake.completeTurn("thr_1");
    await eventually(() => riaD.link(ROOM_ID).mirror.state.agents.get(codex.id)?.status === "idle");
  });
});

describe("pushing room messages", () => {
  it("steers messages into the running turn", async () => {
    const { fake } = await launch();
    await hook("session-start", { source: "startup" });
    const turn = fake.beginTurn("thr_1");
    await eventually(() => samD.codex.session(codex.id)?.activeTurnId === turn);

    await riaD.tool(claude.id, "message", { to: codex.id, kind: "fyi", body: "I'm changing routes.ts" });
    const steer = await eventually(() => fake.sent("turn/steer")[0]);
    expect(steer.params.threadId).toBe("thr_1");
    expect(steer.params.expectedTurnId).toBe(turn);
    expect(steer.params.input).toEqual([{ type: "text", text: expect.stringContaining("[fyi] from Ria's auth-refactor (Claude): I'm changing routes.ts"), text_elements: [] }]);
    expect(steer.params.input[0].text).toContain("not from your user");
    // Delivered once: the hook path doesn't repeat it.
    await eventually(() => samD.getAgent(codex.id).delivered.length === 1);
    expect(await hook("post-tool-use", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "" })).toEqual({});
  });

  it("when idle, starts a turn only for messages that need a reply", async () => {
    const { fake } = await launch();
    await hook("session-start", { source: "startup" });

    await riaD.tool(claude.id, "message", { to: codex.id, kind: "fyi", body: "fyi only" });
    await sleep(60);
    expect(fake.sent("turn/start")).toEqual([]);

    await riaD.tool(claude.id, "message", { to: codex.id, kind: "question", body: "Can I take src/routes.ts?" });
    const start = await eventually(() => fake.sent("turn/start")[0]);
    expect(start.params.threadId).toBe("thr_1");
    expect(start.params.input[0].text).toContain("[question] from Ria's auth-refactor (Claude): Can I take src/routes.ts?");
    expect(start.params.input[0].text).toContain("Reply with mp_answer");
    expect(start.params.input[0].text).not.toContain("fyi only");

    // The unpushed fyi reaches Codex at its next tool call once its push window lapses.
    await sleep(150);
    const post = await hook("post-tool-use", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: "" });
    expect(post.hookSpecificOutput.additionalContext).toContain("fyi only");
  });
});

describe("approvals", () => {
  it("never answers approval requests; it shows the agent as waiting", async () => {
    const { fake } = await launch();
    await hook("session-start", { source: "startup" });
    fake.request("item/commandExecution/requestApproval", { threadId: "thr_1", turnId: "t", itemId: "i", command: "rm -rf build" });
    await eventually(() => riaD.link(ROOM_ID).mirror.state.agents.get(codex.id)?.status === "waiting_permission");
    await sleep(100);
    expect(fake.responses).toEqual([]);
  });
});

describe("hooks", () => {
  it("enforces plans and locks on apply_patch, and continues Codex at Stop for questions", async () => {
    const patch = (file: string) => `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch`;
    const pre = (file: string) => hook("pre-tool-use", { hook_event_name: "PreToolUse", turn_id: "t", tool_name: "apply_patch", tool_use_id: "u", tool_input: { command: patch(file) } });

    expect((await pre("src/routes.ts")).hookSpecificOutput.permissionDecision).toBe("deny");
    await samD.tool(codex.id, "plan", { title: "Webhooks", steps: ["Add handler"] });
    expect(await pre("src/routes.ts")).toEqual({});

    await riaD.tool(claude.id, "plan", { title: "Auth", steps: [] });
    await riaD.preToolUse({ agentId: claude.id, kind: "edit", tool: "Edit", paths: [join(claude.worktree, "src/auth/session.ts")] });
    const denied = await pre("src/auth/session.ts");
    expect(denied.hookSpecificOutput.permissionDecisionReason).toContain("Ria's auth-refactor (Claude");

    await riaD.tool(claude.id, "message", { to: codex.id, kind: "question", body: "Done with billing?" });
    const stop = await hook("stop", { hook_event_name: "Stop", turn_id: "t", stop_hook_active: false, last_assistant_message: "done" });
    expect(stop.decision).toBe("block");
    expect(stop.reason).toContain("[question] from Ria's auth-refactor (Claude): Done with billing?");
    expect(await hook("stop", { hook_event_name: "Stop", stop_hook_active: true })).toEqual({});
  });

  it("stops the app-server when the daemon stops", async () => {
    const { fake } = await launch();
    const port = fake.lastStartSpec!.port;
    await samD.stop();
    await eventually(() =>
      fetch(`http://127.0.0.1:${port}/readyz`).then(
        () => false,
        () => true,
      ),
    );
  });
});
