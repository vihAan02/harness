import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unstable_startWorker } from "wrangler";
import { Daemon } from "../src/index.ts";
import { cleanupTmp, eventually, makeTeamRepos, tmp } from "./fixtures.ts";

/**
 * Two real daemons (separate homes, separate identities) talking to the real relay Worker over
 * WebSockets, run locally by wrangler. This is the "two daemons" check from milestone M1.
 */
const relayConfig = resolve(fileURLToPath(import.meta.url), "../../../../apps/relay/wrangler.jsonc");

let worker: Awaited<ReturnType<typeof unstable_startWorker>>;
let relayUrl: string;

beforeAll(async () => {
  worker = await unstable_startWorker({
    config: relayConfig,
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: false, logLevel: "none" },
  });
  await worker.ready;
  relayUrl = (await worker.url).origin;
}, 60_000);

afterAll(async () => {
  await worker?.dispose();
  await cleanupTmp();
});

async function daemonFor(name: string) {
  const d = new Daemon({ home: await tmp(`int-${name}`), watch: false, fetchOnCreate: false, diffDebounceMs: 5, statusDebounceMs: 5 });
  await d.start();
  d.identity = await d.home.setName(name);
  return d;
}

describe("two daemons through the real relay", () => {
  it("share presence, plans, locks, diffs and messages", async () => {
    const repos = await makeTeamRepos();
    const sam = await daemonFor("Sam");
    const ria = await daemonFor("Ria");
    try {
      const room = await sam.createRoom({ repoPath: repos.sam, relayUrl });
      expect(room.invite).toMatch(new RegExp(`^${relayUrl}/join/[0-9a-f]{24}#`));
      await ria.joinRoom({ repoPath: repos.ria, invite: room.invite });

      const claude = await sam.createAgent({ repoPath: repos.sam, name: "auth-refactor", vendor: "claude" });
      const codex = await ria.createAgent({ repoPath: repos.ria, name: "billing", vendor: "codex" });
      await eventually(() => ria.link(room.roomId).mirror.state.agents.has(claude.id));

      await sam.tool(claude.id, "plan", { title: "Auth refactor", steps: [{ text: "Move middleware", status: "active" }] });
      expect(await sam.preToolUse({ agentId: claude.id, kind: "edit", tool: "Edit", paths: [join(claude.worktree, "src/auth/session.ts")] })).toEqual({
        decision: "allow",
      });

      await ria.tool(codex.id, "plan", { title: "Webhooks", steps: ["Add handler"] });
      await eventually(() => ria.link(room.roomId).mirror.state.locks.has("src/auth/session.ts"));
      const denied = await ria.preToolUse({ agentId: codex.id, kind: "edit", tool: "Edit", paths: [join(codex.worktree, "src/auth/session.ts")] });
      expect(denied.decision).toBe("deny");
      expect(denied.decision === "deny" && denied.reason).toContain("Sam's auth-refactor (Claude");

      await ria.tool(codex.id, "message", { to: claude.id, kind: "question", body: "Can I touch session.ts after you?" });
      const inbox = await eventually(async () => (await sam.postToolUse({ agentId: claude.id, kind: "other", tool: "Read" })).additionalContext);
      expect(inbox).toContain("Can I touch session.ts after you?");

      const status = await ria.tool(codex.id, "status", {});
      expect(status.text).toContain("auth-refactor (Claude · Sam");
      expect(status.text).toContain("src/auth/session.ts +0/-0 (locked)");
    } finally {
      await sam.stop();
      await ria.stop();
    }
  });

  it("rejects a tampered invite", async () => {
    const repos = await makeTeamRepos();
    const sam = await daemonFor("Sam2");
    const eve = await daemonFor("Eve");
    try {
      const room = await sam.createRoom({ repoPath: repos.sam, relayUrl });
      const tampered = room.invite.replace(/#.*/, "#" + "x".repeat(43));
      await expect(eve.joinRoom({ repoPath: repos.ria, invite: tampered })).rejects.toMatchObject({ code: "unauthorized" });
      expect(eve.listRooms()).toEqual([]);
    } finally {
      await sam.stop();
      await eve.stop();
    }
  });
});
