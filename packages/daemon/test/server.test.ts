import { request } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type Daemon, type LocalAgent, type ServerHandle } from "../src/index.ts";
import { LoopbackRelay } from "../src/testing/loopback.ts";
import { cleanupTmp, LOOPBACK_INVITE, makeDaemon, makeTeamRepos, ROOM_ID } from "./fixtures.ts";

const TOKEN = "t".repeat(32);
let daemon: Daemon;
let server: ServerHandle;
let agent: LocalAgent;
let repoPath: string;

beforeAll(async () => {
  const repos = await makeTeamRepos();
  repoPath = repos.sam;
  daemon = await makeDaemon(new LoopbackRelay(ROOM_ID), "Sam");
  server = await startServer(daemon, { port: 0, token: TOKEN });
});

afterAll(async () => {
  await server.close();
  await daemon.stop();
  await cleanupTmp();
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe("localhost API", () => {
  it("requires the bearer token", async () => {
    expect((await call("GET", "/v1/health", undefined, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await call("GET", "/v1/health")).body).toMatchObject({ ok: true });
  });

  it("refuses browser requests and foreign Host headers", async () => {
    expect((await call("GET", "/v1/health", undefined, { origin: "https://evil.example" })).status).toBe(403);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: server.port, path: "/v1/health", headers: { host: "evil.example", authorization: `Bearer ${TOKEN}` } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(421);
  });

  it("joins a room, creates an agent and answers hooks and tools", async () => {
    expect((await call("POST", "/v1/rooms/join", { repoPath, invite: LOOPBACK_INVITE })).body).toMatchObject({ roomId: ROOM_ID });
    const created = await call("POST", "/v1/agents", { repoPath, name: "auth-refactor", vendor: "claude" });
    expect(created.status).toBe(200);
    agent = created.body;

    // A hook found by cwd, the way Claude Code and Codex report it.
    const pre = await call("POST", "/v1/hooks/pre", { cwd: agent.worktree, kind: "edit", tool: "Edit", paths: [join(agent.worktree, "src/routes.ts")] });
    expect(pre.body).toMatchObject({ decision: "deny" });

    const plan = await call("POST", `/v1/agents/${agent.id}/tools/plan`, { args: { title: "Refactor", steps: ["one"] } });
    expect(plan.body.text).toContain('Plan published: "Refactor"');
    expect((await call("POST", "/v1/hooks/pre", { cwd: agent.worktree, kind: "edit", tool: "Edit", paths: ["src/routes.ts"] })).body).toEqual({
      decision: "allow",
    });

    const status = await call("GET", `/v1/rooms/${ROOM_ID}/status`);
    expect(status.body.table).toContain("auth-refactor (Claude · Sam");
  });

  it("reports bad input clearly", async () => {
    expect((await call("POST", "/v1/agents", { repoPath, name: "x", vendor: "gemini" })).status).toBe(400);
    const bad = await call("POST", `/v1/agents/${agent.id}/tools/claim`, { args: {} });
    expect(bad).toMatchObject({ status: 400, body: { error: { code: "bad_tool_args" } } });
    expect((await call("GET", "/v1/nope")).status).toBe(404);
  });

  it("ignores hooks from sessions it doesn't manage", async () => {
    expect((await call("POST", "/v1/hooks/pre", { cwd: "/tmp", kind: "edit", tool: "Edit", paths: ["/tmp/x"] })).body).toEqual({ decision: "allow" });
  });
});
