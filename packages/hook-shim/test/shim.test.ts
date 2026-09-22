import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type Daemon, type LocalAgent, type ServerHandle } from "@mp/daemon";
import { cleanupTmp, LOOPBACK_INVITE, LoopbackRelay, makeDaemon, makeTeamRepos, ROOM_ID, tmp } from "@mp/daemon/testing";
import { eventSlug, forward } from "../src/forward.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const TOKEN = "shim-token-xxxxxxxxxxxxxxxxxxxxxxxx";
let daemon: Daemon;
let http: ServerHandle;
let agent: LocalAgent;

beforeAll(async () => {
  const repos = await makeTeamRepos();
  daemon = await makeDaemon(new LoopbackRelay(ROOM_ID), "Sam");
  await daemon.joinRoom({ repoPath: repos.sam, invite: LOOPBACK_INVITE });
  agent = await daemon.createAgent({ repoPath: repos.sam, name: "billing", vendor: "codex" });
  http = await startServer(daemon, { port: 0, token: TOKEN });
  await daemon.home.writeDaemonInfo({ pid: process.pid, port: http.port, token: TOKEN, startedAt: Date.now() });
});

afterAll(async () => {
  await http.close();
  await daemon.stop();
  await cleanupTmp();
});

/** Runs mp-hook exactly as Codex does: a child process with the payload on stdin. */
function runShim(payload: unknown, env: Record<string, string>): Promise<{ stdout: string; code: number | null; ms: number }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-deprecation", MAIN, "codex"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, code, ms: Date.now() - t0 }));
    child.stdin.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
}

const prePatch = () => ({
  session_id: "thr_1",
  transcript_path: null,
  cwd: agent.worktree,
  hook_event_name: "PreToolUse",
  model: "gpt",
  permission_mode: "default",
  turn_id: "t1",
  tool_name: "apply_patch",
  tool_use_id: "u1",
  tool_input: { command: "*** Begin Patch\n*** Update File: src/routes.ts\n@@\n-a\n+b\n*** End Patch" },
});

describe("mp-hook", () => {
  it("forwards a Codex hook to the daemon and prints the daemon's answer", async () => {
    const res = await runShim(prePatch(), { MP_HOME: daemon.home.dir, MP_AGENT_ID: agent.id });
    expect(res.code).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("publish your plan");
    console.log(`mp-hook round trip: ${res.ms}ms`);
  });

  it("finds the agent from the cwd when MP_AGENT_ID isn't set", async () => {
    const out = JSON.parse(await forward("codex", JSON.stringify(prePatch()), { MP_HOME: daemon.home.dir }));
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("fails open with {} when the daemon isn't there or the input is junk", async () => {
    const noDaemon = await runShim(prePatch(), { MP_HOME: await tmp("no-daemon"), MP_AGENT_ID: agent.id });
    expect(noDaemon).toMatchObject({ code: 0, stdout: "{}" });
    const junk = await runShim("not json", { MP_HOME: daemon.home.dir });
    expect(junk).toMatchObject({ code: 0, stdout: "{}" });
    const other = await runShim({ ...prePatch(), cwd: await tmp("elsewhere") }, { MP_HOME: daemon.home.dir });
    expect(other).toMatchObject({ code: 0, stdout: "{}" });
  });

  it("maps event names to the daemon's routes", () => {
    expect(eventSlug("UserPromptSubmit")).toBe("user-prompt-submit");
    expect(eventSlug("SessionEnd")).toBe("session-end");
  });
});
