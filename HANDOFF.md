# Handoff: harness, Phase 0A (state as of 2026-10-03)

> Written for Daniyal Mughal (GitHub `DaniyalMughal1`), who continues the work from here. It's a snapshot: where it disagrees with `PLAN.md`, `PLAN.md` wins.

## What this project is
**The harness** is a coordination layer for several humans, each running their own AI agents on their own machines, on one repo.
- **Coordination server:** Postgres + WebSocket, with an event log as the record.
- **harnessd:** the per-device daemon. It's the execution and security boundary: it runs agents, owns Git writes and sandboxes setup commands.
- **AgentAdapter:** the vendor boundary. ClaudeAdapter (Claude Agent SDK) is built; Codex comes in Phase 1.
- **The core thesis:** catching stale context matters more than file locks. Claims are awareness signals only; peer messages are typed and untrusted.

**Owners:** vihAan02 (GitHub, repo owner) and Daniyal Mughal (co-owner, GitHub `DaniyalMughal1`). A gate marked "owner" in the docs needs approval from either of them. This is recorded as D-85 (from source record S8), which supersedes D-71's owner line.

## Read before doing anything (in this order)
1. `AGENTS.md`: working rules for every agent. `CLAUDE.md` imports it.
2. `PLAN.md`: the source of truth. Decisions D-01 to D-85; §12 is the canonical "what's next".
3. `docs/roadmap.md`: what each phase builds, and what it must not build.
4. The doc for the area you're touching: `docs/{architecture,coordination,agent-adapters,local-runtime,protocol,security,validation}.md`. Before touching the Claude adapter, also read `docs/research/spike-0a.md` (what the vendor actually does) and the F-IDs in `docs/research/vendor-capabilities.md`.
5. `docs/open-questions.md`: never silently decide an open question; ask an owner.

## Where the code is
**Main repo:** github.com/vihAan02/harness, on **`main`**. All of Phase 0A is there. Branch from `main` for new work. (`claude/0a-skeleton` is the branch 0A was built on; `main` was fast-forwarded to it, so it holds nothing extra.)

| Commit | What it adds |
|---|---|
| `fc74ddc` | Spike follow-ups |
| `36d64ea` | Repo skeleton (D-71, D-72) |
| `43e10a6` | Data model v0 on Postgres 18 (D-73) |
| `2fc730c` | Coordination server v0 (D-74) |
| `8fc0061` | harnessd v0 (D-75, D-76) |
| `c5457ae` | AgentAdapter + ClaudeAdapter (D-77) |
| `762527d` | Agent tools: `harness_status`, `ask`, `answer`, `report_done` (D-78) |
| `1ad3783` | Soft claims and overlap warnings (D-79) |
| `2c6f154` | Typed message delivery: envelopes, budgets, `message.ack` (D-80) |
| `7eaa87b` | Human CLI and task lifecycle (D-81) |
| `e1f6cb6` | Metrics capture and the benchmark app (D-82, D-83) |
| `75e3393` | The 0A demo; every 0A exit criterion met with a scripted model (D-84) |

**Benchmark repo:** github.com/vihAan02/harness-bench, `main` at `8c6ea60`. It holds "Shelf", a small team book-lending app built for the A/B test:
- TypeScript on Node 24, using Node's built-in SQLite;
- an API, a typed client with HTML views, migrations, and shared types as the API contract;
- 18 tests that run in about half a second.

**Layout of the main repo:** an npm workspace, `packages/{protocol,server,daemon,adapters,cli}`, run straight from TypeScript source (Node 24+, `erasableSyntaxOnly`).
- `scripts/demo-0a.ts`: the demo.
- `test/`: end-to-end tests.
- `spikes/0a-adapter/`: the throwaway spike, with its own `package.json` (not part of the workspace). Product code must never import it.

**Access:** `DaniyalMughal1` is already a collaborator, with push access, on both repos (checked 2026-10-03).

## Status
- **Phase 0A, items 0 to 11: all built.**
- **`npm run check`:** 125 tests, 124 pass, 1 skipped (the skip is intentional). About 20 s.
- **`npm run demo`:** all six 0A exit criteria pass with the scripted model, about 15 s per run. The criteria: who's alive, who owns what, what each agent is changing, what the others are doing, overlaps, and a question/answer round trip with latency and delivery point recorded.
- **Checked on a fresh clone of `main`** (2026-10-03, macOS on Apple silicon, Node 24.13.1): `npm ci`, `npm run check`, `npm run demo`, and the spike's `e17 --mock` all ran clean.
- **The agent tests** run the real pinned Claude Code CLI (Agent SDK 0.3.287 / CLI 2.1.287) against a scripted stand-in for the model, in `packages/adapters/test/mock-api.ts`. They need no API key. Only the model is fake; Claude Code, the sandboxes, Git, Postgres and the CLI are all real.

## Still open for 0A (needs an owner: vihAan02 or Daniyal)
1. **Real-model checks (Q-18).** They need `ANTHROPIC_API_KEY` exported. API keys only, never a subscription login (D-56).
   - **U-1 to U-3**, for about $0.10 to $0.30:
     ```bash
     cd spikes/0a-adapter
     npm ci
     node experiments/e17-real-model.ts
     ```
     The spike has its own install, and the root `npm ci` doesn't cover it. `--mock` runs the same script free, to check the plumbing first.
     
     Output lands in `spikes/0a-adapter/.runs/` (git-ignored). The verdicts need a human read of the model's replies (see `docs/research/spike-0a.md` §5). Record them there, then close Q-18.
   - **The whole demo with real agents:** `npm run demo -- --real`, capped at $2 per session. This path has never run, so expect to debug it on the first try.
2. **An owner reviews 0A and approves starting 0B** (D-44). Don't start 0B without it.

## Running locally (macOS)
**Only macOS has been tested.** The sandboxes (`srt` and Claude Code's) are platform-specific, so other platforms are untested.

**You need:**
- Node 24 or later (`.nvmrc`);
- Git;
- Homebrew;
- network access for `npm ci` and the demo, which clones harness-bench and runs Shelf's `npm ci`.

**Steps:**
1. `npm ci` at the repo root.
   - If the optional `@anthropic-ai/claude-agent-sdk-darwin-arm64` binary is reported as failed, install it alone: `npm install --no-save @anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.287`.
2. **Postgres 18, once:** `brew install postgresql@18`.
3. **Postgres's binaries aren't on `PATH`,** in every shell that needs them:
   ```bash
   export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
   ```
4. **Start Postgres:**
   ```bash
   LC_ALL=en_US.UTF-8 pg_ctl -D /opt/homebrew/var/postgresql@18 -l /opt/homebrew/var/postgresql@18/server.log start
   ```
   - Without `LC_ALL`, it fails with "postmaster became multithreaded".
   - This start lasts until reboot. `brew services start postgresql@18` keeps it running across reboots.
5. **Databases, once:** `createdb harness_dev`, then `createdb harness_test`.
6. **Check and demo:**
   - `npm run check`: type-check plus every test.
   - `npm run demo`: the scripted demo.
7. **Run the pieces yourself:** `npm run server`, `npm run daemon` and `npx harness …`. See "Running locally" in README.md. The daemon needs `~/.harness/config.toml` and `~/.harness/token` (chmod 600).

## Conventions and gotchas
- **Git:**
  - Branch from `main` for new work.
  - Commit and push only when an owner asks; never commit secrets.
  - Commit under your own identity. Everything so far was authored as `vihAan02`.
  - End commit messages with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- **Decisions:** a new D-ID supersedes an old one; never silently edit an existing decision.
- **Records:** `docs/source/` (S1 to S8) holds raw records of the owners' instructions. Never edit them.
- **Vendor facts:** keep them as F-IDs in `docs/research/vendor-capabilities.md`, and re-verify anything older than about 60 days. Most were checked on 2026-10-01.
- **Pinned vendor versions (D-49):** ClaudeAdapter refuses any Agent SDK other than 0.3.287 (CLI 2.1.287). To move the pin:
  1. re-run the spike's experiments on the new version (`spikes/0a-adapter/README.md`) and the adapter tests;
  2. update the F-IDs;
  3. then update `PINNED` and `BUILTIN_SKILLS` in `packages/adapters/src/claude/version.ts`.
- **Security defaults you must not weaken** (full list in AGENTS.md):
  - no repo-controlled executable config in agent sessions (D-45);
  - no vendor peer channels (D-46);
  - path-scoped Edit/Write rules only (D-60);
  - the dead-man PreToolUse callback (D-62);
  - injected messages always sent verbatim (D-63);
  - the API key hidden from the agent's shell (D-64);
  - harnessd owns every Git write (D-50).
- **Test pattern:**
  - each server test file gets its own throwaway Postgres schema;
  - `test/support.ts` starts the whole stack;
  - check each confinement or security test with a negative control: weaken the rule and confirm the test fails.
- **Known limitations:**
  - **Under the setup sandbox (`srt`),** a server can't serve or reach `127.0.0.1`. The 0B land step's test command needs local-port access in its `srt` config (noted in the roadmap and D-83).
  - **A restarted harnessd doesn't resume in-progress tasks;** that's Phase 1 (D-40). Abandon the task and add it again.
  - **Node 24's SQLite** prints an experimental-feature warning; Shelf's scripts silence it.

## Next phase (0B, after an owner approves; see docs/roadmap.md)
1. Read capture and a monitor for missed hooks.
2. The invalidation engine and sync at turn end ("Dependency changed: X has changed since you read it").
3. Notices delivered through hooks, and the Stop gate.
4. `wait_for`.
5. Hard claims (leases with fencing tokens) and the local `harness land` step. Remember the `srt` local-port fix.
6. The remaining message kinds (`contract_request`, `task_blocked`).
7. Read confinement.
8. Security tests T-1, T-1b and T-2.
9. A/B setup: scenarios SC-0 to SC-4 as tags in harness-bench, task cards, hidden checks, baseline recorder, playbook, rubric.
10. Run the A/B test against pass bar v1 (D-57).

**Validated-MVP gate:** 0B's exit criteria plus that A/B result, then an owner's go/no-go.
