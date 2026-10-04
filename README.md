# harness-ai

**A multiplayer coordination layer for humans and AI agents working across machines, models, and eventually data sources.**

The first wedge: **several humans, each running their own AI coding agents on their own machines, coordinating on one repository as one AI-augmented engineering team.**

## Status (2026-10-03)

**Phase 0A is built; Phase 0B is approved and under way (D-86).**
- 0A: the coordination server, harnessd, the Claude adapter, soft claims, typed messages, the CLI, metrics and the benchmark app. Every 0A exit criterion is met with a scripted model (`npm run demo`, D-84).
- Agents can run on any Anthropic-compatible model endpoint by configuration; DeepSeek `deepseek-flash` is the cheap default for development (D-87). See [Choosing a model provider](#choosing-a-model-provider).
- 0B's first stretch is built: read capture, stale-context notices with sync at turn end, and the local land step (`harness land`). The S3 example ("Dependency changed: src/types.ts has changed since you read it.", with a diff) passes end to end with the scripted model (PLAN.md §12).
- The code lives in `packages/`. See [Running locally](#running-locally). The canonical next steps are in [PLAN.md §12](PLAN.md#12-what-must-happen-before-and-during-phase-0a); the hand-over notes are in [HANDOFF.md](HANDOFF.md).

## Running locally

**The quickest look:** with Postgres running (steps 1–3 below), `npm run demo` brings up the whole stack. Two Claude Code agents work on the benchmark app, and the demo checks every 0A exit criterion. By default a scripted model stands in for the real one, so it's free and takes about 15 seconds. With a provider key exported, `npm run demo -- --real --provider deepseek` uses real agents (see [Choosing a model provider](#choosing-a-model-provider); capped at $2 per session).

You need Node 24 or later and PostgreSQL 18.
1. **Install dependencies:** `npm install`.
2. **Start Postgres.** With Homebrew on macOS (`brew install postgresql@18`), either:
   - `brew services start postgresql@18`, which also starts it at every login; or
   - `/opt/homebrew/opt/postgresql@18/bin/pg_ctl -D /opt/homebrew/var/postgresql@18 -l /opt/homebrew/var/postgresql@18/server.log start`, for this session only.
   
   If the log says "postmaster became multithreaded during startup", your shell has no locale. Prefix the command with `LC_ALL=en_US.UTF-8`.
3. **Create the two databases, once:** `createdb harness_dev` and `createdb harness_test`. Homebrew's `postgresql@18` binaries live in `/opt/homebrew/opt/postgresql@18/bin`, which isn't on your `PATH` by default.
   - **If another PostgreSQL already uses port 5432,** run 18 beside it: set `port = 5433` in `/opt/homebrew/var/postgresql@18/postgresql.conf`, start it, create the databases with `-p 5433`, and export `HARNESS_DATABASE_URL=postgresql://localhost:5433/harness_dev` and `HARNESS_TEST_DATABASE_URL=postgresql://localhost:5433/harness_test` in every shell. A test fails if the database it reaches is older than 18.
4. **Check:** `npm run check` type-checks everything and runs the tests.
   - The server tests use `HARNESS_TEST_DATABASE_URL` (default `postgresql://localhost:5432/harness_test`).
   - Each test file makes its own throwaway schema there and drops it afterwards.
   - No API key is needed: the agent tests run the real pinned Claude Code CLI against a scripted stand-in for the model.
5. **Run the coordination server (optional):**
   - Set a local token once per shell: `export HARNESS_LOCAL_TOKEN=$(openssl rand -hex 32)`.
   - Then `npm run server`. It migrates `harness_dev` (or `HARNESS_DATABASE_URL`) and listens on `ws://127.0.0.1:7400` (`HARNESS_PORT` to change).
   - Every client has to present that token (D-74).
6. **Run harnessd (optional):**
   - Put the same token in `~/.harness/token` (`chmod 600`).
   - Write `~/.harness/config.toml`: `device_id`, `principal`, `server_url`, and one `[[projects]]` entry per allowlisted repo. The format is at the top of `packages/daemon/src/config.ts`.
   - Then `npm run daemon`.
   - A repo's `harness.yaml` setup command runs only after you approve it: `npx harness approve` lists the pending ones (D-52).
   - Agents run on an API key, never a subscription login (D-56, D-87). Choose the model endpoint in `config.toml` ([Choosing a model provider](#choosing-a-model-provider)) and export its key variable before starting harnessd. harnessd checks the key at startup, passes it to Claude Code, and hides it from the agent's shell (D-64).
7. **Drive it with the CLI** (`npx harness`, reading the same `~/.harness`):
   - `harness agent add backend`, then `harness task add "Login API" --scope src/api/,src/types.ts --assign backend --text "…"`. Assigning starts the agent in its own worktree.
   - `harness status` shows who's alive, who owns what, what each agent is changing, overlaps and questions. `harness log --follow` streams the event log, and `harness metrics` scores the run (validation.md §4).
   - An agent finishes with its `report_done` tool, or you run `harness task done <task>`. harnessd then commits its work on `harness/task/<task>`. `harness task abandon <task> --reason …` stops it and removes the worktree.
   - `harness land <task>` merges a finished task into the base branch on the device that ran it: in an integration worktree, after the repo's approved `test.command` (from `harness.yaml`) passes in the sandbox. Agents that read a file it changed are synced at their turn end and told, with a diff. If a sync conflicts, the task is blocked: resolve it in the task's worktree, then `harness task unblock <task>`.

## Choosing a model provider

harnessd runs agents through Claude Code, which speaks the Anthropic Messages API. Any endpoint that speaks that API can serve the model, chosen in `~/.harness/config.toml` (D-87). No provider is built into the code: [docs/examples/providers.toml](docs/examples/providers.toml) has ready-made tables to copy.

```toml
[agents]
provider = "deepseek"     # or HARNESS_PROVIDER=deepseek in harnessd's environment
max_budget_usd = 2        # per session, against configured prices
# read_allow = ["~/.cache/ms-playwright"]   # agents can't read your home directory (D-98); add what they need

[providers.deepseek]      # copied from docs/examples/providers.toml
base_url = "https://api.deepseek.com/anthropic"
auth = "x-api-key"
key_env = "DEEPSEEK_API_KEY"   # the NAME of the variable holding the key, never the key
model = "deepseek-flash"
```

**The key never goes in a file in this repo.** Export it in the shell that runs harnessd or the demo, for example from a `chmod 600` file your `~/.zshrc` sources.

| Provider (example name) | Use it for | Key variable | Get a key |
|---|---|---|---|
| `deepseek` (`deepseek-flash`) | Development and benchmarks: the cheapest that drives the agent loop. About $0.30 in / $1.20 out per million tokens at peak; prepaid | `DEEPSEEK_API_KEY` | [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) (top up at [/top_up](https://platform.deepseek.com/top_up)) |
| `openrouter-free` (one pinned `:free` model) | $0 smoke tests only. OpenRouter says non-Anthropic models aren't supported in Claude Code; 50 requests a day under $10 of credits | `OPENROUTER_API_KEY` | [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys) |
| `kimi` (`kimi-k2.6`) | A third option. Needs about $10 of top-up for a usable rate limit | `MOONSHOT_API_KEY` | [platform.kimi.ai/console/api-keys](https://platform.kimi.ai/console/api-keys) |
| `haiku` (`claude-haiku-4-5`) | The later comparison and baseline | `ANTHROPIC_API_KEY` | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |

- **With no provider and no `agents.model`,** agents use Claude Code's default model on Anthropic's API with `ANTHROPIC_API_KEY`. At the pinned version that's `claude-opus-5-5`, the most expensive option, so set one.
- **Endpoints must be https.** A local plain-http gateway isn't accepted: any agent allowed to bind local ports could listen on its port first and take the key.
- **On a third-party endpoint** harnessd pins every model alias Claude Code uses (main, background, subagent) to the configured model, drops request fields only Anthropic's API accepts, and prices tokens from the table's `prices` (Claude Code's own cost figure is a guess for models it doesn't know, F-27). `harness metrics` shows the models used and where the cost figure came from.
- **Bearer-token endpoints** (`auth = "bearer"`, OpenRouter and Kimi) get the key in both of Claude Code's auth variables, so the check that rules out subscription logins still holds (C-21).
- **For an A/B run,** both arms use the same provider table and model; never a router that picks models (D-87). Metrics warn if sessions ran on different models.
- **Real-model checks** in the spike take the same settings: `SPIKE_BASE_URL`, `SPIKE_KEY_ENV`, `SPIKE_MODEL`, `SPIKE_AUTH_SCHEME` (see `spikes/0a-adapter/lib/session.ts`).

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
