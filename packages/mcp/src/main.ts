#!/usr/bin/env node
/**
 * mp-mcp: the `multiplayer` MCP server, launched over stdio by Claude Code or Codex (one per agent session).
 *
 * Environment:
 *   MP_AGENT_ID      the agent this session is (set by the IDE); otherwise found from the working directory
 *   MP_CHANNELS=1    push room messages into a Claude session as channel events (set together with
 *                    `--dangerously-load-development-channels server:multiplayer`)
 *   MP_HOME          where mp-daemon keeps daemon.json (default ~/.multiplayer)
 *   MP_DAEMON_URL / MP_DAEMON_TOKEN   explicit daemon endpoint, overriding daemon.json
 *
 * stdout carries the MCP protocol, so all logging goes to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { DaemonClient } from "./daemon-client.ts";
import { createMultiplayerServer } from "./server.ts";

const log = (m: string) => process.stderr.write(`[mp-mcp] ${m}\n`);

const mp = createMultiplayerServer({
  client: new DaemonClient({ home: process.env.MP_HOME, url: process.env.MP_DAEMON_URL, token: process.env.MP_DAEMON_TOKEN }),
  agentId: process.env.MP_AGENT_ID || undefined,
  cwd: process.cwd(),
  channels: process.env.MP_CHANNELS === "1",
  log,
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await mp.close().catch(() => undefined);
  process.exit(0);
};
process.stdin.on("close", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

await mp.server.connect(new StdioServerTransport());
mp.startFeed();
