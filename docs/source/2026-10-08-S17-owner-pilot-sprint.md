# S17: The owner puts a two-Mac private pilot and its thin UI ahead of the counted A/B (raw record)

> **Status:** Raw source record. **Do not edit.**
> - The newest source. Where S1–S17 conflict, S17 wins, within the narrow scope D-110 states.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan. Recorded there as D-110, with the pilot's design in D-111 to D-119.
>
> **Provenance:** owner Daniyal Mughal (GitHub `DaniyalMughal1`, co-owner under D-85), in his Claude Code session (stream A) on 2026-10-08.
> - **Daniyal's text:** the instructions below, pasted as one message. He refers to a `harness-release-plan.md`, which wasn't supplied; the message says it's self-contained.
> - **Claude's questions:** three, through the session's multiple-choice question control. Daniyal picked one option each and wrote no text of his own.
> - **The plan:** Claude wrote an executable sprint plan from the instructions, an audit of `main` @ `818ccef` and an adversarial review. Daniyal approved it through the session's plan-approval control. Its decisions are D-110 to D-119.

**Daniyal's instructions, verbatim:**

````text
You are Daniyal’s Claude Code session and the integration lead for Harness. Vihaan has a separate Claude Pro session; mine uses Max. We want a private, working product on both of our Macs within 72 hours of starting this sprint. We will build the entire UI through Harness so the UI work is also a real test of Harness. Turn this into an executable plan, then start implementing it. Do not stop after giving me another broad roadmap.

Repository: https://github.com/vihAan02/harness
Reviewed baseline: 4bfa285d4414c6b7d69714ec635d7bce67511268. Refresh before relying on it; both owners are actively working. If supplied, read harness-release-plan.md as the detailed proposed plan. This prompt is self-contained.

OWNER DIRECTION

Prioritize a complete two-person, two-Mac private pilot and its thin UI ahead of completing the counted A/B study. Record this as a narrow new owner decision superseding the relevant sequencing in D-04/D-05 and the thin UI deferral in D-06. Preserve old decisions and source records, frozen benchmark revisions and results. Do not claim the A/B gate passed. This direction does not relax the security model, expand paid budgets, or authorize subscription credential sharing. Follow the repo’s existing file ownership, PR review and merge rules.

WHAT SUCCESS MEANS

Both Macs can install the same pinned candidate, join the same project as different humans/devices, approve local work, run their own sandboxed agents, exchange coordination messages, publish task branches, integrate through GitHub with required checks, fetch the actual merged code, warn affected agents, and recover from sleep/restart/disconnect without lost edits or duplicate execution. Both owners have a usable local UI for the workflow. Every UI implementation change, including styles and UI tests, is authored in an actual Harness task/session and integrated through the tested path. We can show task/session/PR/merge evidence.

The existing CLI is the bootstrap interface. The scope is one project, two preprovisioned humans and one execution device per human, with the current Claude adapter. Public signup/billing, Codex, cloud agents, arbitrary remote file reads, R2, distributed filesystems, autonomous planning agents, a new merge engine and a full dashboard are later work. A thin complete task workflow is in scope; visual extras are not prerequisites.

FIRST ACTIONS, BEFORE NEW CODE

1. Read the actual repo’s AGENTS.md, PLAN.md, HANDOFF.md, roadmap, architecture, protocol, coordination, local-runtime, security, agent-adapters, open questions, package scripts and CI. This is an npm/Node project; do not apply unrelated gstack development commands. Work outside iCloud.
2. Fetch main; inspect local changes, active issues, open PRs and any benchmark freeze tag. Do not overwrite someone’s work or duplicate an active branch. At the audit refresh, open PRs were #85 provider/budget, #84 A/B contract, #83 runner fixes, #82 status, #80 A/B protocol and #65 judge. That list can change. #74 contains shutdown/recovery work needed by the pilot. Preserve the benchmark work; review reusable status/provider changes through normal rules.
3. Run npm ci and npm run check with the repo’s pinned Node and Postgres 18 setup. Distinguish results you run from results in old handoffs. Record any baseline failure before changing it. Scripted agent tests need no paid model calls.
4. In the first hour, produce a short current-state assessment, the critical dependency graph, numbered acceptance tests and task cards split between both streams. Record the sprint decision and the new ownership/interfaces, reserving migration numbers and decision IDs. Put active tasks in the existing issue/workboard process. Then implement the first critical task. Do not spend half a day making planning artifacts.
5. Determine the reachable private coordinator host, both Macs’ setup, current GitHub protection capabilities and the approved API runtime budget immediately. If required setup needs a human, ask for the exact missing action and keep working on independent code/tests.

KNOWN SOURCE FINDINGS TO VERIFY

- server/src/server.ts checks a shared local token and then accepts the client’s claimed principal; main binds loopback. A tunnel alone does not fix identity.
- daemon/src/daemon.ts taskAssigned starts from the local branch tip, and runSync merges the local base. Product code does not fetch/push code between machines. A remote landed event cannot create missing Git objects.
- Assignment handling routes by agent.humanId, without explicit execution-device ownership. Server task assignment can trigger another human’s agent. It needs device routing and local approval under D-34.
- daemon/src/link.ts persists the event cursor after scheduling asynchronous work; replay skips lifecycle work. Startup kills orphan sessions and recovers lands, but does not reconcile all in-progress tasks. Crash after assignment/completion delivery can strand work.
- #74 covers bounded stop when the server is unreachable, aborting a running land test, and leftover cleanup. Fix those and the additional lifecycle crash windows.
- CLI does not provision humans/devices/projects/memberships; demos seed the database directly. Clean onboarding needs deterministic bootstrap/doctor.
- provider.ts and ClaudeAdapter hardening require API auth. Max/Pro development sessions do not supply product-agent runtime authentication.
- Existing waits, task reopen, read capture, notices, leases and local land already work. Reuse them. A done dependency is not enough until its code has landed and synced (D-106).

ARCHITECTURE AND CONTRACTS

Keep the existing Postgres + WebSocket coordinator, local daemons, isolated Git worktrees, adapter boundary, readsets and event projection. Files remain local; GitHub transfers committed code. The coordinator stores metadata rather than repo copies or model credentials.

For the pilot, use a suitable existing coordinator host with encrypted private connectivity, preferably loopback listeners behind authenticated SSH tunnels. Do not expose the current shared-token server on the Internet. Bind authentication to the provisioned human/device records. Keep D-33 signed dispatch with pinned verification keys and replay protection, D-34 local owner approval, and local policy ∩ cloud policy. Use built-in crypto/transport primitives rather than building authentication infrastructure. Remote assignment/approval/config input must never widen local allowlists. Keep keys out of agent environments, repo files, logs and browser bundles.

Make execution device ownership explicit and idempotent. Persist enough state to reconcile assignment, local approval, setup, session start/end, task completion, pending commands, publication and integration after restart. A second daemon or replay cannot start the same execution twice. Preserve unmerged edits and branches. If resuming the pinned vendor session is unproven, show a stopped state and restart from preserved work with a clear context handoff; do not pretend reopen already implements crash recovery.

Add an explicit remote-project integration mode and preserve local 0B behavior for its tests/benchmark. harnessd owns Git writes, checkpoint commits, task-branch pushes and fetches. Git credentials belong to trusted host-side operations, not sandboxed agents; verify the Git wrapper’s restricted environment can authenticate without putting tokens into readable remote URLs. Worktree changes must not be copied between Macs outside Git.

A finished task publishes its branch/PR. GitHub runs required CI and the existing review rules apply. Human approval identifies the exact head. Confirm the merged commit before reporting integration complete. Each other daemon fetches that confirmed SHA, syncs at the existing safe boundary, then delivers the landed notice/resolves the dependency. Missing objects, failed fetches or conflicts leave explicit pending/blocked states. Start tasks from a verified remote base. Poll GitHub for this pilot; no webhook platform is needed. Detect external human merges too.

Do not treat a successful harness/claims status as live fencing. A lease token can change without the PR head changing. Implement a small, durable, human-triggered integration reservation under the existing project/lease transaction lock. One active reservation per project is adequate here. Bind it to task, repository, PR, exact head/base, changed paths and current claim generations; refuse competing ownership changes until GitHub’s result is known, even after normal lease expiry. Merge the approved head through GitHub with protections intact. Timeout means outcome_unknown: retain the reservation and reconcile, never release it because a timer elapsed. A changed head invalidates the old approval. This wraps one approved merge; do not build a scheduler or merge train. Use this finalization path for Harness task PRs. Direct GitHub merge bypasses reservation fencing unless permissions enforce it; document that limit honestly.

Verify protections at the start. Do not quietly bypass missing required checks, use --no-tests, force-push the base, or auto-resolve product conflicts with --theirs. Benchmark-specific conflict rules are not product rules.

Require GitHub’s up-to-date-with-base protection. If the base advances, invalidate the base-bound candidate authorization and refresh its diff, CI and approval. Test an external merge between reservation and merge submission. If the request is already in flight, reconcile the outcome before unlocking. Head-SHA comparison alone does not compare the base. Exact-base serialization requires all relevant base updates through the finalization path; outside merges bypass that guarantee. Preserve squash-only merging, verify the confirmed merge contains the approved task diff, and support safe cleanup after a squash without relying on task-head ancestry.

STREAMS AND TIMING

You own integration, shared contracts, daemon/adapters and the backend areas assigned to Stream A. Own the remote Git/integration/recovery chain. Vihaan owns the existing Stream B areas, deterministic setup/doctor, device-assignment handlers, CLI, the new thin UI and its tests. Any new bridge module in daemon-owned territory needs an explicit seam/review; Vihaan should not edit daemon.ts or adapters concurrently. Reserve shared files and migration slots first. Send Vihaan a bounded handoff with exact interfaces, fixtures, dependencies and acceptance criteria through the owner’s established handoff process. Respect existing ownership if a task crosses the proposed split.

T+0–6h: baseline, owner decision, bootstrap/identity/dispatch/execution/integration/UI contracts; both Macs connected privately as distinct identities.
T+6–24h: real cross-clone task publication → PR/CI → approved merge → exact-SHA fetch/sync; demonstrate recovery of an interrupted operation. Vihaan finishes setup/routing/CLI and the UI contract fixtures in parallel.
T+24–48h: run the proven core from a pinned separate checkout. Build the entire thin UI through Harness tasks. Review and fix core failures discovered through those tasks.
T+48–60h: fault injection, trust/fencing checks, provider failure and clean setup. Finish the complete UI workflow.
T+60–72h: freeze candidate, run required checks, reinstall the same SHA on both Macs, repeat real flows in both directions and run at least a two-hour dogfood soak. Publish release evidence and recovery instructions.

At hour 24, remote messaging alone is not a passed gate. If actual Git integration/sync/recovery fails, both streams fix the blocker and reduce UI polish/optional views. Do not weaken isolation, local approval, fencing or recovery to call it shipped. If a mandatory gate fails by the deadline, report the precise blocker and finish it; do not claim release readiness.

UI DOGFOOD CONTRACT

Run the supervising Harness from a separate stable checkout outside iCloud, pinned to a known SHA. The target development repo can contain packages/ui. Agents must not hot-replace their running daemon. Promote core revisions at checkpoints with sessions safely stopped and unmerged work preserved.

Choose a simple UI stack compatible with the repo. One local browser app plus a host-side bridge is sufficient. Reuse ProjectView/event cursors and existing commands; do not build a second database or embed the coordination token in client code. The bridge needs local session/origin/CSRF protection, validation, command IDs, timeouts and useful connection errors. Local approval actions remain on the device’s own bridge and retain setup/test command-and-manifest hash checks.

Minimum complete UI: scoped task creation/assignment, agent and device presence, task detail/state, messages/questions, waits/stale-context notices, pending local approval, PR/integration state, blocked/stopped/error states with recovery controls, and actual runtime cost/budget warnings. It must work for both owners, including disconnected/reconnected state.

Create small Harness tasks for contracts/client, board, task actions/detail, messages/approvals/recovery, and UI tests. Freeze shared types first and land dependency contracts early. Every app/style/test implementation change must have a Harness task/session. You can plan/review in the Max session; do not bypass the dogfood requirement by writing UI directly outside managed task worktrees. If the runtime cannot complete a UI task, fix it or surface the measured budget blocker.

COST AND LONG-RUN RULES

Keep development subscriptions separate from product-agent API credentials. Max and Pro have shared usage limits and do not guarantee 24/7 calls. Do not enable paid extra usage, change a provider, reuse another person’s credentials or alter approved caps without owner authorization. Consult current official Claude authentication guidance when needed; do not change the product to reuse subscription login as a sprint shortcut.

Pending PR #85 records a $0.50/day development/demo cap and provider change. Verify the approved current ledger/PR before selecting a model. Preserve existing limits. A per-session budget is not a daily aggregate: account for both Macs and all probes/demos/concurrent tasks, with provider-enforced caps where available. Run the first small real UI task early and report measured cost. If useful dogfooding cannot fit, ask for a specific additional budget based on evidence while continuing free critical work. Do not assume three days of UI development fits in $1.50.

Start with one product agent per Mac; increase only after showing throughput benefit. Use scripted agents for transport/fault tests. Avoid repeated expensive whole-repo planning, unbounded retry loops and polling prompts. Bound retries and suspend waiting work. Keep per-task acceptance criteria, operation journals and compact handoffs so development sessions can continue across context/usage resets. Keep detached long jobs observable and poll them to completion using repo/environment-supported supervision. Never kill unrelated sessions or restart a paid run just because it is slow.

Reuse each Mac’s Git object database and narrow approved package download caches. Do not share writable node_modules across worktrees or disable confinement to make installation pass. Retain unmerged work, cap logs, stop idle agents and safely clean scratch only after verified completion.

ACCEPTANCE TESTS TO IMPLEMENT AND RUN

1. Two real Macs join the same project without manual SQL. Both use distinct identity/device credentials and local repo allowlists. Each runs its own approved agent.
2. Wrong principal/device, modified or replayed dispatch, unauthorized remote start and cloud attempts to widen local policy are rejected. Run Phase 1 T-3/T-4/T-5: forged dispatch, unapproved remote start, and security-weakening requests held for human review. Existing read/write/credential isolation tests remain green.
3. Two independent clones initially lack each other’s new commits. A changes a file B read, publishes and integrates via a real GitHub PR. B fetches the confirmed merge, syncs safely, rereads/reconciles and passes coupled integration tests. Repeat with B publishing and A receiving.
4. After a green claims check, issue a newer overlapping token; finalization refuses the stale candidate before a merge request. A valid reservation blocks competing ownership across disconnect, lease expiry, restart and an ambiguous GitHub response. Changed heads/bases invalidate approval; test a base advance between reservation and merge. Verify squash integration and cleanup; one confirmed merge yields one landed event.
5. Interrupt after assignment reception, during approval/setup, mid-turn, after report_done, during push, after merge request and before result persistence. No duplicate session, lost edit, false landed state or orphaned busy task without a recovery action. Bounded shutdown works while the server is unreachable and tests are running.
6. Sleep/disconnect one Mac while the other integrates. Reconnect fetches and replays once and preserves edits. Expired leases are never revived; a newer overlapping grant causes the old fencing token to be rejected. Preserve D-103: expiry alone does not reject landing when no newer overlapping token exists. A sync conflict blocks with an actionable recovery path.
7. Rate limit, invalid credential and API budget exhaustion stop safely and can be recovered without automatic billing/provider switches.
8. All UI implementation changes come from actual Harness task sessions and tested PRs. Both humans use the resulting UI to run a subsequent real task.
9. Run npm run check and the repo’s targeted suites, npm run demo, npm run demo:0b and current required CI checks on the exact candidate. Add meaningful deterministic two-clone, identity and recovery tests with scripted agents; physical Macs and real GitHub still need the manual acceptance run. Repeat new critical integration tests under AGENTS.md’s rules. Keep hidden benchmark grading isolated; do not inspect hidden checks or change A/B parameters to help the pilot pass.

Every task handoff/PR should state changed behavior, contracts/migrations, tests actually run, actual API spend, remaining risk and notes for the other stream. Update the durable plan/workboard and HANDOFF at checkpoints so neither Claude re-plans from old Phase 0B instructions. End with a candidate SHA, task/session/PR/merge evidence from both Macs, costs, install/recovery commands and explicit acceptance outcomes.

Start now with the repository refresh, baseline and minimal contract plan. Make routine implementation choices yourself within this scope and keep progress moving.
````

**Question 1, as asked:** "Which host should run the private coordinator (Postgres 18 + harness server on loopback, reached only through authenticated SSH tunnels)? Both Macs need SSH access to it, and acceptance test 6 sleeps one Mac while the other keeps integrating."
- Existing always-on host (Recommended): A Linux box or Mac you both can already SSH into, that stays up. Sleep/disconnect tests then work in both directions. Tell me the host and SSH user in the notes.
- Daniyal's Mac: Zero new infra, but Vihaan's Mac needs SSH to it (Remote Login plus the same LAN or Tailscale), and while it sleeps nobody can coordinate. Test 6 runs one way only.
- New small VPS: I'd give exact provisioning steps. It costs money and needs your approval and an account. About an hour of human setup.

**Daniyal's selection:** `Existing always-on host (Recommended)`. The host and users weren't named; they're asked for separately.

**Question 2, as asked:** "What runtime budget applies to product agents (Haiku 5.5 on OpenRouter, per the D-126 proposal in PR #85) for this sprint? Each human uses their own OpenRouter key with a provider-enforced daily cap."
- $0.50/day total, measure first (Recommended): Keep #85's cap, split across both Macs. I run one small real UI task early, report its measured cost, and come back with an evidence-based ask if dogfooding won't fit.
- $0.50/day per Mac: Each human's key is capped at $0.50/day, so $1/day combined and about $3 over 72h.
- Higher cap now: Name the per-day amount in the notes. I'll still measure and report spend per task.

**Daniyal's selection:** `$0.50/day total, measure first (Recommended)`

**Question 3, as asked:** "How should harnessd authenticate to GitHub to push harness/task/* branches and open, poll and squash-merge PRs on vihAan02/harness? It runs host-side only and never inside an agent sandbox or a remote URL."
- Each human's gh login (Recommended): harnessd shells out to git and gh with a restricted environment, using the credential helper or keychain already set up on each Mac. No new tokens.
- Fine-grained PAT per human: Scoped to vihAan02/harness (contents and pull requests: write). harnessd reads it from a named env var, like provider keys. More setup, tighter scope.

**Daniyal's selection:** `Each human's gh login (Recommended)`
