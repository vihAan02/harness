# harness-ai

**A multiplayer coordination layer for humans and AI agents working across machines, models, and eventually data sources.**

The first wedge: **several humans, each running their own AI coding agents on their own machines, coordinating on one repository as one AI-augmented engineering team.**

## Status (2026-10-02)

**Phase 0A is under way. The repo skeleton, the data model, the coordination server and harnessd exist; running agents and the coordination features don't yet.**
- The architecture, decisions, risks, roadmap and validation plan are written down.
- Phase 0A is approved (D-59). Its throwaway adapter spike is done and accepted ([docs/research/spike-0a.md](docs/research/spike-0a.md)), with architecture changes D-60 to D-70 (D-71).
- The code lives in `packages/` (D-72 to D-78). See [Running locally](#running-locally).
- The canonical next steps are in [PLAN.md §12](PLAN.md#12-what-must-happen-before-and-during-phase-0a).

## Running locally

You need Node 24 or later and PostgreSQL 18.
1. **Install dependencies:** `npm install`.
2. **Start Postgres.** With Homebrew on macOS (`brew install postgresql@18`), either:
   - `brew services start postgresql@18`, which also starts it at every login; or
   - `/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D /opt/homebrew/var/postgresql@18 -l /opt/homebrew/var/postgresql@18/server.log start`, for this session only.
   
   If the log says "postmaster became multithreaded during startup", your shell has no locale. Prefix the command with `LC_ALL=en_US.UTF-8`.
3. **Create the two databases, once:** `createdb harness_dev` and `createdb harness_test`. Homebrew's `postgresql@18` binaries live in `/opt/homebrew/opt/postgresql@18/bin`, which isn't on your `PATH` by default.
4. **Check:** `npm run check` type-checks everything and runs the tests.
   - The server tests use `HARNESS_TEST_DATABASE_URL` (default `postgresql://localhost:5432/harness_test`).
   - Each test file makes its own throwaway schema there and drops it afterwards.
5. **Run the coordination server (optional):**
   - Set a local token once per shell: `export HARNESS_LOCAL_TOKEN=$(openssl rand -hex 32)`.
   - Then `npm run server`. It migrates `harness_dev` (or `HARNESS_DATABASE_URL`) and listens on `ws://127.0.0.1:7400` (`HARNESS_PORT` to change).
   - Every client has to present that token (D-74).
6. **Run harnessd (optional):**
   - Put the same token in `~/.harness/token` (`chmod 600`).
   - Write `~/.harness/config.toml`: `device_id`, `principal`, `server_url`, and one `[[projects]]` entry per allowlisted repo. The format is at the top of `packages/daemon/src/config.ts`.
   - Then `npm run daemon`.
   - A repo's `harness.yaml` setup command runs only after you approve it: `npx harness approve` lists the pending ones (D-52).
   - Agents run on an Anthropic API key, never a subscription login (D-56). Export `ANTHROPIC_API_KEY` before starting harnessd; it passes the key to Claude Code and hides it from the agent's shell (D-64).

## The idea in one screen

- **Coordination is shared; disk state isn't.**
  - Git syncs code.
  - A coordination server (Postgres + WebSocket) syncs tasks, ownership, claims, read sets, typed messages and presence.
- **A daemon on each machine (`harnessd`) is the execution and security boundary.**
  - It runs agents (Claude Code, and later Codex and others) through one adapter per vendor, each in its own Git worktree.
  - It watches what they edit and read, owns all Git writes, and delivers messages at safe boundaries (between tool calls or at turn end).
- **The core product behavior is catching stale context.**
  - "Dependency changed: src/types.ts has changed since you read it."
  - That matters more than file locks.
- **Claims, from prospective to observed to hard, are awareness signals, not guarantees.** Peer-agent messages are sparse, typed and untrusted.
- **The vision is big:**
  - many humans, agents, machines and vendors;
  - contract awareness;
  - cloud agents;
  - shared artifacts;
  - non-Git sources;
  - eventually a secure hybrid file/data fabric.
- **The build sequence is strict:** 0A (core loop) → 0B (stale-context protection) → **an A/B test against "two terminals + two branches + a human relaying in Slack"** → Phase 1 multiplayer.

## Read next

1. [PLAN.md](PLAN.md): the source of truth. Vision, principles, decisions, hypotheses, risks, sequence.
2. [docs/architecture.md](docs/architecture.md), then [docs/coordination.md](docs/coordination.md).
3. [docs/roadmap.md](docs/roadmap.md) and [docs/validation.md](docs/validation.md).
4. [docs/open-questions.md](docs/open-questions.md).

AI agents working in this repo: start with [AGENTS.md](AGENTS.md).
