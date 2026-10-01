# S4: Owner's approval, remaining decisions and Phase 0A go-ahead (raw record)

> **Status:** Raw source record. **Do not edit.**
> - The newest source. Where S1–S4 conflict, S4 wins.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan. The answers are recorded there as D-55 to D-59.
>
> **Provenance:**
> - The owner wrote this on 2026-10-01 after reading the final planning report.
> - Verbatim, except that curly quotes and apostrophes are normalized to straight ones.
> - Kept in a text block so the owner's formatting is preserved exactly.

````text
This looks good. I'm approving this as the initial source-of-truth architecture.
Go ahead and make the initial commit of the planning workspace.
For the remaining decisions:

* Use TypeScript for the implementation.
* Use API keys for the Phase 0 experiments. Do not depend on consumer subscription authentication for the prototype.
* I approve the proposed A/B pass bar for now. Keep it explicitly versioned so we can revise it based on what we learn, but do not weaken it after seeing results just to make the harness pass.
* For the A/B repo, create a dedicated realistic benchmark repo designed for the experiment. It should be small enough to run repeatedly but realistic enough to expose actual multi-agent coordination problems. Plant scenarios involving:
   * an API contract change;
   * a shared type/interface change;
   * a database/schema change;
   * two tasks that look different but cause duplicate work;
   * one control scenario with genuinely independent tasks.

After we validate on that controlled repo, we'll validate against a real existing project as a separate test.
Commit the documentation/planning workspace first.
Then move to Phase 0A only.
Start with the vendor/runtime spike before building the actual harness architecture. I want the spike to empirically verify the assumptions that could break the design:

1. Can `harnessd` launch and supervise two independent Claude sessions programmatically?
2. Can we inject a message into a running session at a predictable safe point?
3. Can we capture edits reliably?
4. What read operations can we actually observe?
5. Can we prevent the agent from writing outside its assigned worktree?
6. Can we prevent repo-provided hooks/MCP/config from gaining unintended execution?
7. Can we resume a session after stopping the process?
8. Can two sessions run concurrently without interfering with each other's config, ports, Git state or credentials?
9. What information can the adapter reliably expose about session state?
10. What fails open versus fails closed?

Treat this as a throwaway experimental spike. Do not try to make the spike production-quality.
Document each result as:
VERIFIED
CONTRADICTED
PARTIAL
UNVERIFIED
with the exact vendor/runtime version tested.
If a core assumption fails, update the architecture rather than hacking around it just to preserve the existing plan.
Once the spike is complete, report the results and any architectural changes it implies before proceeding deeper into Phase 0A.
Keep the larger vision intact. We're now moving from planning into empirical validation.
````
