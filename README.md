# multiplayer-ai

Coordination backend for a multiplayer AI IDE: many Claude Code and Codex agents, on many devices, working on one repo at once. They share plans, claimed directories, live diffs and messages, and coordinate through locks and reviews.

The IDE itself (a Code-OSS fork) lives in a separate repo. See the plan for the full design.

## Layout

| Path | What it is |
|---|---|
| `packages/protocol` | Wire protocol (zod): entities, client ops, server messages, agent stream events, status rows. |
| `packages/room` | Pure, deterministic room engine: locks, claims, plans, threads, reviews, freezes, expiry, and the "What is everyone doing?" status. The relay runs it authoritatively; daemons mirror it. |
| `apps/relay` | Cloudflare Worker + one SQLite-backed Durable Object per room. Hibernatable WebSockets, replay-on-reconnect, alarms for expiry. Runs on the Workers Free plan. |
| `packages/daemon` | `mp-daemon`, one per machine; the IDE runs it as a background process. It keeps a live mirror of each room, gives every agent its own git worktree and branch, answers agent hooks, publishes live diffs and streams, delivers messages, and serves the `mp_*` agent tools over a localhost API. |

| `packages/mcp` | `mp-mcp`, the `multiplayer` MCP server. Claude Code and Codex launch it over stdio, one per agent session. It exposes the 12 `mp_*` tools, briefs the agent on how to coordinate, and (for Claude) pushes room messages into the session live as channel events. |

Next up: `packages/adapter-claude` (plugin: hooks + MCP config), `packages/adapter-codex`, `packages/hook-shim`.

## Commands

```bash
npm install
npm test            # all workspaces (relay tests run in the local Workers runtime)
npm run typecheck
npm run dev -w @mp/relay     # local relay on http://localhost:8787
npm run deploy -w @mp/relay  # deploy to your Cloudflare account (free plan works)
npm start -w @mp/daemon      # run mp-daemon (MP_HOME defaults to ~/.multiplayer, port 47800)
```

## Daemon in one screen

- **Home:** `~/.multiplayer/` (`0700`) holds four files: `identity.json`, `rooms.json` (room secrets, `0600`), `agents.json`, and `daemon.json` (pid, port and API token, `0600`). Agent worktrees live in `worktrees/<repo>/<agent>` on branches `mp/<you>/<agent>`.
- **API:** `http://127.0.0.1:47800/v1/...`, which needs `Authorization: Bearer <token from daemon.json>`. Requests with a browser `Origin` header or a foreign `Host` are refused.
  - Rooms: `POST /rooms` (create), `POST /rooms/join` (invite link), `GET /rooms/:id/status` ("What is everyone doing?")
  - Agents: `POST /agents` (worktree + register), `DELETE /agents/:id`, `POST /agents/:id/stream`
  - Hooks: `POST /hooks/pre` and `POST /hooks/post`, with a vendor-neutral `{ cwd | agentId, kind, tool, paths, command }` body
  - Tools: `POST /agents/:id/tools/:name`, where the name is one of `status`, `agent`, `plan`, `update_plan`, `claim`, `release`, `message`, `answer`, `inbox`, `who_touches`, `ask`, `handoff`
- **Edit policy:**
  1. Edits in another checkout are denied.
  2. The agent must have published a plan.
  3. Entering another agent's claim triggers a one-time warning.
  4. The hot-file lock comes from the relay, except for lockfiles. If another agent holds it, the edit is denied with who holds it and why.
  5. A review freeze holds the edit until it clears.

  If the relay is unreachable, edits are allowed with a warning.

## MCP server in one screen

- **Launch:** `node packages/mcp/src/main.ts` over stdio.
  - `MP_AGENT_ID` names the agent. Without it, the agent is found from the working directory.
  - `MP_HOME` locates the daemon.
  - `MP_CHANNELS=1` turns on live push.
- **Tools:**
  - reading the room: `mp_status`, `mp_agent`, `mp_who_touches`
  - planning and claims: `mp_plan`, `mp_update_plan`, `mp_claim`, `mp_release`
  - messaging: `mp_message`, `mp_answer`, `mp_inbox`, `mp_ask`, `mp_handoff`
- **Live push (Claude):** with `MP_CHANNELS=1`, the server declares `claude/channel`. It streams the agent's messages from the daemon (`GET /v1/agents/:id/feed`) and emits each as a `notifications/claude/channel` event. It then acknowledges them (`POST /v1/agents/:id/feed/ack`), and only then does the daemon count them as delivered. Unacknowledged messages fall back to hook delivery after 30s.
  - Only set `MP_CHANNELS=1` when Claude is started with `--dangerously-load-development-channels server:multiplayer`. Otherwise Claude silently drops channel events.
- **Failure mode:** if the daemon is down, tools return a readable error and the agent keeps working.

## Relay protocol in one screen

1. `POST /rooms` returns `{ roomId, secret }`. Share both in the invite link. If the `CREATE_TOKEN` secret is set, the request needs `Authorization: Bearer <CREATE_TOKEN>`.
2. Open a WebSocket to `GET /rooms/:roomId/ws`. The first frame must be `{ op: "hello", secret, member, deviceId, lastSeq? }`.
3. The relay answers with `welcome`, in one of two modes:
   - `mode: "replay"` with the events after `lastSeq`
   - `mode: "snapshot"` with the full state
4. Every later op carries a `reqId` and gets an `ack`. State changes are broadcast as `{ t: "event", event }` with a gap-free `seq`. Agent stream entries go out as ephemeral `{ t: "stream" }` frames.
5. Send the text frame `ping` to get `pong`. This keeps the socket alive without waking the Durable Object.
