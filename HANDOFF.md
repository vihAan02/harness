# Handoff: harness, Phase 0A → 0B (state as of 2026-10-03)

## Latest update (2026-10-03, Daniyal's session) — read this first
This section is the current state. The original 0A handoff from vihAan02 follows it and is still accurate unless this section says otherwise.

### Where the work is
- **Branch:** `0b/stale-context` in `~/Desktop/harness-ai`, from `main` @ `1a94660`. **Pushed to GitHub on 2026-10-03 at Daniyal's request, as pull request [vihAan02/harness#1](https://github.com/vihAan02/harness/pull/1)** into `main`. `main` itself is unchanged until the PR is merged.
- **harness-bench:** cloned at `~/Desktop/harness-bench` (`main` @ `8c6ea60`), unchanged.
- **Commits on the branch,** oldest first:
  1. `e6340f3` S9 + D-86 to D-89: 0B approved (U-1 deferred), provider direction, Q-06 and Q-07 resolved.
  2. `526e10f` F-24 to F-29, F-58, F-72 to F-77, C-21: provider and gateway facts.
  3. `d173bad` configurable Anthropic-compatible model endpoints (D-87, D-90).
  4. `8038170` demo and spike take a provider.
  5. `183bea7` provider docs, TH-21, D-90, probe results, F-78.
  6. `3816297` harnessd's commits ignore `commit.gpgsign`.
  7. `407f47e` daemon integration test: stop daemons on failure, ignore presence flaps.
  8. `0f697ea` server: read sets, stale-context notices, land and sync.
  9. `9acb7e3` harnessd: read capture, sync at turn end, the land step; the S3 test.
  10. `e5f5317` `npm run demo:0b`.
  11. `dc676ca` docs: D-91 to D-93, S3 exit met.
  12. `78ccd01` metrics: M1 until landed, M3, M9, notice diagnostics.
  13. `62257c3` server: 0B review fixes (stale reads after a land, one lock order, cancel/complete, `all_changed`).
  14. `c0ecd88` read capture: Grep content-mode paths.
  15. `97ddc3c` adapter: every Bash command starts in the worktree (F-97).
  16. `85ae6d9` harnessd: read capture stays confined to the worktree.
  17. `6dfa9e7` harnessd: sync and land review fixes, never destroying work; `test/sync-land.integration.test.ts`.
  18. `fcc8cdd` HANDOFF: the 0B review outcome.
  19. This HANDOFF update: the branch is pushed, and the PR is open.

### What was decided (S9, PLAN.md)
- **D-86:** Phase 0B approved by Daniyal; U-1 deferred until a key exists; this stretch stops at the S3 example.
- **D-87:** the model endpoint is configured, never hardcoded. Priority: DeepSeek `deepseek-flash` → a fixed free OpenRouter model for smoke tests → Kimi → Haiku 4.5 as a comparison. An A/B uses one fixed model and config in both arms.
- **D-88 / D-89:** Q-06 and Q-07 resolved.
- **D-90 to D-93** (Proposals): how providers, read capture, invalidation and sync, and the land step are built.

### What's built in this stretch
- **Providers (D-90):** `[providers.<name>]` in `~/.harness/config.toml` (https endpoint, `x-api-key` or bearer, the *name* of the key variable, model, limits, prices). Example tables in `docs/examples/providers.toml`; README "Choosing a model provider" explains. Bearer endpoints get the key in both auth variables so the subscription-login check still holds (C-21). Secrets can't use names the CLI reads (incl. `BUN_*`: the CLI is a Bun binary, F-78). Model and cost basis are recorded per session; metrics warn on mixed models.
- **Read capture (D-91):** Read/Grep reads, best-effort shell reads, instruction files and edit bases, as Git blob ids → `readset.add`; the missed-hook monitor and coverage counters (H-03).
- **Invalidation and sync (D-92):** `dependency_changed` notices in progress and landed; dedup and supersede; landed notices are held until harnessd has synced the reader's branch at its turn end, then delivered with a diff excerpt. A conflict blocks the task until `harness task unblock`.
- **Land (D-93):** `harness land <task>`: fencing check, merge in an integration worktree, approved setup and test commands under srt with loopback only (the D-83 fix), then a compare-and-swap or clean fast-forward of the base. Crash recovery. `harness approve` now also covers test commands (their own kind).
- **The S3 exit example passes** with the scripted model: `test/s3.integration.test.ts`, and on the real benchmark app with `npm run demo:0b`.

### Results (2026-10-03)
- **`npm run check`** at `6dfa9e7`: **194 tests: 193 pass, 1 skipped (intentional), 0 fail**, run from a checkout outside iCloud (see the caveat below). Every commit on the branch type-checks. The server-only commit `62257c3` was also run in full against the old harnessd: 181 pass, 1 skipped, and 1 failure, which was the known adapter flake below (that commit doesn't touch the adapter).
- **`npm run demo`** (0A regression): all six 0A criteria met (re-run at `6dfa9e7`).
- **`npm run demo:0b`** (scripted model, on Shelf; re-run at `6dfa9e7`): ✔ A reads `src/shared/types.ts` at its base blob; ✔ B's change lands with Shelf's 18 tests green under srt; ✔ A is synced at turn end (land.completed → worktree.synced → notice delivered) and told "Dependency changed: src/shared/types.ts has changed since you read it." with a diff containing `+  expiresAt: string;`; ✔ both tasks landed. ~14 s. Metrics: M1 10 s (landed form), 2 stale-context notices, both delivered.
- **Key-free provider probes** (`packages/adapters/test/provider.test.ts`, real pinned CLI against the mock): x-api-key with a base path, bearer, tier pinning, field stripping, `extra_body`, budget stop, reserved-name refusal, each security rule with a negative control.
- **Two adversarial review passes** (multi-agent):
  - **Provider review:** 10 confirmed issues, all fixed before commit (incl. a loopback-http hijack and `BUN_OPTIONS`).
  - **0B review** (read capture, sync, land; 55 agents across five areas): 50 findings, **47 confirmed, 3 refuted**. All 47 are addressed in commits 13 to 17, each by a code fix, a test, or both. The worst: a post-land teardown that force-removed a worktree with uncommitted work, a land reading the task tip before harnessd had committed it, a fast-forward overwriting the human's ignored `.env`, peer file names forging notice lines, a sync committing conflict markers, and notices lost when a sync failed.
  - Every new regression test was checked with a **negative control**: the fix removed, the test fails.
  - The new race test also found a **real deadlock**: a notice insert's foreign-key check waiting on a row lock while the other transaction waited on the invalidation lock. Fixed with one lock order (the advisory lock first) and `FOR NO KEY UPDATE` on task rows.
  - The review also produced **F-97**: Claude Code's Bash keeps its working directory between commands unless `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, which the adapter now sets.

### Environment on Daniyal's Mac
- macOS on Apple silicon, Node 26.9.0, npm 11.19.1.
- **PostgreSQL 18.6** (Homebrew `postgresql@18`) on **port 5433**, beside the PostgreSQL 17 on 5432 that other projects use. Data dir `/opt/homebrew/var/postgresql@18`; databases `harness_dev`, `harness_test`.
  - After a reboot: `LC_ALL=en_US.UTF-8 /opt/homebrew/opt/postgresql@18/bin/pg_ctl -D /opt/homebrew/var/postgresql@18 -l /opt/homebrew/var/postgresql@18/server.log start`
  - Every shell that runs tests or demos: `export HARNESS_DATABASE_URL=postgresql://localhost:5433/harness_dev HARNESS_TEST_DATABASE_URL=postgresql://localhost:5433/harness_test` (a test now fails if it reaches a server older than 18).
- **⚠ iCloud caveat (important):** `~/Desktop` is iCloud-synced on this Mac. Inside it, real-CLI tests flake (a Bash edit's `bashEditDiff` goes missing; timeouts), and Git operations that delete and recreate files make iCloud create `name 2.ext` duplicates (a duplicate migration `0007_session_model 2.sql` once broke the tests). The same code passes 3/3 from a clone in `/private/tmp`. **Recommended:** move the repo out of iCloud (for example `~/code/harness-ai`), or turn off Desktop & Documents sync for it. Until then, verify from a worktree outside iCloud: `git worktree add /private/tmp/harness-wt HEAD && cd /private/tmp/harness-wt && npm ci && npm run check`. For uncommitted work, snapshot it without touching the real index: `GIT_INDEX_FILE=/tmp/idx git read-tree HEAD && GIT_INDEX_FILE=/tmp/idx git add -A && git commit-tree $(GIT_INDEX_FILE=/tmp/idx git write-tree) -p HEAD -m snapshot`, then check out that commit in the outside worktree. Avoid `git stash` inside iCloud: it triggers the duplicates. Check for duplicates with `git ls-files --others --exclude-standard | grep -E " [0-9]+\.[^/]+$"`.

### Commands
```bash
npm run check                                # type-check + all tests (Postgres 18 env vars above)
npm run demo                                 # 0A demo, scripted model
npm run demo:0b                              # 0B S3 demo on Shelf, scripted model
npm run demo:0b -- --real --provider deepseek   # real agents (needs DEEPSEEK_API_KEY; ≤ $2 per session)
npm run demo -- --real --provider deepseek      # the 0A loop with real agents
cd spikes/0a-adapter && SPIKE_BASE_URL=https://api.deepseek.com/anthropic SPIKE_KEY_ENV=DEEPSEEK_API_KEY SPIKE_MODEL=deepseek-flash E17_BUDGET_USD=3 node experiments/e17-real-model.ts   # U-1..U-3 on DeepSeek
```

### API keys (never in a file in the repo; export in the shell that runs harnessd or the demo)
| Provider | Variable | Where to get it | Notes |
|---|---|---|---|
| DeepSeek (first) | `DEEPSEEK_API_KEY` | https://platform.deepseek.com/api_keys | Prepaid: top up at https://platform.deepseek.com/top_up. `deepseek-flash` ≈ $0.30 in / $1.20 out per 1M tokens at peak, half off-peak. |
| OpenRouter (smoke tests) | `OPENROUTER_API_KEY` | https://openrouter.ai/settings/keys | Officially unsupported for non-Anthropic models in Claude Code; free tier 50 requests/day under $10 of credits. |
| Kimi | `MOONSHOT_API_KEY` | https://platform.kimi.ai/console/api-keys | Needs ~$10 top-up for a usable rate limit. |
| Anthropic (Haiku comparison, U-1 on Claude) | `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys | |

A good place: a `chmod 600` file, e.g. `~/.config/harness/keys.env` containing `export DEEPSEEK_API_KEY=…`, sourced from `~/.zshrc`.

### Unresolved
- **Real models are untested.** Everything ran against the scripted mock. First real run: `npm run demo:0b -- --real --provider deepseek`; expect to debug (DeepSeek maps unknown model names silently; the CLI's cost figure for it is a guess, so harnessd prices from the table). Then run e17 per provider to close U-1 to U-3 (Q-18, D-86).
- **OpenRouter free models:** none is a coding model like DeepSeek/Qwen-Coder; tool-call reliability unknown; smoke-test one (`openrouter-free` in the example file) before relying on it.
- **Not built in this stretch (later 0B, after an owner's review):** hook-based notice delivery and the Stop gate (item 3), `wait_for` (4), lease commands and `harness claim --force` (rest of 5, D-89), `contract_request`/`task_blocked` from agents (6), read confinement (7), T-1/T-1b/T-2 (8), the A/B setup and run (9, 10).
- **Known gaps:**
  - A land that fails its tests leaves the task `done`; reopening it needs Phase 1 resume (D-40).
  - `waitForApproval` has no timeout, so a missed approval waits forever.
  - harnessd still doesn't resume in-progress tasks after a restart (D-40).
  - A finished-but-unlanded task's landed notices are only shown to the human.
  - An agent that changes more than 5,000 non-ignored files: its claim reports are refused (the server's cap), and so is the land. Syncs past the cap mark all reads stale (`all_changed`).
  - Recovery when the base no longer contains a land's merge (the human rewound it) fails the land as `interrupted`; that path has no test.
- **Known flake:** under heavy load, the adapter test "a hardened session edits inside its worktree only" can miss the Bash edit. The CLI's own `bashEditDiff` field comes back empty, and harnessd's periodic worktree diff (D-70) is the backstop for exactly that. Seen in 2 of 3 full runs, including at `62257c3`, which doesn't touch the adapter, and earlier on the pre-change tree. It passes in isolation (3 of 3).

### Exact next steps
1. Read this section and PLAN.md D-86 to D-93; review the branch (`git log main..0b/stale-context`).
2. Optionally move the repo out of iCloud; run `npm run check` and `npm run demo:0b` from there.
3. Get a DeepSeek key, export `DEEPSEEK_API_KEY`, run `npm run demo:0b -- --real --provider deepseek`, then e17 on DeepSeek; record results (Q-18) in docs/research/spike-0a.md §5.
4. Review and merge [vihAan02/harness#1](https://github.com/vihAan02/harness/pull/1) (owner), then decide whether to continue 0B: items 3, 4, the rest of 5 (D-89), 6, 7, 8, then 9 and 10 (the A/B on harness-bench, one fixed model in both arms, D-87).

### Progress on this stretch
- [x] M0 environment and baselines.
- [x] M1 governance records (S9, D-86 to D-89, F-IDs).
- [x] M2 provider integration (D-90), reviewed, 10 findings fixed.
- [x] M3 read capture and the missed-hook monitor (D-91).
- [x] M4 invalidation and sync (D-92).
- [x] M5 the land step (D-93).
- [x] M6 the S3 exit test, `demo:0b`, metrics and docs.
- [x] Fix the confirmed findings of the 0B review: all 47 addressed, with regression tests and negative controls; `npm run check` green (194 tests).

---

# Original 0A handoff (vihAan02, 2026-10-03)

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
- **Records:** `docs/source/` (S1 to S9) holds raw records of the owners' instructions. Never edit them.
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
