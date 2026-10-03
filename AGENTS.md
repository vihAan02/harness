# Instructions for AI agents working in this repo

These instructions apply to every agent: Claude Code, Codex, and others. `CLAUDE.md` imports this file.

## What this repo is
- **The product:** the **harness**, a multiplayer coordination layer for humans and AI agents working across machines, models, and eventually data sources (D-01).
- **The first wedge:** several humans, each with their own agents on their own machines, coordinating on one repo.

## Current state
- **The owner:** GitHub `vihAan02`, who owns the repo and works on it with Daniyal Mughal (D-71). Gates marked "owner" need their approval.
- **Phase:** 0A, approved 2026-10-01 (D-59).
  - **Done:**
    - the adapter spike (roadmap 0A item 0), in `spikes/0a-adapter/`, accepted by the owner (D-71). Results are in [docs/research/spike-0a.md](docs/research/spike-0a.md); the architecture changes are D-60 to D-70.
    - item 1, the repo skeleton, in `packages/` (D-72);
    - item 2, data model v0, on Postgres 18 (D-73);
    - item 3, coordination server v0 (D-74);
    - item 4, `harnessd` v0 (D-75, D-76);
    - item 5, `AgentAdapter` + `ClaudeAdapter`, with harnessd running agent sessions through it (D-77);
    - item 6, the agent-facing tool shim, the task commands and `message.send` (D-78);
    - item 7, soft claims and overlap warnings (D-79);
    - item 8, typed message delivery (D-80). Its real-model check, U-1, still needs an API key (Q-18).
  - **Next:** item 9, the human CLI and lifecycle.
- **Code:**
  - Product code lives in `packages/{protocol,server,daemon,adapters,cli}`, an npm workspace that runs from TypeScript source (D-72). Run `npm run check` (type-check + tests) before handing work back. The server tests need Postgres running: see "Running locally" in [README.md](README.md). The adapter tests run the real pinned Claude Code CLI against a scripted stand-in for the model, so they need no API key.
  - `test/structure.test.ts` enforces three architecture rules: no imports of the spike, agent-vendor SDKs only in `adapters`, and dependencies only in the allowed direction.
  - The spike is throwaway, and product code never imports it.
- **Stack:** TypeScript (D-55) on Node 24+ (D-72). Experiments use API keys, never subscription login (D-56).
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
- **`docs/source/` holds raw records of the owner's instructions (S1–S6).** Never edit them.
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

## Glossary and IDs
See PLAN.md §13 (glossary) and §7–§9 (D, H and R registers).
