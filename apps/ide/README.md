# Harness IDE

Harness is a fork of VS Code (Code-OSS) with multiplayer built into the core workbench, not added as an extension.

This folder holds only Harness's side of the fork. The VS Code source is never committed here. `scripts/setup.sh` clones the pinned release (`UPSTREAM`) into `vscode/` (git-ignored), then layers Harness on top.

| Path | What it is |
|---|---|
| `UPSTREAM` | The pinned VS Code tag and the Node version it needs. |
| `src/` | New files, copied into the checkout at the same paths. Upstream never has these, so updates merge trivially. |
| `patches/` | The only edits to upstream files, kept tiny. They register the main-process channel (`app.ts`) and load the Harness service and contribution (`workbench.desktop.main.ts`). |
| `branding/product.overrides.json` | The Harness name, data folders, the Open VSX marketplace, and telemetry off. |
| `scripts/` | `setup.sh` (one-time), `sync.sh` (re-apply Harness), `dev.sh` (build and run). |

## Run it

```bash
apps/ide/scripts/setup.sh        # once: Node 24.18 (local to apps/ide), VS Code 1.138.0, deps (~7 GB)
apps/ide/scripts/dev.sh ~/code/some-repo
```

`dev.sh` does three things:
1. syncs Harness into the checkout
2. transpiles with esbuild (a few seconds)
3. launches the dev build (`.build/electron/Harness.app`)

The IDE starts `mp-daemon` from `packages/daemon` if it isn't already running. Override with `HARNESS_NODE` / `HARNESS_DAEMON_ENTRY`, and use `MP_HOME` for a separate multiplayer home.

**Typecheck (all of VS Code plus Harness, about 10s):**

```bash
(cd apps/ide/vscode && npm run typecheck-client)
```

**Layering rules:**

```bash
(cd apps/ide/vscode && npm run valid-layers-check)
```

## How it fits together

```
window (sandboxed)                       main process                      mp-daemon (localhost)
IMultiplayerService ──IPC 'multiplayer'──► MultiplayerMainService ──HTTP──► /v1/…  (+ SSE room events)
  ├ Room sidebar (first in activity bar)    starts the daemon, proxies        rooms, agents, hooks,
  ├ Room home: "What is everyone doing?"    requests, relays live events      tools, launch specs
  ├ Explorer badges (locked / being changed by another agent)
  ├ status bar: agents · conflicts
  └ commands: New Agent (Claude Code / Codex in a terminal), Create/Join Room, Copy Invite, Message the Room
```

The window can't call the daemon directly: it's sandboxed, and the daemon refuses browser-origin requests. So the main process does it and relays the answers over VS Code's own IPC.

## Built so far

- Room sidebar: people, then their agents, with live status, current step, files and locks.
- Room home (replaces the Welcome page):
  - the "What is everyone doing?" table (agent, task, plan, claims, files being modified, conflicts)
  - room messages
  - live agent activity
- New agent: pick Claude Code or Codex, give it a name and task. Harness creates the worktree and opens the real agent in a terminal, using the launch spec from the daemon.
- Explorer decorations for files other agents have locked or are changing.
- Status bar entry, plus Harness defaults: no Welcome page, no Copilot sign-in overlay, secondary sidebar hidden.

## Next

- In-editor presence (other agents' edit regions), ghost hunks, lock banners, and tab avatars.
- Agent focus, agent graph, and stream wall editors.
- Room chat with `@agent` mentions.
- Title-bar presence bar, per-agent source-control groups, and first-run onboarding (detect `claude` / `codex`).
- Signed and notarized DMG, and auto-update.
