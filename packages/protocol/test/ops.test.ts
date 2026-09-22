import { describe, expect, it } from "vitest";
import { ClientOp, Hello, RepoPath } from "../src/index.ts";

describe("RepoPath", () => {
  it.each(["src/a.ts", "README.md", "a/b/c/d.txt", ".github/workflows/ci.yml"])("accepts %s", (p) => {
    expect(RepoPath.safeParse(p).success).toBe(true);
  });

  it.each(["/etc/passwd", "../x", "src/../../x", "src\\win.ts", ""])("rejects %s", (p) => {
    expect(RepoPath.safeParse(p).success).toBe(false);
  });
});

describe("ClientOp", () => {
  it("parses a lock.acquire", () => {
    const op = ClientOp.parse({ op: "lock.acquire", reqId: "1", agentId: "a1", paths: ["src/auth.ts"] });
    expect(op.op).toBe("lock.acquire");
  });

  it("applies defaults for message.send", () => {
    const op = ClientOp.parse({ op: "message.send", reqId: "2", from: { type: "agent", id: "a1" }, body: "hi" });
    expect(op).toMatchObject({ op: "message.send", to: [], kind: "chat" });
  });

  it("applies defaults for plan steps", () => {
    const op = ClientOp.parse({
      op: "plan.set",
      reqId: "3",
      agentId: "a1",
      plan: { title: "Auth refactor", steps: [{ id: "s1", text: "Extract session store" }] },
    });
    expect(op.op === "plan.set" && op.plan.steps[0]?.status).toBe("pending");
    expect(op.op === "plan.set" && op.plan.paths).toEqual([]);
  });

  it("rejects unknown ops", () => {
    expect(ClientOp.safeParse({ op: "nope", reqId: "1" }).success).toBe(false);
  });

  it("rejects a lock on a path outside the repo", () => {
    expect(ClientOp.safeParse({ op: "lock.acquire", reqId: "1", agentId: "a1", paths: ["../x"] }).success).toBe(false);
  });
});

describe("Hello", () => {
  it("requires a secret of reasonable length", () => {
    const base = { op: "hello", member: { id: "m1", name: "Sam" }, deviceId: "d1" };
    expect(Hello.safeParse({ ...base, secret: "short" }).success).toBe(false);
    expect(Hello.safeParse({ ...base, secret: "x".repeat(32) }).success).toBe(true);
  });
});
