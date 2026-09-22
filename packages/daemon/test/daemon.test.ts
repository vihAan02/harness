import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Daemon, LocalAgent } from "../src/index.ts";
import { OFFLINE_WARNING, PLAN_REQUIRED } from "../src/index.ts";
import { git, gitOk } from "../src/git.ts";
import { LoopbackRelay, type LoopbackLink } from "../src/testing/loopback.ts";
import { cleanupTmp, eventually, LOOPBACK_INVITE, makeDaemon, makeTeamRepos, ROOM_ID, sleep } from "./fixtures.ts";

let relay: LoopbackRelay;
let samD: Daemon;
let riaD: Daemon;
let repos: Awaited<ReturnType<typeof makeTeamRepos>>;
let claude: LocalAgent;
let codex: LocalAgent;

const plan = { title: "Auth refactor", steps: [{ id: "s1", text: "Move middleware", status: "active" }], paths: ["src/auth/**"] };

beforeEach(async () => {
  repos = await makeTeamRepos();
  relay = new LoopbackRelay(ROOM_ID);
  samD = await makeDaemon(relay, "Sam");
  riaD = await makeDaemon(relay, "Ria");
  await samD.joinRoom({ repoPath: repos.sam, invite: LOOPBACK_INVITE });
  await riaD.joinRoom({ repoPath: repos.ria, invite: LOOPBACK_INVITE });
  claude = await samD.createAgent({ repoPath: repos.sam, name: "auth-refactor", vendor: "claude", task: "Refactor auth" });
  codex = await riaD.createAgent({ repoPath: repos.ria, name: "billing", vendor: "codex", task: "Stripe webhooks" });
});

afterEach(async () => {
  await samD.stop();
  await riaD.stop();
  await cleanupTmp();
});

const edit = (d: Daemon, a: LocalAgent, rel: string) => d.preToolUse({ agentId: a.id, kind: "edit", tool: "Edit", paths: [join(a.worktree, rel)] });

describe("agents and worktrees", () => {
  it("creates a worktree on its own branch from origin/main and registers the agent in the room", async () => {
    expect(claude.branch).toBe("mp/sam/auth-refactor");
    expect(claude.baseRef).toBe("origin/main");
    expect((await stat(join(claude.worktree, "src/auth/session.ts"))).isFile()).toBe(true);
    expect((await git(claude.worktree, ["branch", "--show-current"])).stdout.trim()).toBe("mp/sam/auth-refactor");
    // Ria's daemon sees Sam's agent through the room.
    const seen = riaD.link(ROOM_ID).mirror.state.agents.get(claude.id);
    expect(seen).toMatchObject({ vendor: "claude", name: "auth-refactor", task: "Refactor auth", branch: "mp/sam/auth-refactor" });
  });

  it("finds an agent from the cwd a hook reports", async () => {
    expect((await samD.resolveAgent({ cwd: join(claude.worktree, "src/auth") }))?.id).toBe(claude.id);
    expect(await samD.resolveAgent({ cwd: repos.sam })).toBeUndefined();
  });

  it("removes the worktree but keeps the branch, and leaves the room", async () => {
    await samD.removeAgent(claude.id);
    await expect(stat(claude.worktree)).rejects.toThrow();
    expect(await gitOk(repos.sam, ["rev-parse", "--verify", "--quiet", "refs/heads/mp/sam/auth-refactor"])).toBe(true);
    expect(riaD.link(ROOM_ID).mirror.state.agents.has(claude.id)).toBe(false);
  });

  it("refuses to delete a dirty worktree unless forced", async () => {
    await writeFile(join(claude.worktree, "src/routes.ts"), "dirty\n");
    await expect(samD.removeAgent(claude.id)).rejects.toMatchObject({ code: "worktree_dirty" });
    await samD.removeAgent(claude.id, { force: true });
  });
});

describe("edit hooks", () => {
  it("requires a plan before the first edit", async () => {
    expect(await edit(samD, claude, "src/auth/session.ts")).toEqual({ decision: "deny", reason: PLAN_REQUIRED });
    await samD.tool(claude.id, "plan", plan);
    expect(await edit(samD, claude, "src/auth/session.ts")).toEqual({ decision: "allow" });
    expect(riaD.link(ROOM_ID).mirror.state.locks.get("src/auth/session.ts")?.agentId).toBe(claude.id);
  });

  it("blocks another member's agent on a hot file and explains who holds it", async () => {
    await samD.tool(claude.id, "plan", plan);
    await edit(samD, claude, "src/auth/session.ts");
    await riaD.tool(codex.id, "plan", { title: "Webhooks", steps: ["Add handler"] });

    const denied = await edit(riaD, codex, "src/auth/session.ts");
    expect(denied.decision).toBe("deny");
    const reason = denied.decision === "deny" ? denied.reason : "";
    expect(reason).toContain("src/auth/session.ts is being edited by Sam's auth-refactor (Claude");
    expect(reason).toContain('working on "Auth refactor", current step "Move middleware"');
    expect(reason).toContain(`mp_ask with agentId "${claude.id}"`);
  });

  it("warns once when entering another agent's claimed area, without blocking", async () => {
    await samD.tool(claude.id, "plan", plan);
    await samD.tool(claude.id, "claim", { pattern: "src/auth/**", reason: "auth refactor" });
    await riaD.tool(codex.id, "plan", { title: "Webhooks", steps: ["Add handler"] });

    const first = await edit(riaD, codex, "src/auth/middleware.ts");
    expect(first.decision).toBe("allow");
    expect(first.decision === "allow" && first.additionalContext).toContain("inside Sam's auth-refactor (Claude)'s claimed area src/auth/**");
    const second = await edit(riaD, codex, "src/auth/middleware.ts");
    expect(second).toEqual({ decision: "allow" });
  });

  it("never locks lockfiles", async () => {
    await samD.tool(claude.id, "plan", plan);
    await riaD.tool(codex.id, "plan", { title: "Webhooks", steps: [] });
    expect(await edit(samD, claude, "package-lock.json")).toEqual({ decision: "allow" });
    expect(await edit(riaD, codex, "package-lock.json")).toEqual({ decision: "allow" });
    expect(relay.engine.state.locks.size).toBe(0);
  });

  it("denies edits in the main checkout or another worktree", async () => {
    await samD.tool(claude.id, "plan", plan);
    const res = await samD.preToolUse({ agentId: claude.id, kind: "edit", tool: "Write", paths: [join(repos.sam, "src/routes.ts")] });
    expect(res.decision).toBe("deny");
    expect(res.decision === "deny" && res.reason).toContain("the main checkout");
  });

  it("lets edits through with a warning while the room is unreachable", async () => {
    (samD.link(ROOM_ID) as LoopbackLink).setOnline(false);
    expect(await edit(samD, claude, "src/auth/session.ts")).toEqual({ decision: "allow", additionalContext: OFFLINE_WARNING });
  });

  it("holds an edit while a review freezes the file, then lets it through", async () => {
    await samD.tool(claude.id, "plan", plan);
    const link = riaD.link(ROOM_ID);
    const { reviewId } = (await link.request({
      op: "review.open",
      review: { requesterAgentId: codex.id, command: "pnpm add zod@4", tier: "T2", impact: { paths: ["src/auth/**"], resources: [] }, affectedAgentIds: [claude.id] },
    })) as { reviewId: string };
    await link.request({ op: "freeze.set", reviewId, scope: "agents", agentIds: [claude.id], paths: ["src/auth/**"] });

    let settled = false;
    const pending = edit(samD, claude, "src/auth/session.ts").then((d) => ((settled = true), d));
    await sleep(50);
    expect(settled).toBe(false);
    await link.request({ op: "freeze.clear", reviewId });
    expect(await pending).toEqual({ decision: "allow" });
  });

  it("gives up on a hold after the timeout with an explanation", async () => {
    await samD.stop();
    samD = await makeDaemon(relay, "Sam", { holdTimeoutMs: 100, home: samD.home.dir });
    await samD.joinRoom({ repoPath: repos.sam, invite: LOOPBACK_INVITE });
    await samD.tool(claude.id, "plan", plan);
    const link = riaD.link(ROOM_ID);
    const { reviewId } = (await link.request({
      op: "review.open",
      review: { requesterAgentId: codex.id, command: "git push --force origin main", tier: "T2", impact: { paths: ["**"], resources: [] }, affectedAgentIds: [claude.id] },
    })) as { reviewId: string };
    await link.request({ op: "freeze.set", reviewId, scope: "room", paths: ["**"] });
    const res = await edit(samD, claude, "src/auth/session.ts");
    expect(res.decision).toBe("deny");
    expect(res.decision === "deny" && res.reason).toContain("git push --force origin main");
  });
});

describe("live diffs and status", () => {
  it("publishes exact changed lines after an edit, so the other daemon sees files, locks and collisions", async () => {
    await samD.tool(claude.id, "plan", plan);
    await riaD.tool(codex.id, "plan", { title: "Webhooks", steps: [] });

    await edit(samD, claude, "src/routes.ts");
    await writeFile(join(claude.worktree, "src/routes.ts"), "export const a = 10;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\n");
    await samD.postToolUse({ agentId: claude.id, kind: "edit", tool: "Edit", paths: [join(claude.worktree, "src/routes.ts")] });
    await samD.settle();

    // Ria's Codex changed the adjacent line without asking for a lock (e.g. via the shell).
    await writeFile(join(codex.worktree, "src/routes.ts"), "export const a = 1;\nexport const b = 20;\nexport const c = 3;\nexport const d = 4;\n");
    await riaD.postToolUse({ agentId: codex.id, kind: "bash", tool: "Bash", command: "sed -i ..." });
    await riaD.settle();

    const mirror = riaD.link(ROOM_ID).mirror;
    expect(mirror.state.diffs.get(claude.id)?.files).toMatchObject([
      { path: "src/routes.ts", additions: 1, deletions: 1, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] },
    ]);
    const row = mirror.status().find((r) => r.agent.id === codex.id)!;
    expect(row.filesBeingModified).toEqual([{ path: "src/routes.ts", additions: 1, deletions: 1, locked: false }]);
    expect(row.conflicts).toContainEqual({ kind: "collision", path: "src/routes.ts", with: [claude.id], overlappingLines: true });

    const table = (await riaD.tool(codex.id, "status", {})).text;
    expect(table).toContain("| Agent | Current task | Plan | Claimed directories | Files being modified | Conflicts |");
    expect(table).toContain("auth-refactor (Claude · Sam");
    expect(table).toContain("billing (Codex · Ria");
    expect(table).toContain("src/routes.ts +1/-1 (locked)");
    expect(table).toContain("(same lines)");
  });

  it("re-registers and republishes after reconnecting", async () => {
    await writeFile(join(claude.worktree, "README.md"), "# changed\n");
    const link = samD.link(ROOM_ID) as LoopbackLink;
    link.setOnline(false);
    await samD.postToolUse({ agentId: claude.id, kind: "edit", tool: "Edit" });
    await samD.settle();
    expect(relay.engine.state.diffs.get(claude.id)?.files ?? []).toEqual([]);

    link.setOnline(true);
    await eventually(() => relay.engine.state.diffs.get(claude.id)?.files.some((f) => f.path === "README.md"));
  });
});

describe("messages between agents", () => {
  it("delivers messages to the addressed agent exactly once, via the post-tool hook", async () => {
    await riaD.tool(codex.id, "message", { to: claude.id, body: "Heads up: I'm changing routes.ts" });
    const first = await samD.postToolUse({ agentId: claude.id, kind: "other", tool: "Read" });
    expect(first.additionalContext).toContain("from Ria's billing (Codex): Heads up: I'm changing routes.ts");
    expect(await samD.postToolUse({ agentId: claude.id, kind: "other", tool: "Read" })).toEqual({});
    // The sender doesn't get its own message back.
    expect(await riaD.postToolUse({ agentId: codex.id, kind: "other", tool: "Read" })).toEqual({});
  });

  it("mp_ask waits for the other agent's mp_answer", async () => {
    const asking = riaD.tool(codex.id, "ask", { agentId: claude.id, question: "What are you doing in src/auth?", waitSeconds: 5 });

    const delivered = await eventually(async () => (await samD.postToolUse({ agentId: claude.id, kind: "other", tool: "Read" })).additionalContext);
    expect(delivered).toContain("[question] from Ria's billing (Codex): What are you doing in src/auth?");
    const messageId = /messageId "([^"]+)"/.exec(delivered)![1]!;
    await samD.tool(claude.id, "answer", { messageId, body: "Moving the middleware; session.ts stays as is." });

    const res = await asking;
    expect(res.text).toBe("Sam's auth-refactor (Claude) answered: Moving the middleware; session.ts stays as is.");
  });

  it("mp_ask returns promptly when nobody answers", async () => {
    const res = await riaD.tool(codex.id, "ask", { agentId: claude.id, question: "ping?", waitSeconds: 0.05 });
    expect(res.data).toMatchObject({ answered: false });
  });

  it("describes another agent's work without interrupting it", async () => {
    await samD.tool(claude.id, "plan", plan);
    await samD.tool(claude.id, "claim", { pattern: "src/auth/**" });
    await samD.pushStream(claude.id, [{ at: Date.now(), kind: "message", text: "Extracting the session store" }]);
    await samD.settle();
    const text = (await riaD.tool(codex.id, "agent", { agentId: claude.id })).text;
    expect(text).toContain('Plan "Auth refactor"');
    expect(text).toContain("[active] s1: Move middleware");
    expect(text).toContain("Claimed: src/auth/**");
    expect(text).toContain("message: Extracting the session store");
  });

  it("who_touches reports locks, claims, changes and plans for a path", async () => {
    await samD.tool(claude.id, "plan", plan);
    await samD.tool(claude.id, "claim", { pattern: "src/auth/**" });
    await edit(samD, claude, "src/auth/session.ts");
    const text = (await riaD.tool(codex.id, "who_touches", { path: "src/auth/session.ts" })).text;
    expect(text).toContain("locked by Sam's auth-refactor (Claude): src/auth/session.ts");
    expect(text).toContain("claimed by Sam's auth-refactor (Claude): src/auth/**");
    expect(text).toContain('in the plan of Sam\'s auth-refactor (Claude): "Auth refactor"');
  });

  it("rejects bad tool arguments with a readable error", async () => {
    await expect(riaD.tool(codex.id, "message", { to: "nobody", body: "hi" })).rejects.toThrow(/unknown recipient "nobody"/);
    await expect(riaD.tool(codex.id, "nope", {})).rejects.toThrow(/unknown tool/);
  });
});
