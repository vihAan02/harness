import { describe, expect, it } from "vitest";
import type { RoomEvent, RoomSnapshot } from "@mp/protocol";
import { RoomMirror, SeqGapError } from "../src/index.ts";
import { makeEngine } from "./helpers.ts";

/** Fields the relay updates without emitting an event; mirrors are allowed to lag on these. */
function comparable(s: RoomSnapshot) {
  return {
    ...s,
    members: s.members.map(({ lastSeenAt: _l, ...m }) => m),
    agents: s.agents.map(({ lastSeenAt: _l, ...a }) => a),
    locks: s.locks.map(({ renewedAt: _r, ...l }) => l),
    streams: {},
  };
}

describe("RoomMirror", () => {
  it("replaying every engine event reproduces the engine's state", () => {
    const h = makeEngine({ maxMessagesPerThread: 4 });
    const events: RoomEvent[] = [];
    const record = <T extends { events: RoomEvent[] }>(r: T) => (events.push(...r.events), r);

    record(h.engine.connect({ id: "sam", name: "Sam" }, h.now));
    record(h.engine.connect({ id: "ria", name: "Ria" }, h.now));
    record(h.ok("sam", { op: "agent.upsert", agent: { id: "c1", deviceId: "d1", vendor: "claude", name: "auth" } }));
    record(h.ok("ria", { op: "agent.upsert", agent: { id: "x1", deviceId: "d2", vendor: "codex", name: "billing" } }));
    record(h.ok("sam", { op: "plan.set", agentId: "c1", plan: { title: "Auth", steps: [{ id: "s1", text: "a" }] } }));
    record(h.ok("sam", { op: "plan.step", agentId: "c1", stepId: "s1", status: "active" }));
    record(h.ok("sam", { op: "claim.add", agentId: "c1", pattern: "src/auth/**" }));
    record(h.ok("ria", { op: "claim.add", agentId: "x1", pattern: "src/billing/**" }));
    record(h.ok("ria", { op: "claim.release", agentId: "x1" }));
    record(h.ok("sam", { op: "lock.acquire", agentId: "c1", paths: ["a.ts", "b.ts"] }));
    record(h.ok("sam", { op: "lock.release", agentId: "c1", paths: ["b.ts"] }));
    record(h.ok("ria", { op: "lock.override", path: "a.ts" }));
    record(h.ok("ria", { op: "diff.set", agentId: "x1", files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, hunks: [] }] }));
    for (let i = 0; i < 6; i++) {
      h.advance(1);
      record(h.ok(i % 2 ? "sam" : "ria", {
        op: "message.send",
        from: i % 2 ? { type: "agent", id: "c1" } : { type: "agent", id: "x1" },
        to: [i % 2 ? { type: "agent", id: "x1" } : { type: "agent", id: "c1" }],
        body: `m${i}`,
      }));
    }
    const { reviewId } = record(h.ok("ria", {
      op: "review.open",
      review: { requesterAgentId: "x1", command: "pnpm add zod", tier: "T2", impact: { paths: ["package.json"], resources: [] }, affectedAgentIds: ["c1"] },
    })).result as { reviewId: string };
    record(h.ok("ria", { op: "freeze.set", reviewId, scope: "agents", agentIds: ["c1"], paths: ["package.json"] }));
    record(h.ok("sam", { op: "review.verdict", reviewId, agentId: "c1", decision: "object", reason: "wait" }));
    record(h.ok("sam", { op: "review.decide", reviewId, decision: "deny" }));
    record(h.ok("sam", { op: "agent.remove", agentId: "c1" }));
    record(h.engine.disconnect("sam", h.now));

    const mirror = new RoomMirror("room-1", { maxMessagesPerThread: 4 });
    for (const e of events) mirror.apply(e);
    expect(mirror.seq).toBe(h.engine.state.seq);
    expect(comparable(mirror.stateSnapshot())).toEqual(comparable(h.engine.snapshot()));
    expect(mirror.status()).toEqual(h.engine.status());
  });

  it("ignores duplicates and reports gaps", () => {
    const h = makeEngine();
    const a = h.engine.connect({ id: "sam", name: "Sam" }, h.now).events[0]!;
    const b = h.engine.connect({ id: "ria", name: "Ria" }, h.now).events[0]!;
    const c = h.engine.connect({ id: "kai", name: "Kai" }, h.now).events[0]!;
    const mirror = new RoomMirror("room-1");
    mirror.apply(a);
    mirror.apply(a);
    expect(mirror.seq).toBe(1);
    expect(() => mirror.apply(c)).toThrow(SeqGapError);
    mirror.apply(b);
    mirror.apply(c);
    expect(mirror.state.members.size).toBe(3);
  });

  it("starts from a snapshot", () => {
    const h = makeEngine();
    h.engine.connect({ id: "sam", name: "Sam" }, h.now);
    const mirror = new RoomMirror("room-1");
    mirror.reset(h.engine.snapshot());
    expect(mirror.seq).toBe(1);
    const next = h.engine.connect({ id: "ria", name: "Ria" }, h.now).events[0]!;
    mirror.apply(next);
    expect([...mirror.state.members.keys()]).toEqual(["sam", "ria"]);
  });
});
