import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FeedMessage } from "@mp/daemon";
import { DaemonClient, DaemonRequestError, DaemonUnavailable } from "./daemon-client.ts";
import { serverInstructions } from "./instructions.ts";
import { TOOLS } from "./tools.ts";

export const SERVER_NAME = "multiplayer";
export const CHANNEL_METHOD = "notifications/claude/channel";

export interface MultiplayerServerOptions {
  client: DaemonClient;
  /** MP_AGENT_ID, set by the IDE when it launches the agent. */
  agentId?: string | undefined;
  /** Fallback: the daemon finds the agent whose worktree contains this directory. */
  cwd: string;
  /** MP_CHANNELS=1: this Claude session was started with our channel enabled, so push messages. */
  channels: boolean;
  version?: string;
  log?: (message: string) => void;
}

export interface MultiplayerServer {
  server: McpServer;
  /** Starts pushing room messages as channel events (no-op unless channels are on). Call after connect. */
  startFeed(): void;
  close(): Promise<void>;
}

function text(t: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

/** Channel meta keys must be identifiers (letters, digits, underscores). */
export function channelParams(m: FeedMessage): { content: string; meta: Record<string, string> } {
  return {
    content: m.body,
    meta: {
      kind: m.kind,
      from: m.from.label,
      from_type: m.from.type,
      from_id: m.from.id,
      message_id: m.id,
      thread_id: m.threadId,
      ...(m.replyTo ? { reply_to: m.replyTo } : {}),
      ...(m.urgent ? { urgent: "true" } : {}),
    },
  };
}

export function createMultiplayerServer(opts: MultiplayerServerOptions): MultiplayerServer {
  const log = opts.log ?? (() => undefined);
  const server = new McpServer(
    { name: SERVER_NAME, version: opts.version ?? "0.0.1" },
    {
      instructions: serverInstructions(opts.channels),
      capabilities: opts.channels ? { experimental: { "claude/channel": {} } } : {},
    },
  );

  let cachedAgent: string | null = opts.agentId ?? null;
  const agentId = async (): Promise<string> => {
    if (cachedAgent) return cachedAgent;
    try {
      cachedAgent = (await opts.client.resolveAgent(opts.cwd)).id;
      return cachedAgent;
    } catch (err) {
      if (err instanceof DaemonRequestError && err.status === 404) {
        throw new Error(
          "This session isn't a multiplayer agent, so the room tools don't apply here. Start the agent from the IDE's New agent command (or set MP_AGENT_ID).",
        );
      }
      throw err;
    }
  };

  const explain = (err: unknown): string => {
    if (err instanceof DaemonUnavailable) {
      return "The multiplayer daemon isn't running, so the room is unavailable. Keep working on your task; coordination will resume when it's back.";
    }
    if (err instanceof DaemonRequestError) return err.message;
    return err instanceof Error ? err.message : String(err);
  };

  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { title: def.title, readOnlyHint: def.readOnly, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        try {
          const res = await opts.client.tool(await agentId(), def.daemonTool, args ?? {});
          return text(res.text);
        } catch (err) {
          return text(explain(err), true);
        }
      },
    );
  }

  const abort = new AbortController();
  const runFeed = async () => {
    let backoff = 500;
    while (!abort.signal.aborted) {
      try {
        const id = await agentId();
        for await (const batch of opts.client.feed(id, abort.signal)) {
          backoff = 500;
          const sent: string[] = [];
          for (const m of batch) {
            await server.server.notification({ method: CHANNEL_METHOD, params: channelParams(m) });
            sent.push(m.id);
          }
          if (sent.length) await opts.client.ack(id, sent);
        }
      } catch (err) {
        if (abort.signal.aborted) return;
        log(`feed interrupted: ${explain(err)}`);
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  };

  return {
    server,
    startFeed() {
      if (opts.channels) void runFeed();
    },
    async close() {
      abort.abort();
      await server.close();
    },
  };
}
