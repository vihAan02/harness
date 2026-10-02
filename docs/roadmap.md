# Roadmap

> **Status:** Phase 0A approved 2026-10-01 (D-59). **Item 0, the adapter spike, is done** ([results](research/spike-0a.md); decisions D-60 to D-70) and accepted (D-71). **Item 1, the repo skeleton, is done** (D-72). Next: item 2.
> - [PLAN.md](../PLAN.md) wins on any conflict.
> - Each phase starts only after the owner approves it (D-44).
> - Items are ordered; build them roughly top to bottom.
>
> **Guiding rule (D-03):** keep the vision ambitious and the sequence disciplined. Nothing below gets pulled into an earlier phase "because it's interesting" (D-04, R-8).

---

## Phase 0A: prove the core coordination loop

**Shape:** 1 human · 1 machine · 2 Claude Code agents · 1 repo · 2 worktrees · 1 coordination server, running locally.

**Before starting, and what's due during 0A:** see the canonical list in [PLAN.md §12](../PLAN.md#12-what-must-happen-before-and-during-phase-0a). The stack (TypeScript, D-55), the auth mode (API keys, D-56) and the go-ahead (D-59) are done. **After item 0, stop and report the spike results to the owner before item 1** (D-59).

**Build, in order:**
0. **Adapter spike** (throwaway, in `spikes/0a-adapter/`, outside the product packages; D-44, D-59). It answers the ten questions in S4, recording each as VERIFIED, CONTRADICTED, PARTIAL or UNVERIFIED with exact versions, in [research/spike-0a.md](research/spike-0a.md). It also checks the vendor facts the design leans on hardest:
   - streaming-input delivery at tool boundaries, and `origin` labeling (F-02);
   - `settingSources: []` really keeps repo hooks and MCP servers out (F-14);
   - which channel carries harness permissions and sandbox `denyRead` into the session so they reach the sandbox (F-12);
   - disabling cross-session messaging (F-17);
   - which shared-`.git` paths the sandbox must write-deny so agents can't touch refs, while `git status` still works (D-50, F-13);
   - `bashEditDiffEnabled` (F-07);
   - what an in-process hook callback does when it **throws** (not just on timeout) (F-05);
   - how to run `setup.command` / `test.command` sandboxed outside a Claude session (D-52);
   - the A/B baseline's launch flags: no setting sources, plus appended repo instructions (validation §3);
   - PostToolUse payloads for Read, Grep and Edit (F-07, F-08);
   - usage reporting (F-16).
   
   **Output:** updated F-IDs, a go/no-go note for each assumption, and any decisions to supersede.
   
   **Done 2026-10-01** against Claude Code 2.1.287 / SDK 0.3.287: [research/spike-0a.md](research/spike-0a.md). The core mechanisms held; six configuration and hook assumptions failed and were replaced (D-60 to D-70). The real-model checks U-1 to U-3 wait for an API key ([Q-18](open-questions.md#q-18)).
1. **Repo skeleton** for the chosen stack. One repo with packages:
   - `server` (coordination server);
   - `daemon` (`harnessd`);
   - `adapters` (`AgentAdapter` + `ClaudeAdapter`);
   - `protocol` (shared types);
   - `cli` (`harness`).
   
   **Done 2026-10-02:** npm workspaces on Node 24+, run from TypeScript source, with `node:test` and structural tests for the package boundaries (D-72).
2. **Data model v0** ([protocol.md §5](protocol.md#5-entities-and-storage-sketch)):
   - the identity entities, with no single-user shortcuts (D-18);
   - tasks (owner human, assignee agent, scope), sessions, messages, soft claims, budgets;
   - events with a per-project counter-row sequence (D-12).
3. **Coordination server v0:**
   - a WebSocket endpoint;
   - internal protocol v0: hello and resume-from-cursor, commands, subscribe;
   - the events table as the record, with a coalesced, payload-free `NOTIFY` as the wake-up (D-11).
4. **`harnessd` v0:**
   - local config and allowlist;
   - worktree lifecycle: create from an explicit base SHA on `harness/task/<task-id>`, tear down;
   - a per-agent `CLAUDE_CONFIG_DIR` (D-65);
   - child-PID tracking, with orphans killed and edits reconciled on start (D-62);
   - `harnessd`-owned Git commits when a task is done (D-50, D-54);
   - setup command with **local hash approval**, run under `srt` with a generated config (D-52, D-69);
   - `env.refs` ∩ local allowlist;
   - per-agent port blocks outside the OS ephemeral range, with loopback binding allowed (D-68);
   - presence heartbeats.
5. **`AgentAdapter` interface + `ClaudeAdapter`** (Agent SDK, TypeScript):
   - start, resume, `injectMessage` (streaming input: next tool boundary, or a new turn if idle; always `client_composed`; `command_lifecycle` receipts, D-63), stop, status (`session_state_changed`, D-67);
   - capability flags; usage reporting; a version check (D-49).
   
   **`compilePermissions` (minimal):**
   - write confinement through path-scoped allow rules, never bare `Edit`/`Write` (D-60);
   - shared-`.git` write deny on the verified path list (D-60);
   - sandbox on, with `failIfUnavailable` and no unsandboxed escape;
   - credential variables denied to the agent's shell (D-64);
   - an explicit minimal `tools` list (D-66, Proposal).
   
   **`setupHooks`:** in-process callbacks for **edit capture** (file paths + `bashEditDiff`), plus the **dead-man PreToolUse** (D-62).
   
   **The session must:**
   - not load repo hooks, MCP servers or plugins (`settingSources: []`, D-45);
   - have vendor peer channels off (D-46);
   - set the permission mode explicitly (never auto);
   - get an explicit base env;
   - turn off auto memory.
   
   See [agent-adapters.md §5](agent-adapters.md#5-claudeadapter-phase-0a-how-each-method-maps).
6. **Agent-facing tool shim** (the thin layer, D-15): `harness_status`, `ask`, `answer`, `report_done` ([protocol.md §6](protocol.md#6-agent-facing-tool-shim)).
7. **Claims:**
   - prospective claims from task scope;
   - observed claims from edit hooks plus periodic worktree diffs, which catch background writes the hooks miss (D-70);
   - overlap detection → `overlap.detected` → `claim_conflict` messages.
8. **Typed messages:**
   - `question` / `answer` / `claim_conflict` routing;
   - the envelope (D-25; [protocol.md §8](protocol.md#8-peer-message-envelope));
   - per-task message budgets (D-24, using the Q-05 proposal);
   - delivery at safe boundaries through `injectMessage`, with `message.ack` recording where each landed (D-26).
9. **Human CLI and lifecycle (D-54):**
   - `harness agent add`;
   - `harness task add` / `assign` / `done`;
   - `harness status`;
   - `harness log`;
   - the setup-command approval prompt.
10. **Metrics capture** for the A/B test's harness arm: timings, message counts, estimated coordination tokens, usage, interventions ([validation.md §4](validation.md#4-metrics)). **Build the benchmark repo's base application** (D-58, [validation.md §3](validation.md#benchmark-repo-d-58)).
11. **A 0A demo script** that exercises every exit criterion below.

**Exit criteria (from S3).** The harness reliably shows:
- [ ] which agents are alive;
- [ ] which task each agent owns;
- [ ] what each agent is currently modifying (observed claims);
- [ ] what the other agents are working on;
- [ ] when work likely overlaps (prospective × observed);
- [ ] A asking B a question, and B's answer reaching A at a safe boundary, with the latency and delivery point recorded.

**Not in 0A:**
- read sets;
- hard claims;
- hook-attached notices and the Stop gate;
- sync;
- land;
- `wait_for`;
- read confinement;
- Codex;
- a dashboard;
- anything remote.

---

## Phase 0B: prove stale-context protection

**Build, in order:**
1. **Read capture and missed-hook monitor:**
   - in-process PostToolUse on Read, Grep and LSP → read entries `(path, hash from disk, source, confidence, range)`;
   - injected instruction files recorded as `instructions` entries;
   - best-effort parsing of shell reads;
   - coverage plus missed-hook instrumentation (H-03, D-47).
2. **The invalidation engine and sync:**
   - `dependency_changed` with `stage: in_progress`: when a peer starts editing a file in your read set, **and** when you read a file a peer is already editing;
   - `dependency_changed` with `stage: landed`: when the change lands with a different hash;
   - deduplication;
   - **sync at turn end, or immediately if idle** (hold input; commit WIP; merge the new base and advance the diff base; release the held `landed` notice with a diff excerpt; mark entries stale; on conflict, mark `blocked` and pause for the human) (D-53);
   - `wait_for` timeouts are returned to the waiter.
   
   See [coordination.md §2](coordination.md#2-read-sets-invalidation-and-sync-d-22-d-23-d-53-0b).
3. **Hook-based delivery:**
   - PostToolUse / PostToolBatch notices;
   - the Stop gate: **(open task AND unread high-priority notice) OR a resolved `wait_for`**, within the 8-continuation cap, then escalate.
4. **`wait_for(event, timeout)`**: choose the mechanism (end-turn-and-push vs. blocking tool) and record wait-for edges.
5. **Hard claims and land:**
   - leases with TTL and `harnessd` heartbeat;
   - fencing tokens;
   - the local **land** step, triggered by the human with `harness land <task>`: fencing check → merge + approved `test.command` in an integration worktree → fast-forward the base only if green; otherwise `land.fail` (D-51, D-54);
   - `harness claim` CLI for human-taken hard claims;
   - a fault-injection switch for lease renewal (for T-2).
6. **Remaining message kinds:** `contract_request`, `task_blocked`.
7. **`compilePermissions` adds read confinement:** flag-settings `Read(//…)` deny rules outside the worktree and allowlist, good enough to pass T-1. They cover the file tools, `@`-expansion and shell reads; sandbox `denyRead` alone covers shell reads only (D-61, SP-13).
8. **Security tests** T-1 (hostile message), T-1b (guardrail tampering) and T-2 (stale lease, using fault injection) ([validation.md §7](validation.md#7-security-and-robustness-tests-from-s1-required-before-the-ab-test)).
9. **A/B setup:**
   - scenarios SC-0 to SC-4 planted in the benchmark repo: scenario tags, task cards and hidden integration checks (D-58);
   - the baseline recorder and launch config;
   - the coordinator playbook;
   - the scoring rubric.
10. **Run the A/B test** against pass bar v1 (D-57), or a later version recorded before the runs start. Write `docs/results/<date>-ab-gate.md`.

**Exit criteria:**
- [ ] The S3 example works end to end:
  1. A reads `src/types.ts` @ hash ABC.
  2. B changes it and finishes, and the human lands it.
  3. A's branch is synced at turn end, and A is told "Dependency changed: src/types.ts has changed since you read it." with a diff excerpt.
- [ ] T-1, T-1b and T-2 pass (run before the A/B test, and re-run after any policy change).
- [ ] The A/B test is complete and evaluated against the **owner-approved** pass bar.

---

## Gate: is coordination worth it?

The owner reviews the A/B results and records go or no-go as a new D-ID.
- **Then, as a separate test:** real-project validation on an existing project the owner chooses (D-58). Whether Phase 1 waits for it is [Q-17](open-questions.md#q-17).
- **On a fail:** the recommendation is to adjust the thesis or design, not add features to rescue it.
- **On inconclusive:** the recommendation is more runs under the same bar.

---

## Phase 1: multiplayer

1. **Real identity and security:**
   - human sign-in and device registration;
   - signed server → daemon commands (D-33);
   - local ∩ cloud policy (D-32);
   - local approval prompts (D-34), including teammates' changes to `harness.yaml` (D-52);
   - the coordination server hosted where both people can reach it ([Q-09](open-questions.md#q-09), [Q-10](open-questions.md#q-10)).
2. **A second human and device.**
3. **`CodexAdapter`,** with capability flags set honestly. Where Codex can't do something, the behavior degrades instead of pretending ([agent-adapters.md §6](agent-adapters.md#6-codexadapter-phase-1-the-likely-shape)).
   - **First:** pick the transport.
     - `exec` / TS SDK is not labelled experimental, but its protocol changes often (F-30), and it takes input only between turns (F-33).
     - The app-server allows mid-turn steering, but is labelled experimental and not for production (F-34).
   - **Must-haves:**
     - permission profiles for read confinement;
     - D-45's Codex config lockdown;
     - no retired approval policies or removed flags.
4. **Checkpoint pushes** of the task branch to `harness/wip/<agent>/<task-id>`, at meaningful boundaries only (D-29).
5. **GitHub integration (D-51):**
   - task branch → PR;
   - required CI;
   - merge queue where available (F-50); otherwise GitHub's required checks + "require up to date" + auto-merge, availability to verify ([Q-11](open-questions.md#q-11));
   - the `harness/claims` required status check (fencing);
   - checking after each merge that the base contains every PR's diff (F-53).
   - **No harness-run merge train.**
6. **Post-merge notices:** changed paths mapped against in-flight read sets and claims. Affected agents are **synced at their turn end and then notified** (D-53).
7. **Deadlock cycle detection** on the wait-for graph → `deadlock.detected` → release or escalate (D-27).
8. **First contract-aware notices:** coordination §7 stage 2, from declared contract files ([Q-13](open-questions.md#q-13)).
9. **Sleep, shutdown and resume handling;** task reassignment (D-40).
10. **Phase 1 security tests:** T-1, T-1b and T-2 across people, plus T-3, T-4 and T-5 ([security.md §8](security.md#8-security-tests)).
11. **Message screening** for requests to disable checks or send files (proposal, TH-4).

**Exit:**
- Two humans on two machines, at least one agent each, with at least one Codex agent, finish coupled work with fewer incidents than the baseline.
- All security tests pass.

---

## Phase 2: everyday use

- **A dashboard** for the board, presence, notices, approvals and metrics.
- **Full policy compilation** into each vendor's native sandbox, permission config and hooks (D-35).
- **Worktree bootstrap (D-39):**
  - dependency cache;
  - secret references end to end;
  - services such as a per-agent Postgres;
  - Python venvs;
  - database state and seeding;
  - Docker volumes;
  - generated files.
- **The local resource scheduler:** CPU, memory, process and GPU budgets, plus queueing heavy commands (D-38).
- **R2 for shared artifacts:** content-addressed blobs behind presigned URLs (D-43).
- **Contract awareness stages 3–4** from [coordination.md §7](coordination.md#7-toward-contract-awareness-d-30): parsed contract diffs, and consumers from LSP or the import graph.
- **A pre-land secret scan.**

## Phase 3: wider reach

- **Non-Git sources** copied read-only into `.harness/sources/<id>/`, with hashes in the read set (D-41).
- **Cloud agents** (cloud execution), under the same identity and security model, including whatever execution substrate they need.
- **A planner agent:** human goal → dependency graph of tasks → **human approval** → workers (D-08).
- **An integration and review agent.**
- **On-demand reads across devices,** with local approval, logging and rate limits (D-37).
- **Drive and Notion sources,** through existing MCP connectors first (D-42).

## Horizon: the full vision

- **The secure hybrid file/data fabric:** `harness://` becomes a real address space across local, cloud and non-Git sources, without weakening the local root of trust (D-42, PLAN §2).
- **Coordination at the full multiplayer scale:** many humans, many agents, many vendors, many machines.
