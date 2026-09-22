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

  it("resolves a folder to its repo and room", async () => {
    const res = await call("GET", `/v1/repos/resolve?path=${encodeURIComponent(repoPath + "/src")}`);
    expect(res.body).toMatchObject({ root: repoPath, room: { roomId: ROOM_ID, connected: true } });
    expect((await call("GET", `/v1/repos/resolve?path=${encodeURIComponent("/")}`)).status).toBe(404);
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

describe("room events for the IDE", () => {
  it("streams a snapshot, then live events, and lets a human post to the room", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/rooms/${ROOM_ID}/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ctrl.signal,
    });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const next = async (event: string) => {
      for (;;) {
        const i = buf.indexOf("\n\n");
        if (i >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name === event && data) return JSON.parse(data);
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += decoder.decode(value, { stream: true });
      }
    };
    const snap = await next("snapshot");
    expect(snap).toMatchObject({ connected: true, identity: { name: "Sam" } });
    expect(snap.localAgents.map((a: LocalAgent) => a.id)).toContain(agent.id);
    expect(snap.room.agents.map((a: { id: string }) => a.id)).toContain(agent.id);

    const posted = await call("POST", `/v1/rooms/${ROOM_ID}/messages`, { body: "standup in 5" });
    expect(posted.status).toBe(200);
    const ev = await next("event");
    expect(ev).toMatchObject({ type: "thread.opened" });
    const msg = await next("event");
    expect(msg).toMatchObject({ type: "message.posted", message: { body: "standup in 5", from: { type: "member" } } });
    ctrl.abort();
  });
});
