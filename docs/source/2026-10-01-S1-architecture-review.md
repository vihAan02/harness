# S1: Architecture review (raw record)

> **Status:** Raw source record. **Do not edit.** Superseded where S2 or S3 sharpen it. See [PLAN.md](../../PLAN.md) for the reconciled plan.
>
> **Provenance:**
> - Another Claude session produced this review of an earlier architecture proposal ("harness": cloud coordination plane, `harnessd`, worktrees, MCP API, claims, snapshots, `harness://` file fabric on R2, integration queue).
> - The owner pasted it into a Claude Code session on 2026-10-01 and declared it, plus that chat, the source of truth.
> - **The original proposal text is not available on this machine.** Its components are only known through the references in this review. See Q-12 in [open-questions.md](../open-questions.md).
> - The review's closing line ("If approved, I'll write this review... as ARCHITECTURE.md") was never acted on. The 2026-10-01 workspace replaces that step.
>
> The text below is verbatim as pasted. The paste had lost its markdown list formatting, so it's kept in a text block to avoid re-interpreting it.

````text
Evaluation: multi-device, multi-vendor agent harness architecture
Context

You pasted an architecture proposal for a "harness": a cloud coordination plane (Postgres + WebSocket), a local harnessd daemon on each machine, per-agent Git worktrees, an MCP API for agents, soft/hard file claims, task snapshots, a harness:// file fabric backed by R2, and an integration queue. ~/Desktop/harness-ai is empty, so this is a design review only. No existing code was checked against it.

Verdict: The direction is sound. Most of the big calls are right. The plan has one structural blind spot: it assumes agents will route their work through your MCP tools. Claude Code and Codex won't do that reliably, because they read, edit, and run shell commands with their own built-in tools. That one assumption weakens the permission model, the snapshot model, and real-time messaging. It also underplays cross-human security and takes on too much scope for an MVP.

What's right (keep these)
Share coordination, not disk state. This is the correct core idea.
Isolated worktrees, with hard claims enforced at integration time rather than as filesystem locks. This is the key insight in the doc.
Git syncs the code. Don't re-upload repos.
Postgres plus WebSocket first, NATS later. This is the right order.
No CRDTs for source code. CRDTs are fine for the board, presence, and notes.
MCP as the compatibility surface, not the internal protocol.
Content-addressed blobs and presigned URLs, so file bytes don't pass through your API.
Deny-by-default directory allowlist on the daemon.
Claims need TTLs and heartbeats.
Gaps and risks, most important first
1. Agents won't use your file API, so MCP can't enforce anything

Claude Code and Codex read and edit files with their native tools. They run shell commands directly. They won't call harness.read_file or harness.apply_patch unless you prompt them to, and even then they do it inconsistently. As a result:

Permissions: the "agent × source × path × capability" model can't be enforced through MCP. What actually limits an agent is:
what the daemon puts into the worktree
the agent's own sandbox and permission config (Claude Code settings.json deny rules and its bash sandbox; Codex sandbox_mode and approval policy)
pre-tool hooks where the harness supports them (Claude Code PreToolUse can deny a call)
which credentials exist in the agent's environment
Fix: the daemon should compile the permission policy into each harness's native config. Treat MCP calls as advisory.
Snapshots: for Git, the worktree at its base commit already is the snapshot. For non-Git sources the agent reads whatever is on disk, not your pinned version. Fix: copy non-Git sources into the worktree at task start (for example .harness/sources/<id>/, read-only). Keep a read-set log of the hash recorded at each read. Don't promise reproducible snapshots of local files, Notion, or similar sources.
Claims: agents forget to declare them. Fix: the daemon watches each worktree's diff and publishes soft claims from the edits it observes. An explicit claim_files call becomes an optional upgrade to a hard claim. Derived claims are far more reliable than declared ones.
2. Messages reach agents only between turns, and only if the daemon drives the agent

An agent only sees a message when it calls read_messages. MCP server notifications don't get injected into the model's context mid-turn. "Real-time" is real for humans watching the dashboard, not for agents. Fix:

Have the daemon run agents through their programmatic interfaces, not the interactive terminal UIs:
Claude Code: Agent SDK, or claude -p with stream-json input and output
Codex: its SDK, or codex exec
Deliver inbox items at turn boundaries:
Claude Code PostToolUse can add context to the conversation.
A Stop hook can block the stop and keep the agent working when it has unread items or a dependency has just resolved.
With the SDK, the daemon can inject the message as a new user turn.
Add a wait_for(event, timeout) tool, or park tasks on their dependencies, so an agent that needs an answer doesn't spin or guess.
3. Security across humans is the biggest missing threat model
Remote code execution path: the cloud can tell a daemon to start an agent with instructions, and that agent runs shell commands on someone's laptop. A compromised coordination plane, or a malicious teammate, therefore means code execution on every member's machine. Fix:
The local daemon policy is the root of trust. The effective permission is the intersection of local and cloud policy, so the cloud can only narrow it.
Commands from the cloud are signed.
A local human must approve when a remote party starts an agent, grants a new permission, or requests an on-demand file read.
Prompt injection between agents: a message from Safeer's agent to Daniyal's agent is untrusted input that can tell it to read ~/Documents/... and post the contents back. Fix:
Label messages from other principals as untrusted data when injecting them.
Never let message content widen what the receiving agent can read.
Treat file reads that serve a remote agent as an exfiltration channel, and log and rate-limit them.
Stale lease holders: a laptop can sleep, wake up, and still believe it holds a lease. Fix: issue a fencing token (a counter that only goes up) with each lease, and have integration reject changesets carrying an old token.
4. Don't build the integration engine yet; GitHub already has one

"Rebase, run tests, merge" needs a neutral place to run tests. The plan never says where tests run. MVP fix: each agent's branch becomes a PR, and GitHub merge queue plus required CI checks do the integration. Your value-add is what happens after the merge: map the changed paths against in-flight agents' read sets and claims, and notify only the affected agents. Never rebase a live worktree out from under an agent. Tell it instead, and let the agent (or the daemon, between turns) rebase.

5. Claims don't catch semantic conflicts

Path claims stop two agents editing the same file. The real "20 correct changes break the app together" failures are contract changes: API shapes, shared types, schemas. Claims are a cheap early warning. The real protection is integration tests plus contract-aware notifications, for example "you changed src/types.ts, and 2 agents imported it." Keep claim patterns to directory prefixes and exact files. Overlap checks between arbitrary globs are hard to get right.

6. The day-to-day realities of laptops are missing
Laptop sleep and shutdown. Agents die, leases expire, and on_demand files go offline. You need task reassignment and resumable sessions (both CLIs support resume), and the daemon should push WIP commits to harness/wip/<agent>/<task> at checkpoints.
Worktree bootstrap. A new worktree has no .env and no node_modules, so tests can't run. You need a per-project setup script, a dependency cache, and a list of allowed env files to copy.
Port collisions when several agents run dev servers on one machine.
Cross-device worktrees. The diagram's "one repo, worktrees a/b/c" only holds on a single machine. Across devices it's just branches on a shared remote, so WIP pushes are what make in-progress work visible to other agents.
7. The harness:// file fabric is a v2 feature dressed as the core abstraction

Agents work best with real files on disk. The URI scheme is a good internal address for the coordination plane, not the API agents should use. Drive, Notion, and similar services already have MCP connectors that agents can call directly. Within the file fabric, the on_demand policy (streaming one person's local file to another person's agent) is the most complex and riskiest piece: it needs the source device online and creates an exfiltration path. Defer it.

8. Scope, cost, and consistency nits
The cost section optimizes the wrong thing. Storage on R2 is pennies. The real costs are LLM usage and always-on WebSocket and Postgres infrastructure. Users presumably pay for LLM usage through their own subscriptions, so check each vendor's terms on whether a third-party orchestrator may drive CLIs signed in with a consumer subscription. An API key may be required for a commercial product.
Task decomposition is unspecified, yet it determines most of the outcome: who writes TASK-118, a human or a planner agent? The same goes for human review and approval gates.
The example config includes a location: cloud reviewer, but the MVP table excludes cloud execution.
The MVP table still includes R2, local-file access, and the daemon file service. Cut them.
Event log: use a per-project monotonic sequence number so clients can resume from a cursor after a disconnect. Postgres LISTEN/NOTIFY is enough for fan-out at first.
Verify the cited competitors (Agent Mail, Axis, Agentlocks, COORD-Harness, Relay, Warp's orchestration modes) before positioning against them. Some may be inaccurate or inactive.
Positioning

The strongest wedge is multiple humans, each running their own agent on their own machine under their own subscription, coordinating on one repo. Codex, Cursor, and Warp parallel agents are single-user, so this is the gap. The "data fabric across Drive and Notion" angle is weaker because MCP connectors already cover it. Lead with cross-human coordination, then add data sources later.

Revised MVP sequence
Phase 0 (prove the core loop):
Postgres plus WebSocket coordination server: tasks, claims with fencing tokens, messages, and an event log with cursors.
harnessd drives Claude Code through the Agent SDK in a worktree.
An MCP server exposes tasks, claims, and messages.
Hooks inject the inbox and block stops while tasks are open.
Scope: one human, two agents, one machine.
Phase 1 (multiplayer):
A second human and machine, with Codex.
WIP branch pushes and claims derived from edits.
GitHub PRs plus merge queue for integration.
Merge-impact notifications.
Local-root-of-trust approvals.
Phase 2:
Dashboard.
Policy compiled into each harness's native sandbox and permission config.
Worktree bootstrap and dependency caching.
R2 for shared artifacts only.
Phase 3:
Non-Git sources copied into the worktree, with read-set logging.
Cloud agents.
An integration and review agent.
on_demand cross-device file reads.
How to validate the design before building much
Phase 0 experiment: give two agents overlapping tasks on a real repo, once with plain worktrees plus PRs and once with harness coordination. Measure merge conflicts, wasted or duplicate work, rework after merge, and how often agents actually use claims and messages without being prompted. If coordination doesn't clearly win, the product thesis needs adjusting before Phase 1.
Security test: have a hostile agent message try to make a peer read and return a file outside its allowlist. It must fail even when the peer agent tries to comply.
Laptop-sleep test: a lease expires while its holder is asleep, another agent claims the path, and the stale holder wakes and publishes. Integration must reject the stale publish.
If approved

I'll write this review and the revised MVP as ARCHITECTURE.md in ~/Desktop/harness-ai. Phase 0 scaffolding is a separate step, and you'd decide on it next.
````
