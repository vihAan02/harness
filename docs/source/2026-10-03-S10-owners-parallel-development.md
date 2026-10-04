# S10: The owners split the rest of Phase 0B into two parallel workstreams (raw record)

> **Status:** Raw source record. **Do not edit.**
> - The newest source. Where S1–S10 conflict, S10 wins.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan. Recorded there as D-94.
>
> **Provenance:** pasted into co-owner Daniyal Mughal's (GitHub `DaniyalMughal1`) Claude Code session on 2026-10-03, after PR #1 (0B's first stretch) was merged into `main`. The text speaks for both owners, Daniyal and Vihaan (GitHub `vihAan02`). Claude proposed a plan; the session's user sent two corrections, then approved revision 2 of the plan through the session's plan-approval control (no text). Verbatim excerpts follow. The approved plan itself is Claude's text, not the owners' words: D-94 records what it decided.

**The request message:**

````text
We now have TWO developers working on Harness in parallel:
- Daniyal — using Claude with the 5x plan / higher capacity
- Vihan — using normal Claude plan
The latest Harness work has already been pushed and merged into GitHub main.
We need to stop working sequentially. Right now the bad workflow is:
Daniyal works → pushes → Vihan pulls → works → pushes → Daniyal waits → pulls → repeats.
That wastes half our development capacity.
I want you to design a parallel development plan where both of us can work at the SAME TIME on separate tasks with minimal overlapping files, then continuously merge our branches into main without breaking production.
Before proposing the split:
1. Pull the latest main.
2. Read HANDOFF.md completely.
3. Read PLAN.md, the Phase 0B roadmap, open questions, and relevant docs.
4. Inspect the actual codebase.
5. Inspect recent Git history so you understand exactly what just landed.
6. Inspect harness-bench too if any remaining tasks touch benchmarking.
Do NOT rely only on the old plan. Base the split on the CURRENT merged code.
OBJECTIVE
We want the fastest safe route from the current state to a working MVP.
Both developers should be productive simultaneously as much as possible.
We want:
- minimal file overlap
- minimal merge conflicts
- clear ownership
- frequent small PRs
- main always green
- dependencies merged in the correct order
- neither person waiting unnecessarily
- Claude agents able to continue working independently without constantly asking what the other person is doing
IMPORTANT DIFFERENCE IN CAPACITY
Daniyal has the higher-capacity Claude plan.
Use that intentionally.
Prefer assigning Daniyal / Daniyal's Claude:
- architecture-sensitive work
- concurrency problems
- shared-state logic
- synchronization
- distributed-agent coordination
- security-sensitive code
- migrations touching core invariants
- integration work
- adversarial reviews
- cross-subsystem changes
- tasks with large context requirements
- tasks that block multiple other tasks
Prefer assigning Vihan / Vihan's Claude:
- well-defined isolated features
- isolated CLI work
- contained server endpoints
- isolated adapter improvements
- benchmark additions
- tests
- demos
- documentation
- developer tooling
- individual roadmap items that can be implemented behind a stable interface
This does NOT mean Vihan only gets easy work. It means we should use the higher-capacity agent where reasoning/context provides the most leverage.
FIRST: BUILD A DEPENDENCY GRAPH
From the remaining roadmap, identify every meaningful unfinished MVP task.
For each task, determine:
- what it depends on
- what depends on it
- which files/packages it touches
- whether it changes shared interfaces
- whether it requires migrations
- whether it can be completed independently
- whether another task can safely happen at the same time
Identify the critical path.
Do not just split the remaining tasks 50/50.
Split them to minimize BLOCKING TIME.
THEN CREATE TWO WORKSTREAMS
Design:
WORKSTREAM A — Daniyal
Give Daniyal a sequence of tasks that can mostly be worked through without touching Vihan's owned files.
WORKSTREAM B — Vihan
Give Vihan another sequence of tasks that can mostly be worked through without touching Daniyal's owned files.
Prefer subsystem boundaries over arbitrary task boundaries.
For example, if one person owns a server subsystem, avoid having the other modify the same subsystem unless necessary.
Explicitly list:
- owned directories/files
- files they MAY edit
- files they should NOT edit
- shared files that require coordination
SHARED FILE POLICY
Identify high-conflict files such as:
- central config
- shared protocol/type definitions
- migrations
- package manifests
- HANDOFF.md
- PLAN.md
- coordination docs
- central daemon/server entrypoints
For each shared file, assign ONE temporary owner.
If both workstreams require a shared interface change:
1. interface owner makes the smallest interface PR first
2. merge it
3. both branches rebase/pull
4. continue implementation independently
Do not allow both agents to independently redesign the same interface.
GIT WORKFLOW
Design a concrete Git workflow for us.
I expect something roughly like:
main
→ daniyal/<task-name>
→ vihan/<task-name>
Each task should normally get its own branch.
Avoid giant long-lived branches.
Every branch should:
- branch from recent main
- contain one logical piece of work
- include tests
- pass relevant checks
- become a PR
- merge back quickly
Define when to:
- merge
- rebase
- update from main
- abandon/recreate a branch
Tell us whether we should prefer merge commits, squash merge, or rebase merge for this repo and WHY.
MERGE CADENCE
I want us integrating continuously instead of waiting until one person's entire workstream is done.
Create explicit integration checkpoints.
Example idea:
Wave 1:
Daniyal: A1
Vihan: B1
When either finishes, PR it immediately.
After BOTH Wave 1 PRs are merged:
both developers update from main.
Wave 2:
A2 + B2 run simultaneously.
Continue like that.
However, if A2 does not depend on B1, Daniyal should NOT wait for B1.
Build the waves according to the actual dependency graph.
MAIN MUST ALWAYS STAY GREEN
No direct development on main.
Before merging any PR:
- typecheck
- unit tests
- relevant integration tests
- relevant demo/benchmark
Use the existing project test commands from HANDOFF rather than inventing new ones.
If a change touches sync, land, read capture, task claims, provider security, or another critical subsystem, require the relevant targeted test plus the normal suite.
If possible, recommend GitHub branch protection / CI requirements that make accidental breakage difficult.
CROSS-STREAM CONTRACTS
If Daniyal and Vihan need to build two sides of the same feature:
define the interface FIRST.
Example:
server contract merged first
then:
Daniyal → daemon implementation
Vihan → CLI / benchmark / tests
both work independently against the merged contract.
Use this pattern wherever possible.
COORDINATION
We should not need to message each other every 10 minutes.
Propose a lightweight source-of-truth for active work.
Ideally something like:
docs/coordination.md
with:
ACTIVE

Daniyal
branch:
task:
owned files:
depends on:
status:

Vihan
branch:
task:
owned files:
depends on:
status:

READY TO MERGE

BLOCKED

RECENTLY MERGED

Decide whether this existing file is appropriate or whether the repo already has something better.
Keep it minimal.
HANDOFF BETWEEN CLAUDE AGENTS
Both Claude instances should be able to understand what the other one has done without having their entire conversation history.
Define what every merged PR must leave behind.
At minimum:
- meaningful commit/PR description
- tests run
- architectural decision if one changed
- new config/env vars
- migrations
- anything the other workstream must know
Avoid both agents constantly rewriting HANDOFF.md.
Decide who owns HANDOFF.md during this parallel stretch and when it should be updated.
INTEGRATION OWNER
Unless you find a better reason otherwise, make Daniyal the integration owner because he has the higher-capacity Claude plan.
Integration owner responsibilities:
- review cross-subsystem PRs
- resolve architecture disagreements
- handle difficult merge conflicts
- run final combined validation
- prevent incompatible assumptions between workstreams
- keep the critical path moving
Vihan should NOT have to wait for Daniyal's review for every tiny isolated PR if automated checks are green and the change doesn't touch a shared contract.
Design a rule for which PRs require integration-owner review.
VERY IMPORTANT: AVOID FALSE PARALLELISM
Do not assign:
Daniyal → implement subsystem X
Vihan → refactor subsystem X
at the same time.
That technically gives us two tasks but guarantees merge conflicts.
Optimize for independent file ownership.
OUTPUT
Give me a concrete execution plan, not generic Git advice.
I want:
1. Current state
Concise summary of what is already finished and what remains before MVP.
2. Critical path
Exact remaining dependency chain.
3. Daniyal workstream
Task A1, A2, A3...
For each:
- scope
- owned files/directories
- dependencies
- tests
- merge point
4. Vihan workstream
Task B1, B2, B3...
Same information.
5. Parallel execution timeline
Show which tasks happen simultaneously.
Example:
TIME →

Daniyal: A1 ───── A2 ─────── A3
               │       │
MAIN:       merge A1 merge B1 merge A2 ...
               │       │
Vihan:   B1 ─────── B2 ───── B3

Use the ACTUAL tasks from this repo.
6. Merge order
Exact expected PR/merge sequence and which merges are dependency-sensitive.
7. File ownership matrix
Something like:
Area	Daniyal	Vihan	Shared


based on the actual code.
8. Git commands/workflow
Give us the exact workflow each person should follow when starting a task, updating from main, and submitting the PR.
9. Integration rules
What must be green before merge and who reviews what.
10. Next action
End by telling me EXACTLY:
What Daniyal should tell his Claude to start working on right now
and
What Vihan should tell his Claude to start working on right now.
Do NOT implement anything yet.
This task is planning only.
I want to approve the parallelization plan before either agent begins the next major chunk.
````

**First correction** (sent when the first plan was presented for approval):

````text
vihaans name is spelt vihaan not vihan, fix for any inconsistentcies
````

**Second correction** (sent when the corrected plan was presented for approval):

````text
The plan is approved in principle, with these changes:
1. Daniyal, not Vihaan, owns/co-ordinates B11 counted A/B execution because Vihaan authors the hidden checks.
2. Remove the total merge-order sequence. Any PR may merge immediately when its explicit dependencies are satisfied and CI/review requirements are green.
3. Reduce A0 to the minimum contracts/ownership/decisions needed for parallel work. GitHub issue creation and nonessential doc cleanup must not block coding.
4. Distinguish “functional MVP” from “formal 0B validation complete.” Functional MVP happens before the 30-run A/B study; the study remains the formal 0B gate.
5. Split B9 into B9a runner/recorder infrastructure and B9b baseline integration.
6. Split A5 into A5a adapter/hook delivery interface and A5b Stop-gate/escalation behavior.
7. Treat CI latency as a development metric. Keep full macOS required only if its runtime is reasonable; otherwise retain fast required checks and run full macOS at critical integration points/nightly.
Update the dependency graph, timeline, workstreams and next-action prompts accordingly. Do not implement yet; return the revised plan for final approval.
````

**Approval:** the user then approved revision 2 of the plan, which made all seven changes, through the plan-approval control.
