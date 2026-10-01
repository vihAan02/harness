# S3: Owner's final adjustments (raw record)

> **Status:** Raw source record. **Do not edit.**
> - This is the highest-precedence source. Where S1, S2 and S3 conflict, S3 wins.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan.
>
> **Provenance:**
> - The owner wrote this on 2026-10-01 when approving the overall architecture, with final adjustments to apply before the plan became the source of truth.
> - Verbatim, except that curly quotes and apostrophes are normalized to straight ones.
> - Kept in a text block so the owner's formatting is preserved exactly.

````text
I reviewed the plan and I'm good with the overall architecture and direction. Go ahead with it, but make these final adjustments before treating it as the source of truth.

The main principle is:

**Keep the product vision extremely ambitious, but make the build sequence disciplined.**

I do NOT want to reduce the eventual scope of the product. The end goal is still a multiplayer AI engineering harness that can support:

- multiple humans
- multiple agents
- multiple machines
- multiple agent vendors
- real-time/event-driven coordination
- task ownership
- soft/hard claims
- stale-context detection
- dependency/contract awareness
- secure local execution
- cloud agents later
- shared artifacts later
- local/cloud/non-Git sources later
- eventually a secure hybrid file/data fabric

The ambition is intentional. What I want to avoid is implementing five future infrastructure systems before we know the core coordination loop works.

## 1. Split Phase 0 internally into Phase 0A and Phase 0B

Do not remove any important Phase 0 concepts from the architecture. Just sequence them.

### Phase 0A — prove the core coordination loop

1 human  
1 machine  
2 Claude Code agents  
1 repo  
2 worktrees  
1 coordination server

Prove that the harness knows:

- which agents are alive
- which task each agent owns
- what each agent is currently modifying
- what other agents are working on
- when there is likely overlapping work
- how Agent A asks Agent B a question
- how B's answer gets delivered back to A at a safe turn boundary

Include:

- AgentAdapter abstraction with ClaudeAdapter
- worktree lifecycle
- human-written tasks
- agent presence/status
- typed messages
- edit-derived awareness / soft claims
- event log / cursor model if needed for the architecture
- basic setup command
- per-agent port allocation

Do not overbuild anything here.

### Phase 0B — prove stale-context protection

Once 0A works, add:

- read-set tracking
- `(path, content hash)` tracking
- dependency invalidation
- `wait_for(..., timeout)`
- stronger claim semantics
- fencing tokens
- inbox/turn-boundary hooks
- stale-context notifications

Example:

Agent A read:

`src/types.ts @ hash ABC`

Agent B changes it and finishes work.

Harness tells A:

`Dependency changed: src/types.ts has changed since you read it.`

That is one of the core product behaviours.

## 2. Treat read-set tracking as best-effort, not omniscient

Do not design the system as if we can perfectly know everything an agent has read.

Native Read/Grep/Glob hooks may give us strong coverage, but shell commands like:

`cat`
`sed`
custom scripts
compiler/tool output

may bypass direct tracking.

So document:

**read sets are a high-value signal, not a perfect security or dependency oracle.**

We can combine them later with:

- import graphs
- language-server data
- Git diffs
- contracts/schemas
- build/test dependency information

Do not pretend Phase 0 has perfect dependency tracking.

## 3. Use both prospective and observed claims

Do not rely only on claims created after an edit occurs.

Use three levels conceptually:

### Prospective soft claim
Derived from the human-assigned task/scope.

Example:

Frontend task likely touches:

`src/frontend/**`

### Observed soft claim
The daemon actually sees the agent editing:

`src/components/Login.tsx`

This is ground truth about current work.

### Hard claim
Explicit exclusive lease with TTL + fencing token where needed.

Claims are still **warnings and coordination signals**, not the primary mechanism protecting correctness.

Correctness priority remains roughly:

1. stale-context/dependency awareness
2. tests / CI
3. contract-aware notifications
4. claims

## 4. Keep messages sparse and typed

I do not want agents sitting there having giant free-form conversations.

Communication should be event-driven.

Keep types like:

- `question`
- `answer`
- `dependency_changed`
- `contract_request`
- `task_blocked`
- `claim_conflict`

Peer-agent messages remain untrusted.

Receiving agents should effectively understand:

SOURCE: peer-agent  
TRUST: untrusted suggestion  
PERMISSIONS: none

A peer message must never expand permissions.

## 5. MCP is compatibility, not the core dependency

Keep MCP in the architecture.

But do not let Phase 0 succeed or fail based on building a perfect MCP server.

`harnessd` is already supervising the agent through its programmatic interface.

The core system should have its own internal coordination protocol.

MCP is an interface we can expose for compatible agents/tools.

MCP is NOT:

- the security boundary
- the source of truth
- guaranteed to be how the agent performs filesystem operations

## 6. Keep AgentAdapter from day one

This stays.

Vendor behaviour should never leak throughout the application.

Conceptually:

```ts
interface AgentAdapter {
  startSession(...)
  resumeSession(...)
  injectMessage(...)
  stopSession(...)
  getStatus(...)
  compilePermissions(...)
  setupHooks(...)
}
```

Plus capability flags such as:

- canCaptureReads
- canDenyToolCalls
- canInjectTurn
- canResume
- supportsMCP
- supportsHooks

Phase 0: ClaudeAdapter only.

Phase 1: CodexAdapter.

## 7. Design identity correctly even before multiplayer

Even though Phase 0 is:

1 human  
1 machine

do NOT model the database assuming that forever.

Think in terms of principals:

- HumanPrincipal
- AgentPrincipal
- Device
- Project
- ProjectMembership
- AgentSession

Do not bake things in like:

`project.user_id`

when the eventual system is multiplayer.

Phase 1 can implement the actual remote security model, but Phase 0's data model should not fight it.

## 8. Contract awareness is the eventual direction

File awareness is our V1 proxy.

Longer-term, the useful alert is not only:

`auth.ts changed`

It is:

`POST /login response contract changed, and Agent B is working on a consumer of POST /login.`

Likewise:

- DB schema
- API schema
- shared types
- function interfaces
- events
- config schema

Keep contract-aware notifications in the roadmap.

Do not overbuild them during Phase 0.

## 9. Preserve the aggressive scope cuts

Do NOT pull these forward just because they are interesting:

- R2
- distributed filesystem
- Drive/Notion sources
- cross-device on-demand file reads
- cloud execution
- planner agents
- integration agents
- full dashboard
- full resource scheduler
- custom CI
- custom Git merge engine
- VM platform

Those are still part of the broader vision where appropriate.

They just come after the coordination thesis is validated.

## 10. Make the A/B experiment a first-class part of the plan

The real competitor is:

**two terminals + two Git branches/worktrees + a human relaying context through Slack/Discord.**

Before building Phase 1, compare that baseline against Harness.

Measure:

- total task completion time
- duplicated work
- conflicting edits
- semantic rework after integration
- human interventions
- number of stale-context incidents
- messages exchanged
- tokens consumed
- failed tests / integration issues
- time the human spends coordinating agents

Important:

Do NOT define success as only "Harness is faster."

A useful Phase 0 result could be:

- similar completion time
- much less duplicate work
- fewer broken contracts
- fewer human interventions
- fewer stale-context failures

That still validates the product.

Propose a reasonable pass bar in `validation.md`, but clearly mark it as a proposal for me to approve rather than silently declaring it final.

## 11. Keep the ambitious documentation, but don't let documentation become the project

I still want future Claude/Codex sessions to open the repo and understand the whole vision.

So keep the important documentation structure.

However, optimize for clarity rather than bureaucracy.

The most important docs are:

- `README.md`
- `CLAUDE.md`
- `AGENTS.md`
- `PLAN.md`
- `docs/architecture.md`
- `docs/coordination.md`
- `docs/agent-adapters.md`
- `docs/local-runtime.md`
- `docs/protocol.md`
- `docs/security.md`
- `docs/validation.md`
- `docs/roadmap.md`
- `docs/open-questions.md`
- research/vendor capability notes where factual verification matters

If some proposed document or process is just duplicating information for the sake of completeness, simplify it.

Do not create enterprise-process overhead before we have a prototype.

## 12. Core principles to lock in

These should be extremely clear throughout the docs:

**Share coordination, not disk state.**

**Git is the code synchronization layer.**

**The harness cloud is the coordination layer.**

**The local daemon is the execution/security boundary.**

**MCP is a compatibility layer, not an enforcement layer.**

**Stale context is a bigger problem than literal file collisions.**

**Claims are awareness mechanisms, not correctness guarantees.**

**Peer-agent communication is sparse and untrusted.**

**Task decomposition stays human-led initially.**

**Vendor-specific behaviour stays behind AgentAdapter.**

**The product vision stays ambitious; the implementation sequence stays disciplined.**

## Product thesis

The broader product I want to test is still:

> A multiplayer coordination layer for humans and AI agents working across machines, models, and eventually data sources.

The strongest first wedge is:

> Multiple humans, each running their own AI coding agents on their own machines, coordinating on one repository as one AI-augmented engineering team.

Phase 0 uses one human / one machine simply because that is the fastest way to prove the coordination primitives.

Do not confuse the Phase 0 constraints with the size of the eventual product.

## What to do now

Update the proposed workspace/documentation plan with these changes.

Do the vendor/capability research needed to verify assumptions.

Clearly distinguish:

- verified facts
- architectural decisions
- hypotheses
- open questions

Then create the agreed planning/documentation workspace.

Do **not** implement Phase 0 product code yet.

At the end, report:

1. the final architecture decisions;
2. what changed from the previous plan;
3. anything your research contradicted;
4. unresolved questions that genuinely matter before implementation;
5. the exact Phase 0A → Phase 0B → Phase 1 sequence;
6. the proposed A/B validation metrics and pass bar.

Do not reduce the product vision because Phase 0 is small. The whole point is to build toward the ambitious system while proving each layer in the right order.
````
