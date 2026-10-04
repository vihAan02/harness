# Instructions for AI agents working in this repo

These instructions apply to every agent: Claude Code, Codex, and others. `CLAUDE.md` imports this file.

## What this repo is
- **The product:** the **harness**, a multiplayer coordination layer for humans and AI agents working across machines, models, and eventually data sources (D-01).
- **The first wedge:** several humans, each with their own agents on their own machines, coordinating on one repo.

## Current state
- **The owners:** GitHub `vihAan02`, who owns the repo, and Daniyal Mughal (GitHub `DaniyalMughal1`), co-owner (D-85, superseding D-71's owner line). A gate marked "owner" needs the approval of either one. Daniyal continues the work from [HANDOFF.md](HANDOFF.md).
- **Phase:** 0B, approved 2026-10-03 by a co-owner (D-86). 0A is built (D-59 to D-84).
  - **Done:**
    - the adapter spike (roadmap 0A item 0), in `spikes/0a-adapter/`, accepted by the owner (D-71). Results are in [docs/research/spike-0a.md](docs/research/spike-0a.md); the architecture changes are D-60 to D-70.
    - item 1, the repo skeleton, in `packages/` (D-72);
    - item 2, data model v0, on Postgres 18 (D-73);
    - item 3, coordination server v0 (D-74);
    - item 4, `harnessd` v0 (D-75, D-76);
    - item 5, `AgentAdapter` + `ClaudeAdapter`, with harnessd running agent sessions through it (D-77);
    - item 6, the agent-facing tool shim, the task commands and `message.send` (D-78);
    - item 7, soft claims and overlap warnings (D-79);
    - item 8, typed message delivery (D-80). Its real-model check, U-1, still needs an API key (Q-18);
    - item 9, the human CLI and the task lifecycle (D-81);
    - item 10, metrics capture (D-82) and the benchmark app, Shelf, in [harness-bench](https://github.com/vihAan02/harness-bench) (D-83);
    - item 11, the 0A demo, `npm run demo`, which meets every 0A exit criterion with a scripted model (D-84).
  - **Deferred from 0A:** the real-model checks need an API key (U-1, Q-18, deferred by D-86).
  - **0B so far (D-86):** provider integration (D-87, D-90), read capture (D-91), invalidation and sync (D-92) and the land step (D-93) are built; the S3 example passes with the scripted model (`test/s3.integration.test.ts`).
  - **The rest of 0B (D-94):** approved 2026-10-03 and built in two parallel workstreams. See "Parallel development (0B)" below before touching any file.
  - **Environment caveat:** if the checkout is inside an iCloud-synced folder (such as `~/Desktop`), real-CLI tests flake and iCloud can create `name 2.ext` duplicate files; run them from a clone outside iCloud (see HANDOFF.md).
- **Code:**
  - Product code lives in `packages/{protocol,server,daemon,adapters,cli}`, an npm workspace that runs from TypeScript source (D-72). Run `npm run check` (type-check + tests) before handing work back. The server tests need Postgres running: see "Running locally" in [README.md](README.md). The adapter tests run the real pinned Claude Code CLI against a scripted stand-in for the model, so they need no API key.
  - `test/structure.test.ts` enforces three architecture rules: no imports of the spike, agent-vendor SDKs only in `adapters`, and dependencies only in the allowed direction.
  - The spike is throwaway, and product code never imports it.
- **Stack:** TypeScript (D-55) on Node 24+ (D-72). Experiments use API keys or provider tokens from pay-as-you-go accounts, never subscription login (D-56, D-87). The model endpoint is configured, never hardcoded (D-87).
- **Next step, and what must happen first:** see [PLAN.md §12](PLAN.md#12-what-must-happen-before-and-during-phase-0a). That's the only canonical copy.

## Read in this order before doing anything
1. [PLAN.md](PLAN.md): the source of truth. Vision, principles, decisions (D), hypotheses (H), risks (R), sequence.
2. [docs/roadmap.md](docs/roadmap.md): what the current phase builds and what it must **not** build.
3. The doc for the area you're touching:
   - [architecture](docs/architecture.md)
   - [coordination](docs/coordination.md)
   - [agent-adapters](docs/agent-adapters.md)
   - [local-runtime](docs/local-runtime.md)
   - [protocol](docs/protocol.md)
   - [security](docs/security.md)
   - [validation](docs/validation.md)
4. [docs/open-questions.md](docs/open-questions.md): don't silently decide an open question. Ask the owner.

## Core principles (locked; a copy of PLAN.md §4, and PLAN wins)
1. Share coordination, not disk state.
2. Git is the code synchronization layer.
3. The harness cloud is the coordination layer.
4. The local daemon is the execution and security boundary.
5. MCP is a compatibility layer, not an enforcement layer.
6. Stale context is a bigger problem than literal file collisions.
7. Claims are awareness mechanisms, not correctness guarantees.
8. Peer-agent communication is sparse and untrusted.
9. Task decomposition stays human-led initially.
10. Vendor-specific behaviour stays behind `AgentAdapter`.
11. The product vision stays ambitious; the implementation sequence stays disciplined.

## Rules
- **Don't build past the current phase,** and don't pull deferred items forward (PLAN.md §10). Phase 0's small size doesn't shrink the vision. Never "simplify" the vision in the docs.
- **No product code without the owner's go-ahead** for that phase (D-44). A throwaway verification spike in a scratch directory is covered by the phase's go-ahead.
- **PLAN.md wins on any conflict.** If a doc disagrees with it, fix the doc.
- **Decisions are superseded, never silently edited.** Add a new D-ID with the date, the reason, and which ID it supersedes.
- **Keep the labels distinct:**
  - **F (researched fact):** needs a source URL, a check date and a confidence mark (✔✔ / ✔ / ◐ / ?), in `docs/research/vendor-capabilities.md`. Only ✔ and ✔✔ count as verified.
  - **D (decision).**
  - **H (hypothesis):** to be tested.
  - **Q (open question).**
  - **R (risk)**, **TH/T (threat/test)**, **C (contradiction found by research)**, **SC/M/P/G (A/B scenario/metric/pass criterion/guardrail)**: see the label table at the top of PLAN.md.
  - **PROPOSAL:** a default you may build with in its phase unless the owner objects. The A/B pass bar is the exception: it needs explicit approval (v1 approved, D-57), and it's versioned and never weakened after results are seen.
  
  Never present a hypothesis or an unverified vendor behavior as fact.
- **Re-verify vendor facts before relying on them in code.** Agent CLIs change fast. If a fact is more than about 60 days old, re-check it and update its F-ID.
- **`docs/source/` holds raw records of the owners' instructions (S1–S9).** Never edit them.
- **Keep the docs clear, not bureaucratic.** Don't add documents that duplicate others.
- **Git:** don't commit or push unless the owner asks. Never commit secrets or `.env` files.
- **Security defaults you must not weaken:**
  - no repo-controlled executable config in agent sessions (D-45);
  - no vendor peer channels (D-46);
  - sandbox and deny rules first, hooks second (D-47);
  - never touch vendor credentials (D-48);
  - `harnessd` owns Git writes (D-50);
  - `harness.yaml` is untrusted input (D-52);
  - from the spike:
    - path-scoped write rules, never bare `Edit`/`Write` (D-60);
    - a dead-man PreToolUse callback (D-62);
    - injected messages sent verbatim (D-63);
    - credentials hidden from the agent's shell (D-64).

## Parallel development (0B, D-94)
Two people build the rest of 0B at the same time, each with their own Claude.
- **Stream A:** Daniyal (`DaniyalMughal1`), the integration owner.
- **Stream B:** Vihaan (`vihAan02`).
- **Which stream you're in:** `gh api user --jq .login` tells you. If you can't tell, ask the human.
- **Tasks, dependencies and tests:** the GitHub issues labelled `stream:daniyal` / `stream:vihaan`, plus the pinned "0B workboard" issue.

**At the start of every session**, run:
```
git fetch origin && git log --oneline origin/main -15
gh pr list -R vihAan02/harness
gh issue list -R vihAan02/harness --label status:active --label status:blocked
```

**File ownership.** Edit only your own column. Outside it, you may only add the rows or sections of your own feature, and the owner reviews.

| Area | Stream A (Daniyal) | Stream B (Vihaan) |
|---|---|---|
| Packages | `protocol/**`, `adapters/**` | `cli/**` |
| Server | `commands, handler, server, events, db, index, main`, `lands, invalidation, readsets, syncs, reports, waits`; migration `0012` | `leases, messages, tasks, claims, sessions, agents, presence`; migration `0013` |
| Daemon | Everything else, including `daemon.ts`, `view.ts`, `tools.ts`, `tools/waits.ts`, `envelope.ts`, `instructions.ts` | `status.ts`, `metrics.ts`, `leases.ts`, `tools/{leases,messages}.ts` |
| Tests | `test/{support,fake-adapter,shim,agent,s3,sync-land,daemon,structure,waits}*`, `test/security/t1-*` | `test/{lifecycle,messages,claims}.integration*`, `test/security/{t1b,t2}-*`, `packages/server/test/leases*` |
| Scripts and repo | `scripts/ab/{baseline-launch,score}.ts`, `tsconfig.json`, dependencies | `scripts/demo-*.ts`, `scripts/ab/run.ts` and the recorder, `.github/**`, `package.json` scripts |
| Docs | `PLAN.md` (stream B has its own D-ID block), `AGENTS.md`, `README.md`, `HANDOFF.md`, `roadmap.md`, `protocol.md`, `coordination.md`, `security.md`, `architecture.md`, `agent-adapters.md`, `local-runtime.md`, `open-questions.md` | `validation.md`, `docs/results/**`, `research/spike-0a.md` §5, `docs/examples/providers.toml`, harness-bench, and the hidden-checks repo (which stream A never reads) |

**Rules:**
- **IDs:**
  - decisions D-95 to D-119 for A and D-120 to D-139 for B, each in its own block at the end of PLAN.md §7;
  - facts F-98 to F-119 for A and F-120 to F-139 for B, in their own blocks at the end of `docs/research/vendor-capabilities.md`;
  - `docs/source/` takes new files only.
- **Shared interfaces are contract-first:** the owner merges the smallest contract PR, then both of you rebase. Never redesign an interface you don't own. If you need a change in the other stream's file, open an issue, or make the smallest edit and ask the owner to review.
- **Branches:**
  - one task per branch, from a fresh `main`: `daniyal/<task>` or `vihaan/<task>`;
  - keep it small (≲800 changed lines, ≲3 days);
  - rebase, never merge `main` into your branch;
  - never push to `main`, and never use `git add -A`.
- **Merging:** squash merges only. **A PR merges as soon as its listed dependencies have merged, the required checks are green, and any review below is done.** There's no global merge order.
- **Before opening a PR:** run `npm run check` from a checkout outside iCloud, plus the targeted suites for what you touched:
  - sync and land: `test/sync-land`, `test/s3`, `npm run demo:0b`;
  - read capture: `packages/daemon/test/reads.test.ts`;
  - leases and fencing: `packages/server/test/{land,claims}.test.ts`, then T-2;
  - provider: `packages/adapters/test/{provider,session}.test.ts`;
  - policy and hooks: `packages/adapters/test/policy.test.ts`, `test/security/`;
  - delivery: `test/messages.integration.test.ts`;
  - any daemon, adapter, server or script change: `npm run demo && npm run demo:0b`.
- **Review:**
  - Daniyal reviews B's PRs that touch A's files or a contract, leases and fencing, delivery semantics, migrations or dependencies, or that add a D-ID.
  - Vihaan reviews contract PRs, A's PRs that touch B's files, and A/B parameters.
  - Anything else merges on green CI.
- **The PR description is the handoff record** (the template's sections become the squash commit message):
  - what changed and why;
  - shared files touched;
  - contract changes;
  - D-IDs and F-IDs;
  - migrations;
  - new config or environment variables;
  - tests run, with results;
  - real-model cost;
  - notes for the other stream.

  Only Daniyal edits HANDOFF.md, at milestones.

## Glossary and IDs
See PLAN.md §13 (glossary) and §7–§9 (D, H and R registers).
