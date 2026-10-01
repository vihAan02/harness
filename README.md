# harness-ai

**A multiplayer coordination layer for humans and AI agents working across machines, models, and eventually data sources.**

The first wedge: **several humans, each running their own AI coding agents on their own machines, coordinating on one repository as one AI-augmented engineering team.**

## Status (2026-10-01)

**Planning only. No product code exists yet.**
- The architecture, decisions, risks, roadmap and validation plan are written down.
- Phase 0A is approved (D-59) and starts with a throwaway adapter spike; its results go in [docs/research/spike-0a.md](docs/research/spike-0a.md). The canonical next steps are in [PLAN.md §12](PLAN.md#12-what-must-happen-before-and-during-phase-0a).

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
