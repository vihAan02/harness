import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cleanupTmp } from "@mp/daemon/testing";
import { makeTeam, type Team } from "./setup.ts";

const MAIN = fileURLToPath(new URL("../src/main.ts", import.meta.url));
let team: Team;

beforeAll(async () => {
  team = await makeTeam();
});

afterAll(async () => {
  await team.stop();
  await cleanupTmp();
});

/** Launches mp-mcp exactly the way Claude Code and Codex do: a child process speaking MCP over stdio. */
describe("mp-mcp over stdio", () => {
  it("starts, lists tools, and answers mp_status for the agent named in MP_AGENT_ID", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-deprecation", MAIN],
      env: { ...(process.env as Record<string, string>), MP_HOME: team.sam.daemon.home.dir, MP_AGENT_ID: team.sam.agent.id },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("multiplayer");
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(12);
      const res = await client.callTool({ name: "mp_status", arguments: {} });
      const text = (res.content as { text: string }[])[0]!.text;
      expect(text).toContain("auth-refactor (Claude · Sam");
      expect(text).toContain("billing (Codex · Ria");
    } finally {
      await client.close();
    }
  });
});
