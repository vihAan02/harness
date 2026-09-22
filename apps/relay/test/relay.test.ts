import { env, evictDurableObject, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BASE, createRoom, joined, TestClient } from "./client.ts";

const SAM = { id: "sam", name: "Sam" };
const RIA = { id: "ria", name: "Ria" };

const claudeAgent = { id: "claude-1", deviceId: "sam-laptop", vendor: "claude", name: "auth-refactor" };
const codexAgent = { id: "codex-1", deviceId: "ria-laptop", vendor: "codex", name: "billing" };

const stubFor = (roomId: string) => env.ROOMS.get(env.ROOMS.idFromName(roomId));

describe("http", () => {
  it("serves health and 404s unknown rooms", async () => {
    expect(await (await SELF.fetch(`${BASE}/health`)).json()).toMatchObject({ ok: true });
    const res = await SELF.fetch(`${BASE}/rooms/${"0".repeat(24)}/ws`, { headers: { Upgrade: "websocket" } });
    expect(res.status).toBe(404);
    expect((await SELF.fetch(`${BASE}/rooms/not-an-id/ws`)).status).toBe(404);
  });

  it("creates rooms with distinct ids and secrets", async () => {
    const a = await createRoom();
    const b = await createRoom();
    expect(a.roomId).toMatch(/^[0-9a-f]{24}$/);
    expect(a.roomId).not.toBe(b.roomId);
    expect(a.secret.length).toBeGreaterThanOrEqual(40);
  });
});

describe("auth", () => {
  it("rejects a wrong secret and closes the socket", async () => {
    const { roomId } = await createRoom();
    const client = await TestClient.connect(roomId);
    const res = await client.hello("x".repeat(43), SAM);
    expect(res).toMatchObject({ t: "error", error: { code: "unauthorized" } });
  });

  it("rejects ops before hello", async () => {
    const { roomId } = await createRoom();
    const client = await TestClient.connect(roomId);
    client.send({ op: "heartbeat", reqId: "1", agentIds: [] });
    expect(await client.take((m) => m.t === "error")).toMatchObject({ error: { code: "unauthorized" } });
  });
});

describe("room over the wire", () => {
  it("welcomes with a snapshot and announces members to each other", async () => {
    const { roomId, secret } = await createRoom();
    const sam = await joined(roomId, secret, SAM);
    expect(sam.welcome).toMatchObject({ t: "welcome", mode: "snapshot", memberId: "sam" });
    if (sam.welcome.t === "welcome") expect(sam.welcome.snapshot?.members.map((m) => m.id)).toEqual(["sam"]);

    const ria = await joined(roomId, secret, RIA);
    if (ria.welcome.t === "welcome") expect(ria.welcome.snapshot?.members.map((m) => m.id).sort()).toEqual(["ria", "sam"]);
    const announced = await sam.client.event("member.updated");
    expect(announced.event).toMatchObject({ member: { id: "ria", online: true } });
  });

  it("enforces hot-file locks across members and explains who holds them", async () => {
    const { roomId, secret } = await createRoom();
    const sam = await joined(roomId, secret, SAM);
    const ria = await joined(roomId, secret, RIA);

    await sam.client.ok({ op: "agent.upsert", agent: claudeAgent });
    await ria.client.event("agent.updated");
    await sam.client.ok({
      op: "plan.set",
      agentId: "claude-1",
      plan: { title: "Auth refactor", steps: [{ id: "s1", text: "Move middleware", status: "active" }] },
    });
    expect(await sam.client.ok({ op: "lock.acquire", agentId: "claude-1", paths: ["src/auth.ts"] })).toEqual({
      granted: true,
      paths: ["src/auth.ts"],
    });
    const acquired = await ria.client.event("lock.acquired");
    expect(acquired.event).toMatchObject({ agentId: "claude-1", by: "sam" });

    await ria.client.ok({ op: "agent.upsert", agent: codexAgent });
    const denied = await ria.client.ok({ op: "lock.acquire", agentId: "codex-1", paths: ["src/auth.ts"] });
    expect(denied).toMatchObject({
      granted: false,
      held: [{ path: "src/auth.ts", agentName: "auth-refactor", memberName: "Sam", planTitle: "Auth refactor", activeStep: "Move middleware" }],
    });
  });

  it("delivers an op's events to the sender before its ack (read-your-writes)", async () => {
    const { roomId, secret } = await createRoom();
    const sam = await joined(roomId, secret, SAM);
    await sam.client.ok({ op: "agent.upsert", agent: claudeAgent });
    const log = sam.client.log;
    const eventAt = log.findIndex((m) => m.t === "event" && m.event.type === "agent.updated");
    const ackAt = log.findIndex((m) => m.t === "ack");
    expect(eventAt).toBeGreaterThanOrEqual(0);
    expect(eventAt).toBeLessThan(ackAt);
  });

  it("refuses to let one member act as another member's agent", async () => {
    const { roomId, secret } = await createRoom();
    const sam = await joined(roomId, secret, SAM);
    const ria = await joined(roomId, secret, RIA);
    await sam.client.ok({ op: "agent.upsert", agent: claudeAgent });
    const ack = await ria.client.op({ op: "lock.acquire", agentId: "claude-1", paths: ["a.ts"] });
    expect(ack).toMatchObject({ ok: false, error: { code: "forbidden" } });
  });

  it("delivers agent-to-agent messages and streams", async () => {
    const { roomId, secret } = await createRoom();
    const sam = await joined(roomId, secret, SAM);
    const ria = await joined(roomId, secret, RIA);
    await sam.client.ok({ op: "agent.upsert", agent: claudeAgent });
    await ria.client.ok({ op: "agent.upsert", agent: codexAgent });

    await ria.client.ok({
      op: "message.send",
      from: { type: "agent", id: "codex-1" },
      to: [{ type: "agent", id: "claude-1" }],
      kind: "question",
      body: "What are you doing in src/auth?",
    });
    const posted = await sam.client.event("message.posted");
    expect(posted.event).toMatchObject({ message: { kind: "question", from: { id: "codex-1" }, to: [{ id: "claude-1" }] } });

    await sam.client.ok({ op: "stream.push", agentId: "claude-1", events: [{ at: 1, kind: "message", text: "Refactoring session store" }] });
    const stream = await ria.client.take((m) => m.t === "stream");
    expect(stream).toMatchObject({ t: "stream", agentId: "claude-1", events: [{ text: "Refactoring session store" }] });
    // The sender does not get its own stream echoed back.
    expect(sam.client.inbox.some((m) => m.t === "stream")).toBe(false);
  });

  it("rejects malformed ops with bad_request", async () => {
    const { roomId, secret } = await createRoom();
    const sam = await joined(roomId, secret, SAM);
    const ack = await sam.client.op({ op: "lock.acquire", agentId: "a", paths: ["../../etc/passwd"] });
    expect(ack).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });
});

describe("reconnect and durability", () => {
  it("replays missed events to a client that reconnects with lastSeq", async () => {
    const { roomId, secret } = await createRoom();
    const sam = await joined(roomId, secret, SAM);
    const ria = await joined(roomId, secret, RIA);
    await sam.client.ok({ op: "agent.upsert", agent: claudeAgent });
    const seen = await ria.client.event("agent.updated");
    const lastSeq = seen.event.seq;

    ria.client.close();
    const offline = await sam.client.take(
      (m) => m.t === "event" && m.event.type === "member.updated" && m.event.member.id === "ria" && !m.event.member.online,
    );
    expect(offline).toMatchObject({ event: { member: { id: "ria", online: false }, by: null } });
    await sam.client.ok({ op: "claim.add", agentId: "claude-1", pattern: "src/auth/**" });

    const again = await TestClient.connect(roomId);
    const welcome = await again.hello(secret, RIA, lastSeq);
    expect(welcome).toMatchObject({ t: "welcome", mode: "replay" });
    const types = welcome.t === "welcome" ? welcome.events?.map((e) => e.type) : [];
    expect(types).toEqual(["member.updated", "claim.added", "member.updated"]);
  });

  it("falls back to a snapshot when lastSeq is from the future", async () => {
    const { roomId, secret } = await createRoom();
    const client = await TestClient.connect(roomId);
    const welcome = await client.hello(secret, SAM, 10_000);
    expect(welcome).toMatchObject({ t: "welcome", mode: "snapshot" });
  });

  it("keeps state and sockets across eviction (hibernation)", async () => {
    const { roomId, secret } = await createRoom();
    const sam = await joined(roomId, secret, SAM);
    await sam.client.ok({ op: "agent.upsert", agent: claudeAgent });
    await sam.client.ok({ op: "lock.acquire", agentId: "claude-1", paths: ["src/auth.ts"] });
    await sam.client.ok({ op: "stream.push", agentId: "claude-1", events: [{ at: 1, kind: "status", status: "editing" }] });

    await evictDurableObject(stubFor(roomId));

    // The hibernated socket still works, and the reloaded engine still enforces the lock.
    await sam.client.ok({ op: "heartbeat", agentIds: ["claude-1"] });
    const ria = await joined(roomId, secret, RIA);
    if (ria.welcome.t !== "welcome") throw new Error("no welcome");
    expect(ria.welcome.snapshot?.locks).toMatchObject([{ path: "src/auth.ts", agentId: "claude-1" }]);
    expect(ria.welcome.snapshot?.streams["claude-1"]).toHaveLength(1);
    await ria.client.ok({ op: "agent.upsert", agent: codexAgent });
    expect(await ria.client.ok({ op: "lock.acquire", agentId: "codex-1", paths: ["src/auth.ts"] })).toMatchObject({
      granted: false,
    });
  });

  it("the alarm marks silent agents offline on its own schedule", async () => {
    const { roomId, secret } = await createRoom();
    const sam = await joined(roomId, secret, SAM);
    const ria = await joined(roomId, secret, RIA);
    await sam.client.ok({ op: "agent.upsert", agent: claudeAgent });
    await ria.client.event("agent.updated");

    // AGENT_OFFLINE_MS is 150 in tests; the engine's nextDeadline schedules the alarm.
    const offline = await ria.client.take(
      (m) => m.t === "event" && m.event.type === "agent.updated" && m.event.agent.status === "offline",
    );
    expect(offline).toMatchObject({ event: { agent: { id: "claude-1", status: "offline" }, by: null } });
  });

  it("a heartbeat revives an offline agent", async () => {
    const { roomId, secret } = await createRoom();
    const sam = await joined(roomId, secret, SAM);
    await sam.client.ok({ op: "agent.upsert", agent: claudeAgent });
    await new Promise((r) => setTimeout(r, 200));
    await runDurableObjectAlarm(stubFor(roomId)); // no-op if it already fired
    await sam.client.take((m) => m.t === "event" && m.event.type === "agent.updated" && m.event.agent.status === "offline");
    await sam.client.ok({ op: "heartbeat", agentIds: ["claude-1"] });
    const revived = await sam.client.take(
      (m) => m.t === "event" && m.event.type === "agent.updated" && m.event.agent.status === "idle",
    );
    expect(revived).toMatchObject({ event: { agent: { id: "claude-1", status: "idle" }, by: "sam" } });
  });
});
