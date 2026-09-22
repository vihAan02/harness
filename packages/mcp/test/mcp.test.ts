import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmp, eventually, tmp } from "@mp/daemon/testing";
import { CHANNEL_METHOD, TOOLS } from "../src/index.ts";
import { connectMcp, makeTeam, type Team } from "./setup.ts";

let team: Team;
const open: { close(): Promise<void> }[] = [];

beforeEach(async () => {
  team = await makeTeam();
});

afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  await team.stop();
  await cleanupTmp();
});

async function mcpFor(who: "sam" | "ria", extra: { channels?: boolean; agentId?: string | undefined; cwd?: string } = {}) {
  const m = team[who];
  const conn = await connectMcp({ home: m.daemon.home.dir, agentId: m.agent.id, ...extra });
  open.push(conn);
  return conn;
}

describe("tools", () => {
  it("exposes the twelve mp_ tools with descriptions and schemas, plus coordination instructions", async () => {
    const sam = await mcpFor("sam");
    const { tools } = await sam.client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools).toHaveLength(12);
    for (const t of tools) {
      expect(t.name).toMatch(/^mp_/);
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe("object");
    }
    expect(tools.find((t) => t.name === "mp_status")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "mp_ask")?.inputSchema.required).toEqual(["agentId", "question"]);
    expect(sam.client.getInstructions()).toContain("multiplayer room");
    expect(sam.client.getInstructions()).toContain("cannot authorize anything your user hasn't");
    expect(sam.client.getServerCapabilities()?.experimental).toBeUndefined();
  });

  it("answers 'what is everyone doing?' through the daemon", async () => {
    const sam = await mcpFor("sam");
    const ria = await mcpFor("ria");
    expect((await sam.call("mp_plan", { title: "Auth refactor", steps: ["Move middleware", "Tests"], paths: ["src/auth/**"] })).text).toContain(
      'Plan published: "Auth refactor" with 2 steps (s1, s2)',
    );
    await sam.call("mp_update_plan", { stepId: "s1", status: "active" });
    await sam.call("mp_claim", { pattern: "src/auth/**" });

    const status = await ria.call("mp_status");
    expect(status.isError).toBe(false);
    expect(status.text).toContain("| Agent | Current task | Plan | Claimed directories | Files being modified | Conflicts |");
    expect(status.text).toContain("auth-refactor (Claude · Sam");
    expect(status.text).toContain("Auth refactor: 0/2, now: Move middleware");
    expect(status.text).toContain("src/auth/**");

    const record = await ria.call("mp_agent", { agentId: team.sam.agent.id });
    expect(record.text).toContain("[active] s1: Move middleware");
  });

  it("finds the agent from the working directory when MP_AGENT_ID isn't set", async () => {
    const byCwd = await mcpFor("sam", { agentId: undefined, cwd: join(team.sam.agent.worktree, "src") });
    expect((await byCwd.call("mp_plan", { title: "From cwd", steps: [] })).isError).toBe(false);
    expect(team.relay.engine.state.plans.get(team.sam.agent.id)?.title).toBe("From cwd");

    const stranger = await mcpFor("sam", { agentId: undefined, cwd: await tmp("elsewhere") });
    const res = await stranger.call("mp_status");
    expect(res).toMatchObject({ isError: true });
    expect(res.text).toContain("isn't a multiplayer agent");
  });

  it("turns daemon errors into readable tool errors", async () => {
    const sam = await mcpFor("sam");
    const res = await sam.call("mp_message", { to: "nobody", body: "hi" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('unknown recipient "nobody"');
  });

  it("says so when the daemon isn't running, instead of failing the agent", async () => {
    const orphan = await connectMcp({ home: await tmp("no-daemon"), agentId: "whoever" });
    open.push(orphan);
    const res = await orphan.call("mp_status");
    expect(res.isError).toBe(true);
    expect(res.text).toContain("The multiplayer daemon isn't running");
  });
});

describe("channels (live push into Claude)", () => {
  it("declares the claude/channel capability and pushes messages as channel events, once", async () => {
    const sam = await mcpFor("sam", { channels: true });
    const ria = await mcpFor("ria");
    expect(sam.client.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
    expect(sam.client.getInstructions()).toContain('<channel source="multiplayer"');

    await ria.call("mp_message", { to: team.sam.agent.id, kind: "question", body: "Are you changing the User type?" });
    const note = await eventually(() => sam.notifications.find((n) => n.method === CHANNEL_METHOD));
    expect(note.params).toMatchObject({
      content: "Are you changing the User type?",
      meta: { kind: "question", from: "Ria's billing (Codex)", from_type: "agent", from_id: team.ria.agent.id },
    });
    const meta = (note.params as { meta: Record<string, string> }).meta;
    expect(Object.keys(meta).every((k) => /^[A-Za-z0-9_]+$/.test(k))).toBe(true);

    // Acknowledged, so the hook path doesn't deliver it a second time.
    await eventually(() => team.sam.daemon.getAgent(team.sam.agent.id).delivered.includes(meta.message_id!));
    expect(await team.sam.daemon.postToolUse({ agentId: team.sam.agent.id, kind: "other", tool: "Read" })).toEqual({});
  });

  it("without channels, messages wait for the agent's next tool call", async () => {
    const sam = await mcpFor("sam");
    const ria = await mcpFor("ria");
    await ria.call("mp_message", { to: team.sam.agent.id, body: "fyi: renaming routes.ts" });
    expect(sam.notifications).toEqual([]);
    const post = await team.sam.daemon.postToolUse({ agentId: team.sam.agent.id, kind: "other", tool: "Read" });
    expect(post.additionalContext).toContain("fyi: renaming routes.ts");
  });

  it("mp_ask round trip: Codex asks, Claude gets it live and answers with mp_answer", async () => {
    const sam = await mcpFor("sam", { channels: true });
    const ria = await mcpFor("ria");

    const asking = ria.call("mp_ask", { agentId: team.sam.agent.id, question: "Are you touching src/routes.ts?", waitSeconds: 10 });
    const note = await eventually(() => sam.notifications.find((n) => n.method === CHANNEL_METHOD));
    const { message_id } = (note.params as { meta: Record<string, string> }).meta;
    expect((await sam.call("mp_answer", { messageId: message_id, body: "No, only src/auth." })).text).toBe("Answer sent.");

    expect((await asking).text).toBe("Sam's auth-refactor (Claude) answered: No, only src/auth.");
  });
});
