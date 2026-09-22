import { describe, expect, it } from "vitest";
import type { LockAcquireResult, RoomEvent } from "@mp/protocol";
import { RoomEngine, ROOM_THREAD_ID } from "../src/index.ts";
import { twoAgents } from "./helpers.ts";

const types = (events: RoomEvent[]) => events.map((e) => e.type);

describe("agents", () => {
  it("assigns the caller as owner and refuses cross-member updates", () => {
    const h = twoAgents();
    expect(h.engine.state.agents.get("claude-1")?.memberId).toBe("sam");
    const res = h.run("ria", {
      op: "agent.upsert",
      agent: { id: "claude-1", deviceId: "x", vendor: "claude", name: "hijack" },
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("forbidden");
    expect(res.changes).toEqual([]);
  });

  it("removing an agent cascades to its locks, claims, plan and diff", () => {
    const h = twoAgents();
    h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["src/auth.ts"] });
    h.ok("sam", { op: "claim.add", agentId: "claude-1", pattern: "src/auth/**" });
    h.ok("sam", { op: "plan.set", agentId: "claude-1", plan: { title: "Auth", steps: [] } });
    h.ok("sam", { op: "diff.set", agentId: "claude-1", files: [] });
    const res = h.ok("sam", { op: "agent.remove", agentId: "claude-1" });
    expect(types(res.events)).toEqual([
      "lock.released",
      "claim.released",
      "plan.removed",
      "diff.removed",
      "agent.removed",
    ]);
    expect(h.engine.state.locks.size).toBe(0);
    expect(h.engine.state.claims.size).toBe(0);
  });

  it("seq numbers are gap-free across ops", () => {
    const h = twoAgents();
    const a = h.ok("sam", { op: "plan.set", agentId: "claude-1", plan: { title: "A", steps: [] } });
    const b = h.ok("sam", { op: "claim.add", agentId: "claude-1", pattern: "src/a/**" });
    expect(b.events[0]!.seq).toBe(a.events[0]!.seq + 1);
  });
});

describe("locks", () => {
  it("grants, renews, and denies another agent with holder details", () => {
    const h = twoAgents();
    h.ok("sam", {
      op: "plan.set",
      agentId: "claude-1",
      plan: { title: "Auth refactor", steps: [{ id: "s1", text: "Extract session store", status: "active" }] },
    });
    const first = h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["src/auth.ts"] });
    expect(first.result).toEqual({ granted: true, paths: ["src/auth.ts"] });
    expect(types(first.events)).toEqual(["lock.acquired"]);

    h.advance(1000);
    const renew = h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["src/auth.ts"] });
    expect(renew.events).toEqual([]);
    expect(h.engine.state.locks.get("src/auth.ts")?.renewedAt).toBe(h.now);

    const denied = h.ok("ria", { op: "lock.acquire", agentId: "codex-1", paths: ["src/auth.ts", "src/billing.ts"] });
    const result = denied.result as LockAcquireResult;
    expect(result.granted).toBe(false);
    expect(result.granted === false && result.held).toEqual([
      {
        path: "src/auth.ts",
        agentId: "claude-1",
        agentName: "auth-refactor",
        memberName: "Sam",
        planTitle: "Auth refactor",
        activeStep: "Extract session store",
      },
    ]);
    // All-or-nothing: billing.ts was not locked either.
    expect(h.engine.state.locks.has("src/billing.ts")).toBe(false);
  });

  it("releases only the caller's own locks", () => {
    const h = twoAgents();
    h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["a.ts", "b.ts"] });
    const res = h.ok("sam", { op: "lock.release", agentId: "claude-1", paths: ["a.ts"] });
    expect(res.result).toEqual({ released: ["a.ts"] });
    expect([...h.engine.state.locks.keys()]).toEqual(["b.ts"]);
    expect(h.run("ria", { op: "lock.release", agentId: "claude-1" }).error?.code).toBe("forbidden");
  });

  it("lets a human override someone else's lock", () => {
    const h = twoAgents();
    h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["a.ts"] });
    const res = h.ok("ria", { op: "lock.override", path: "a.ts" });
    expect(res.events[0]).toMatchObject({ type: "lock.released", reason: "override", by: "ria" });
    expect(h.ok("ria", { op: "lock.acquire", agentId: "codex-1", paths: ["a.ts"] }).result).toMatchObject({ granted: true });
  });
});

describe("claims", () => {
  it("reports overlaps with other agents' claims and is idempotent", () => {
    const h = twoAgents();
    h.ok("sam", { op: "claim.add", agentId: "claude-1", pattern: "src/api/**" });
    const res = h.ok("ria", { op: "claim.add", agentId: "codex-1", pattern: "src/api/billing" });
    expect((res.result as { overlaps: unknown[] }).overlaps).toHaveLength(1);
    const again = h.ok("ria", { op: "claim.add", agentId: "codex-1", pattern: "src/api/billing" });
    expect(again.events).toEqual([]);
    expect(h.engine.state.claims.size).toBe(2);
  });

  it("releases by pattern or all", () => {
    const h = twoAgents();
    h.ok("sam", { op: "claim.add", agentId: "claude-1", pattern: "a/**" });
    h.ok("sam", { op: "claim.add", agentId: "claude-1", pattern: "b/**" });
    h.ok("sam", { op: "claim.release", agentId: "claude-1", pattern: "a/**" });
    expect([...h.engine.state.claims.values()].map((c) => c.pattern)).toEqual(["b/**"]);
    h.ok("sam", { op: "claim.release", agentId: "claude-1" });
    expect(h.engine.state.claims.size).toBe(0);
    expect(h.run("sam", { op: "claim.release", agentId: "claude-1", pattern: "zzz" }).error?.code).toBe("not_found");
  });
});

describe("plans", () => {
  it("rejects duplicate step ids without mutating", () => {
    const h = twoAgents();
    const res = h.run("sam", {
      op: "plan.set",
      agentId: "claude-1",
      plan: { title: "x", steps: [{ id: "s", text: "a" }, { id: "s", text: "b" }] },
    });
    expect(res.error?.code).toBe("bad_request");
    expect(h.engine.state.plans.size).toBe(0);
  });

  it("updates step status", () => {
    const h = twoAgents();
    h.ok("sam", { op: "plan.set", agentId: "claude-1", plan: { title: "x", steps: [{ id: "s1", text: "a" }] } });
    h.ok("sam", { op: "plan.step", agentId: "claude-1", stepId: "s1", status: "done" });
    expect(h.engine.state.plans.get("claude-1")?.steps[0]?.status).toBe("done");
  });
});

describe("messages", () => {
  it("routes direct messages into one thread per participant set", () => {
    const h = twoAgents();
    const q = h.ok("sam", {
      op: "message.send",
      from: { type: "agent", id: "claude-1" },
      to: [{ type: "agent", id: "codex-1" }],
      kind: "question",
      body: "Are you touching src/auth?",
    });
    const { threadId, messageId } = q.result as { threadId: string; messageId: string };
    expect(types(q.events)).toEqual(["thread.opened", "message.posted"]);

    const back = h.ok("ria", {
      op: "message.send",
      from: { type: "agent", id: "codex-1" },
      to: [{ type: "agent", id: "claude-1" }],
      body: "No",
    });
    expect((back.result as { threadId: string }).threadId).toBe(threadId);

    // A reply without threadId lands in the parent's thread.
    const answer = h.ok("ria", {
      op: "message.send",
      from: { type: "agent", id: "codex-1" },
      kind: "answer",
      replyTo: messageId,
      body: "Only billing",
    });
    expect((answer.result as { threadId: string }).threadId).toBe(threadId);
    expect(h.engine.state.threads.get(threadId)?.kind).toBe("direct");
  });

  it("posts to the room thread when there are no recipients", () => {
    const h = twoAgents();
    const res = h.ok("sam", { op: "message.send", from: { type: "member", id: "sam" }, body: "standup in 5" });
    expect((res.result as { threadId: string }).threadId).toBe(ROOM_THREAD_ID);
  });

  it("refuses to send as another member's agent", () => {
    const h = twoAgents();
    const res = h.run("sam", { op: "message.send", from: { type: "agent", id: "codex-1" }, body: "spoof" });
    expect(res.error?.code).toBe("forbidden");
  });

  it("trims threads to the configured size", () => {
    const h = twoAgents({ maxMessagesPerThread: 3 });
    for (let i = 0; i < 5; i++) {
      h.advance(1);
      h.ok("sam", { op: "message.send", from: { type: "member", id: "sam" }, body: `m${i}` });
    }
    const bodies = [...h.engine.state.messages.values()].map((m) => m.body);
    expect(bodies).toEqual(["m2", "m3", "m4"]);
  });
});

describe("streams", () => {
  it("keeps a bounded ring buffer and emits no seq'd events", () => {
    const h = twoAgents({ maxStreamPerAgent: 3 });
    const seq = h.engine.state.seq;
    for (let i = 0; i < 5; i++) {
      const res = h.ok("sam", { op: "stream.push", agentId: "claude-1", events: [{ at: i, kind: "message", text: `t${i}` }] });
      expect(res.stream?.events).toHaveLength(1);
      expect(res.events).toEqual([]);
    }
    expect(h.engine.state.seq).toBe(seq);
    expect(h.engine.state.streams.get("claude-1")?.map((e) => e.text)).toEqual(["t2", "t3", "t4"]);
  });
});

describe("diffs", () => {
  it("drops oversized patches and marks them truncated", () => {
    const h = twoAgents({ maxPatchBytesPerFile: 10, maxPatchBytesTotal: 15 });
    const file = (path: string, patch: string) => ({
      path,
      status: "modified" as const,
      additions: 1,
      deletions: 0,
      hunks: [],
      patch,
    });
    const res = h.ok("sam", {
      op: "diff.set",
      agentId: "claude-1",
      files: [file("a.ts", "12345678"), file("b.ts", "this is way too long"), file("c.ts", "12345678")],
    });
    expect(res.result).toEqual({ files: 3, truncated: true });
    const files = h.engine.state.diffs.get("claude-1")!.files;
    expect(files[0]?.patch).toBe("12345678");
    expect(files[1]).toMatchObject({ truncated: true });
    expect(files[1]?.patch).toBeUndefined();
    // c.ts fits the per-file cap but not the remaining total budget.
    expect(files[2]).toMatchObject({ truncated: true });
  });
});

describe("reviews and freezes", () => {
  function openReview(h: ReturnType<typeof twoAgents>) {
    const res = h.ok("ria", {
      op: "review.open",
      review: {
        requesterAgentId: "codex-1",
        command: "pnpm add zod@4",
        tier: "T2",
        impact: { paths: ["package.json", "pnpm-lock.yaml"], resources: [] },
        affectedAgentIds: ["claude-1"],
      },
    });
    return res.result as { reviewId: string; threadId: string };
  }

  it("opens a review with its own thread", () => {
    const h = twoAgents();
    const { reviewId, threadId } = openReview(h);
    const review = h.engine.state.reviews.get(reviewId)!;
    expect(review.status).toBe("arbitrating");
    expect(h.engine.state.threads.get(threadId)).toMatchObject({ kind: "review", reviewId });
  });

  it("freezes block affected agents' locks on matching paths, but not the requester", () => {
    const h = twoAgents();
    const { reviewId } = openReview(h);
    h.ok("ria", { op: "freeze.set", reviewId, scope: "agents", agentIds: ["claude-1"], paths: ["package.json"] });

    const blocked = h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["package.json"] }).result;
    expect(blocked).toMatchObject({ granted: false, frozenBy: { reviewId } });
    const elsewhere = h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["src/auth.ts"] }).result;
    expect(elsewhere).toMatchObject({ granted: true });
    const requester = h.ok("ria", { op: "lock.acquire", agentId: "codex-1", paths: ["package.json"] }).result;
    expect(requester).toMatchObject({ granted: true });
  });

  it("records verdicts from affected agents only, and posts them to the thread", () => {
    const h = twoAgents();
    const { reviewId, threadId } = openReview(h);
    const res = h.ok("sam", {
      op: "review.verdict",
      reviewId,
      agentId: "claude-1",
      decision: "approve_after",
      reason: "I'm upgrading zod in my branch",
      condition: "claude-1 ships",
    });
    expect(types(res.events)).toEqual(["review.updated", "message.posted"]);
    expect(h.engine.state.reviews.get(reviewId)?.verdicts).toHaveLength(1);
    const posted = [...h.engine.state.messages.values()].filter((m) => m.threadId === threadId);
    expect(posted.at(-1)?.body).toContain("approve_after");

    const notAffected = h.run("ria", { op: "review.verdict", reviewId, agentId: "codex-1", decision: "approve", reason: "" });
    expect(notAffected.error?.code).toBe("forbidden");
  });

  it("a human decision resolves the review and clears its freezes", () => {
    const h = twoAgents();
    const { reviewId } = openReview(h);
    h.ok("ria", { op: "freeze.set", reviewId, scope: "room", paths: ["**"] });
    const res = h.ok("sam", { op: "review.decide", reviewId, decision: "deny", note: "wait for my ship" });
    expect(types(res.events)).toEqual(["review.updated", "message.posted", "freeze.cleared"]);
    expect(h.engine.state.reviews.get(reviewId)).toMatchObject({ status: "denied", resolvedAt: h.now });
    expect(h.engine.state.freezes.size).toBe(0);
    expect(h.run("sam", { op: "review.decide", reviewId, decision: "approve" }).error?.code).toBe("conflict");
  });

  it("only the requester's owner can update or freeze", () => {
    const h = twoAgents();
    const { reviewId } = openReview(h);
    expect(h.run("sam", { op: "review.update", reviewId, patch: { status: "approved" } }).error?.code).toBe("forbidden");
    expect(h.run("sam", { op: "freeze.set", reviewId, scope: "room", paths: ["**"] }).error?.code).toBe("forbidden");
  });
});

describe("tick", () => {
  it("marks silent agents offline and revives them on heartbeat", () => {
    const h = twoAgents({ agentOfflineMs: 1000 });
    h.advance(500);
    h.ok("sam", { op: "heartbeat", agentIds: ["claude-1"] });
    h.advance(800);
    const res = h.engine.tick(h.now);
    expect(res.events.map((e) => e.type === "agent.updated" && e.agent.id)).toEqual(["codex-1"]);
    h.ok("ria", { op: "heartbeat", agentIds: ["codex-1"] });
    expect(h.engine.state.agents.get("codex-1")?.status).toBe("idle");
  });

  it("releases locks whose file left the holder's diff after the grace period", () => {
    const h = twoAgents({ lockCleanGraceMs: 1000, agentOfflineMs: 1e9 });
    h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["a.ts", "b.ts"] });
    h.ok("sam", {
      op: "diff.set",
      agentId: "claude-1",
      files: [{ path: "a.ts", status: "modified", additions: 1, deletions: 0, hunks: [] }],
    });
    h.advance(500);
    expect(h.engine.tick(h.now).events).toEqual([]);
    h.advance(600);
    const res = h.engine.tick(h.now);
    expect(res.events[0]).toMatchObject({ type: "lock.released", paths: ["b.ts"], reason: "clean", by: null });
    expect([...h.engine.state.locks.keys()]).toEqual(["a.ts"]);
  });

  it("expires locks of agents that stay offline", () => {
    const h = twoAgents({ agentOfflineMs: 1000, lockStaleMs: 5000, lockCleanGraceMs: 1e9 });
    h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["a.ts"] });
    h.advance(2000);
    h.engine.tick(h.now);
    expect(h.engine.state.agents.get("claude-1")?.status).toBe("offline");
    expect(h.engine.state.locks.size).toBe(1);
    h.advance(4000);
    const res = h.engine.tick(h.now);
    expect(res.events.find((e) => e.type === "lock.released")).toMatchObject({ reason: "expired" });
  });

  it("reports the next deadline", () => {
    const h = twoAgents({ agentOfflineMs: 1000 });
    expect(h.engine.nextDeadline()).toBe(h.now + 1001);
  });
});

describe("snapshots", () => {
  it("round-trips through fromSnapshot", () => {
    const h = twoAgents();
    h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["a.ts"] });
    h.ok("sam", { op: "stream.push", agentId: "claude-1", events: [{ at: 1, kind: "message", text: "hi" }] });
    const copy = RoomEngine.fromSnapshot(h.engine.snapshot());
    expect(copy.snapshot()).toEqual(h.engine.snapshot());
    expect(copy.state.seq).toBe(h.engine.state.seq);
  });
});
