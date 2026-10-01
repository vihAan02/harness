# Competitive landscape (checked 2026-10-01)

> **Status:** research snapshot, not a decision. Re-check before any positioning or launch, because this space changed monthly through 2026.
>
> **Source:** a research pass on 2026-10-01 using the projects' own sites, repos, docs and changelogs. Secondary sources are labelled as such. It informs H-09 and R-9 in [PLAN.md](../../PLAN.md).

## 1. Verdict on the wedge

> **Our wedge:** multiple humans, each running their own AI coding agents on their own machines under their own vendor accounts, coordinating on one repository as one team.

- **It's contested, not empty.**
  - **Axis** (useaxis.dev) describes almost exactly this wedge. It's tiny: 5 stars, last main commit 2026-08-03, and it coordinates only through cooperative MCP calls with advisory per-file locks.
  - **A sibling hackathon repo, `axis-hackathon`** (2026-09-19/20), adds a local `axisd` daemon plus a central hub with kernel-enforced, function-level locks. That's architecturally the closest thing to `harnessd`.
- **Mature projects each cover one piece:**
  - **Agent Relay:** team messaging across machines, with delivery at tool or idle boundaries; no file claims.
  - **MCP Agent Mail:** leases, inbox hooks in Claude and Codex, and a git guard; single operator.
  - **agent-talk:** cross-person encrypted messaging through hooks.
  - **Nimbalyst Teams:** local agents on each person's own subscription, plus shared trackers; no code claims.
  - **Gas Town's Wasteland:** cross-human claims at the task level.
- **Vendors coordinate one user's agents, or offer shared cloud agents:**
  - Claude Code's cross-session messaging, agent teams and agent view;
  - Codex subagents and cloud;
  - Cursor Projects;
  - Copilot `/fleet` and Agent HQ;
  - Warp orchestration and Factories;
  - Devin and Factory.
  
  Amp and Conductor add "multiplayer" as **one shared agent per thread or workspace**, not as coordination between each person's own local agents.
- **No single tool found combines:**
  - a per-human local daemon;
  - hard claims fenced at integration (fencing tokens), with hook-level warnings (D-20, D-47);
  - **read capture and stale-context invalidation**;
  - injection at turn boundaries;
  - a team server across machines;
  - per-human permission isolation;
  - several vendors.
- **The gap is closing fast.** Most of the relevant launches landed between July and September 2026.

**Implications for this plan:**
- **H-09 is still plausible but under time pressure.**
- **The enforcement mechanism alone isn't novel.** `agent-coord` already pairs a PreToolUse write block with a git guard and between-tool-call delivery, on one machine.
- **What's defensible is the combination**, led by **stale-context invalidation across people and vendors** (D-22). We found no **shipped** product doing read-set invalidation. The nearest is the *Claim Plane* preprint (arXiv 2607.21909, F-95), which proposes premise invalidation with fencing as research, not a product.

## 2. The six names S1 cited

| Name in S1 | What it actually is | Multi-human? | Cross-machine? | Claims/locks | Messaging | Activity | Relevance |
|---|---|---|---|---|---|---|---|
| "Agent Mail" | **MCP Agent Mail** (Dicklesworthstone): identities, inboxes, threads, **advisory file leases** with TTL; optional pre-commit guard; installers wire PostToolUse inbox hooks into Claude Code and Codex | No (one operator, many agents) | Only if its HTTP server is exposed | Advisory leases | Pull + hook-checked inbox | Active: ~2.2k stars, pushed 2026-09-29; Rust port weekly | Strongest prior art for the building blocks |
| "Axis" | **Axis** (useaxis.dev, VirSanghavi/axis): MCP job board + per-file advisory locks (30-min expiry) for "several developers, running different agent vendors, on the same repo" | **Yes, by intent** | Yes (hosted board) | Advisory; optional chmod read-only | Shared notepad, activity trailer | Low: 5 stars, last commit 2026-08-03; `axis-hackathon` (daemon + hub) 2026-09-20 | **Most direct competitor to the wedge** |
| "Agentlocks" | Ambiguous. Best match: **agent-locks** (luohoa97 / Warnes-Innovations): advisory MCP locks stored under `.git` for worktrees of one clone | No | No | Advisory | No | ~0 stars | Not a threat. Its "drift check" (claimed scope vs actual changes) is worth copying |
| "COORD-Harness" | **COORD-Harness** (0marm0): one SQLite file per machine; work-item claims with heartbeat leases and fencing on handoff | No (one OS user, by design) | No | Work-item leases | Notes ("carry no authority") | 4 stars, 2026-08/09 | Good handoff-fencing pattern |
| "Relay" | Ambiguous. Notable: **Agent Relay** (AgentWorkforce): "headless Slack for agents", cross-machine, humans first-class, delivery modes `next-tool-call` / `on-idle` | Yes (team messaging) | Yes | **None** | Rich | Active: 856 stars, v13.0.0 on 2026-09-30 | Closest mature competitor on messaging and injection |
| "Warp orchestration modes" | Warp has **parent/child orchestration** (`/orchestrate`, `/plan`; local/cloud placement) over a server-backed message bus; Claude Code / Codex as child harnesses. "Orchestration modes" isn't Warp's term | No (single owner); **Factories** is team intake but cloud-run | Local + cloud | Guidance only | Per-agent inbox | Docs updated 2026-09-24 | Single-owner orchestration |

## 3. Other tools and features to know

| Tool | Model | Why it matters |
|---|---|---|
| **Claude Code cross-session messaging** (v2.1.224+, Aug 2026) | `SendMessage`/`ListAgents`; per-session inbox socket; delivered between tool calls or as a new turn if idle; same OS user (or same claude.ai account across machines via Remote Control) | A first-party injection path, but single-user. We disable it in managed sessions so peer traffic flows only through the harness (D-46) |
| **Claude Code agent teams** (experimental) | One lead + teammates, one machine, file-locked task claims, JSON mailboxes; interactive only | Single human; the docs admit same-file overwrites; not a usable substrate |
| **Claude Code agent view / background agents** | `claude --bg`, `claude agents --json`, automatic worktrees | Overlaps `harnessd`'s supervision for a single user |
| **Claude Code Channels** (research preview) | MCP servers push events into a session; allowlisted | Optional future injection path |
| **Claude Projects / Claude Tag** | Projects are single-user; Tag is a team Slack agent in org-billed cloud sandboxes | Anthropic's multi-human surface is a shared cloud agent, not local-agent coordination |
| **Amp** (Sourcegraph) | Multiplayer threads (several humans steer one agent), shared runners (teammates start threads on *your* machine with *your* credentials), agent-to-agent messaging across machines | Most multi-human vendor. Single-vendor, Amp-billed, no claims. Its shared-runner security model is the opposite of our local root of trust (D-32) |
| **Conductor** | Mac app for parallel Claude/Codex/Cursor/OpenCode in worktrees; Cloud (microVMs); early-access multiplayer (shared cloud workspaces); "Sign in with ChatGPT" (2026-09-29) | Moving toward teams by sharing workspaces; could add claims quickly |
| **Cursor** | Agents Window (parallel worktrees), cloud agents, team pools, Projects (cloud coordinator, 2026-09-10) | Cursor-billed, cloud-centred |
| **GitHub Agent HQ / Copilot** | Repo "mission control" for Copilot, Claude and Codex cloud agents opening PRs; Copilot CLI `/fleet` | Multi-vendor and repo-centred, but cloud-run; a plausible entrant if it adds claims |
| **Codex** | Subagents (one session), Codex Cloud parallel tasks, desktop app with worktree per thread | Single user |
| **Nimbalyst Teams** (beta) | Each teammate's agents stay local on their own subscription; shared docs, trackers, messaging | Closest *model*; no code claims or enforcement |
| **Gas Town + Wasteland, Beads** | Single-human workspace manager; Wasteland federates task-level claims across humans via DoltHub; Beads = Dolt-backed agent issue tracker | Task-level, async; complementary (could be read, not rebuilt) |
| **agent-talk** | Cross-person end-to-end-encrypted agent messaging, auto-received through hooks in Claude Code, Codex and others | Proves hook delivery across vendors and people works |
| **agent-coord** and the long tail | Same-machine PreToolUse write blocks + git guard + between-tool-call delivery | The enforcement *mechanism* is commoditising |
| Vibe Kanban, Sculptor, Superset, Devin, Factory, OpenHands, Jules | Single-human orchestrators / cloud agents | Not in the multi-human space |

## 4. What a competitor would need to add to match the wedge
- **Axis:** enforcement through vendor hooks, read capture, injection at turn boundaries. The `axisd` daemon may be heading there.
- **Agent Relay:** file claims, read sets, permission enforcement.
- **MCP Agent Mail:** multi-tenant identity and a hosted team server.
- **Amp / Conductor:** coordination of *locally run, other-vendor* agents, with per-human permissions.
- **Anthropic:** cross-user or cross-org cross-session messaging, plus claims. That would erode the coordination layer for Claude-only teams, but not across vendors.

## 5. Watch list (re-check monthly)
- **Axis** and `axis-hackathon` (the daemon + hub).
- **Agent Relay** releases.
- **Anthropic:** changes to cross-session messaging (any cross-user or org scope).
- **Amp:** shared runners and claims.
- **Conductor:** multiplayer.
- **GitHub Agent HQ:** any locking or claims.
- **Unread 2026 preprints** in this niche: "ATM: CID-Brokered Pre-Write Admission…" (arXiv 2607.00041), "AgentRoom…" (2608.23740), "Verified Detection and Prevention of Concurrency Anomalies in Multi-Agent LLM Systems" (2606.17182). Plus *Claim Plane* (2607.21909, read in part; F-95).
