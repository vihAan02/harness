# multiplayer-ai

Coordination backend for a multiplayer AI IDE: many Claude Code and Codex agents, on many devices, working on one repo at once. They share plans, claimed directories, live diffs and messages, and coordinate through locks and reviews.

The IDE itself (a Code-OSS fork) lives in a separate repo. See the plan for the full design.

## Layout

| Path | What it is |
|---|---|
| `packages/protocol` | Wire protocol (zod): entities, client ops, server messages, agent stream events, status rows. |
| `packages/room` | Pure, deterministic room engine: locks, claims, plans, threads, reviews, freezes, expiry, and the "What is everyone doing?" status. The relay runs it authoritatively; daemons mirror it. |
| `apps/relay` | Cloudflare Worker + one SQLite-backed Durable Object per room. Hibernatable WebSockets, replay-on-reconnect, alarms for expiry. Runs on the Workers Free plan. |

Next up (milestones M1–M3): `packages/daemon`, `packages/mcp`, `packages/adapter-claude`, `packages/adapter-codex`, `packages/hook-shim`.

## Commands

```bash
npm install
npm test            # all workspaces (relay tests run in the local Workers runtime)
npm run typecheck
npm run dev -w @mp/relay     # local relay on http://localhost:8787
npm run deploy -w @mp/relay  # deploy to your Cloudflare account (free plan works)
```

## Relay protocol in one screen

1. `POST /rooms` returns `{ roomId, secret }`. Share both in the invite link. If the `CREATE_TOKEN` secret is set, the request needs `Authorization: Bearer <CREATE_TOKEN>`.
2. Open a WebSocket to `GET /rooms/:roomId/ws`. The first frame must be `{ op: "hello", secret, member, deviceId, lastSeq? }`.
3. The relay answers with `welcome`, in one of two modes:
   - `mode: "replay"` with the events after `lastSeq`
   - `mode: "snapshot"` with the full state
4. Every later op carries a `reqId` and gets an `ack`. State changes are broadcast as `{ t: "event", event }` with a gap-free `seq`. Agent stream entries go out as ephemeral `{ t: "stream" }` frames.
5. Send the text frame `ping` to get `pong`. This keeps the socket alive without waking the Durable Object.
