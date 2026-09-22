import { describe, expect, it } from "vitest";
import { computeCollisions, hunksOverlap, matchesPattern, patternsOverlap } from "../src/index.ts";
import { twoAgents } from "./helpers.ts";

describe("paths", () => {
  it.each([
    ["src/api", "src/api/users.ts", true],
    ["src/api/", "src/api/users.ts", true],
    ["src/api", "src/apiv2/x.ts", false],
    ["src/api/**", "src/api/deep/x.ts", true],
    ["src/**/*.ts", "src/a/b.ts", true],
    ["src/**/*.ts", "src/a/b.css", false],
    ["package.json", "package.json", true],
    [".github/**", ".github/workflows/ci.yml", true],
  ])("matchesPattern(%s, %s) = %s", (pattern, path, expected) => {
    expect(matchesPattern(pattern, path)).toBe(expected);
  });

  it.each([
    ["src/api/**", "src/api/billing", true],
    ["src/api/**", "src/web/**", false],
    ["src", "src/api/x.ts", true],
    ["src/api/users.ts", "src/api/**/*.ts", true],
    ["src/api/users.css", "src/api/**/*.ts", false],
    ["**", "anything/at/all", true],
  ])("patternsOverlap(%s, %s) = %s", (a, b, expected) => {
    expect(patternsOverlap(a, b)).toBe(expected);
    expect(patternsOverlap(b, a)).toBe(expected);
  });

  it("detects overlapping and adjacent hunks, not distant ones", () => {
    const h = (oldStart: number, oldLines: number) => ({ oldStart, oldLines, newStart: oldStart, newLines: oldLines });
    expect(hunksOverlap([h(10, 5)], [h(12, 2)])).toBe(true);
    expect(hunksOverlap([h(10, 5)], [h(15, 2)])).toBe(true); // adjacent
    expect(hunksOverlap([h(10, 5)], [h(40, 2)])).toBe(false);
    expect(hunksOverlap([h(10, 0)], [h(10, 3)])).toBe(true); // insertion inside a changed span
  });
});

describe("status: What is everyone doing?", () => {
  it("orders rows by owner, then agent name", () => {
    const h = twoAgents();
    expect(h.engine.status().map((r) => r.agent.owner)).toEqual(["Ria", "Sam"]);
  });

  it("builds one row per agent with task, plan, claims, files and conflicts", () => {
    const h = twoAgents();
    const hunk = (oldStart: number, oldLines: number) => ({ oldStart, oldLines, newStart: oldStart, newLines: oldLines + 1 });

    h.ok("sam", {
      op: "plan.set",
      agentId: "claude-1",
      plan: {
        title: "Auth refactor",
        steps: [
          { id: "s1", text: "Extract session store", status: "done" },
          { id: "s2", text: "Move middleware", status: "active" },
          { id: "s3", text: "Tests" },
        ],
        paths: ["src/auth/**"],
      },
    });
    h.ok("sam", { op: "claim.add", agentId: "claude-1", pattern: "src/auth/**" });
    h.ok("sam", { op: "lock.acquire", agentId: "claude-1", paths: ["src/auth/session.ts"] });
    h.ok("sam", {
      op: "diff.set",
      agentId: "claude-1",
      files: [
        { path: "src/auth/session.ts", status: "modified", additions: 12, deletions: 3, hunks: [hunk(10, 5)] },
        { path: "src/routes.ts", status: "modified", additions: 2, deletions: 0, hunks: [hunk(40, 1)] },
      ],
    });

    h.ok("ria", { op: "agent.upsert", agent: { id: "codex-1", deviceId: "ria-mbp", vendor: "codex", name: "billing", task: "Stripe webhooks" } });
    h.ok("ria", { op: "claim.add", agentId: "codex-1", pattern: "src/billing/**" });
    h.ok("ria", {
      op: "diff.set",
      agentId: "codex-1",
      files: [
        { path: "src/routes.ts", status: "modified", additions: 3, deletions: 1, hunks: [hunk(41, 2)] },
        { path: "src/auth/session.ts", status: "modified", additions: 1, deletions: 0, hunks: [hunk(200, 1)] },
      ],
    });

    const rows = h.engine.status();
    const claude = rows.find((r) => r.agent.id === "claude-1");
    const codex = rows.find((r) => r.agent.id === "codex-1");
    expect(claude).toMatchObject({
      agent: { id: "claude-1", owner: "Sam", vendor: "claude" },
      currentTask: "Auth refactor",
      plan: { title: "Auth refactor", done: 1, total: 3, activeStep: "Move middleware" },
      claimedDirectories: ["src/auth/**"],
      filesBeingModified: [
        { path: "src/auth/session.ts", additions: 12, deletions: 3, locked: true },
        { path: "src/routes.ts", additions: 2, deletions: 0, locked: false },
      ],
    });
    expect(claude!.conflicts).toEqual(
      expect.arrayContaining([
        { kind: "collision", path: "src/routes.ts", with: ["codex-1"], overlappingLines: true },
        { kind: "collision", path: "src/auth/session.ts", with: ["codex-1"], overlappingLines: false },
      ]),
    );

    expect(codex).toMatchObject({ currentTask: "Stripe webhooks", plan: null, claimedDirectories: ["src/billing/**"] });
    expect(codex!.conflicts).toEqual(
      expect.arrayContaining([
        { kind: "in_foreign_claim", path: "src/auth/session.ts", claimPattern: "src/auth/**", owner: "claude-1" },
      ]),
    );

    expect(computeCollisions(h.engine.state)).toEqual([
      { path: "src/auth/session.ts", agentIds: ["claude-1", "codex-1"], overlappingLines: false },
      { path: "src/routes.ts", agentIds: ["claude-1", "codex-1"], overlappingLines: true },
    ]);
  });

  it("shows open reviews and freezes as conflicts", () => {
    const h = twoAgents();
    const { reviewId } = h.ok("ria", {
      op: "review.open",
      review: {
        requesterAgentId: "codex-1",
        command: "git push --force origin main",
        tier: "T2",
        impact: { paths: ["**"], resources: ["origin/main"] },
        affectedAgentIds: ["claude-1"],
        alwaysHuman: true,
      },
    }).result as { reviewId: string };
    h.ok("ria", { op: "freeze.set", reviewId, scope: "room", paths: ["**"] });

    const rows = h.engine.status();
    const claude = rows.find((r) => r.agent.id === "claude-1");
    const codex = rows.find((r) => r.agent.id === "codex-1");
    expect(claude!.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "review", role: "affected", reviewId }),
        expect.objectContaining({ kind: "frozen", reviewId }),
      ]),
    );
    expect(codex!.conflicts).toEqual([expect.objectContaining({ kind: "review", role: "requester" })]);
  });
});
