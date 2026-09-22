import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { startServer, type Daemon, type LocalAgent, type ServerHandle } from "@mp/daemon";
import { LOOPBACK_INVITE, LoopbackRelay, makeDaemon, makeTeamRepos, ROOM_ID } from "@mp/daemon/testing";
import { DaemonClient, createMultiplayerServer } from "../src/index.ts";

export interface Team {
  relay: LoopbackRelay;
  sam: { daemon: Daemon; http: ServerHandle; agent: LocalAgent };
  ria: { daemon: Daemon; http: ServerHandle; agent: LocalAgent };
  stop(): Promise<void>;
}

/** Two teammates' daemons in one room, each serving its localhost API and advertising it in daemon.json. */
export async function makeTeam(): Promise<Team> {
  const repos = await makeTeamRepos();
  const relay = new LoopbackRelay(ROOM_ID);
  const up = async (name: string, repoPath: string, agentName: string, vendor: "claude" | "codex") => {
    const daemon = await makeDaemon(relay, name);
    await daemon.joinRoom({ repoPath, invite: LOOPBACK_INVITE });
    const agent = await daemon.createAgent({ repoPath, name: agentName, vendor });
    const token = `${name.toLowerCase()}-token-${"x".repeat(24)}`;
    const http = await startServer(daemon, { port: 0, token });
    await daemon.home.writeDaemonInfo({ pid: process.pid, port: http.port, token, startedAt: Date.now() });
    return { daemon, http, agent };
  };
  const sam = await up("Sam", repos.sam, "auth-refactor", "claude");
  const ria = await up("Ria", repos.ria, "billing", "codex");
  return {
    relay,
    sam,
    ria,
    async stop() {
      for (const m of [sam, ria]) {
        await m.http.close();
        await m.daemon.stop();
      }
    },
  };
}

/** An MCP client connected in-process to a multiplayer server for one agent. */
export async function connectMcp(opts: { home: string; agentId?: string; cwd?: string; channels?: boolean }) {
  const mp = createMultiplayerServer({
    client: new DaemonClient({ home: opts.home }),
    agentId: opts.agentId,
    cwd: opts.cwd ?? "/",
    channels: opts.channels ?? false,
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-agent", version: "0.0.0" });
  const notifications: Notification[] = [];
  client.fallbackNotificationHandler = async (n) => {
    notifications.push(n);
  };
  await mp.server.connect(serverSide);
  await client.connect(clientSide);
  mp.startFeed();
  return {
    client,
    notifications,
    async call(name: string, args: Record<string, unknown> = {}) {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
      return { text, isError: res.isError === true };
    },
    async close() {
      await client.close();
      await mp.close();
    },
  };
}
