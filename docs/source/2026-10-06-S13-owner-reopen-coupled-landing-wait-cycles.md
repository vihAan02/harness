# S13: The owner approves task reopen (D-107) and wait-cycle refusal (D-108) for 0B, and picks the A/B's rule for coupled changes (raw record)

> **Status:** Raw source record. **Do not edit.**
> - The newest source. Where S1–S13 conflict, S13 wins.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan. Recorded there as D-122, D-123 and D-124.
>
> **Provenance:** owner Vihaan (GitHub `vihAan02`), in his Claude Code session (stream B) on 2026-10-06, after #36 (B9a) passed CI. Claude asked three questions through the session's multiple-choice question control. Vihaan picked one option for each and wrote no text of his own.
> - **Claude's text:** the questions and the option descriptions below.
> - **Vihaan's decision:** the selection under each question.
>
> The three questions are the ones stream A's overnight handoff left for the owners (HANDOFF.md on PR #56, "Owner decisions needed before counted A/B runs"). Under D-85 an owner gate needs the approval of either owner.

**The context Claude gave before asking:**

````text
CI on #36 is still running. In the meantime, here are the decisions that only you or Daniyal can make. All three shape §9's playbook (B10, #59), so I can't finish B10 without them. For context: a real SC-1 rehearsal (2026-10-05) hit all three. T-1's land failed type-checking because the change spans both tasks. Under D-96 the agent's session was over, so it couldn't be asked to fix it. And the two agents then waited on each other until the 600 s timeout, twice.
````

**Question 1, as asked:**

````text
D-107: when a harness-arm land fails, how does the coordinator get it fixed? (§9 says 'ask the agent to fix it', which today works only in the baseline, whose terminal stays open.)

- Approve D-107 (Recommended): `harness task reopen T-n --text <msg>` sends a done task back to its agent: a fresh session on its branch, opening with your message. Counts as M5, like the baseline's message. Built on daniyal/task-reopen (+177 lines over 11 files); it still needs its own PR and review. Both arms then follow the same playbook.
- Decline: no fix-ups: Neither arm sends a failed integration back. The run continues with whatever is integrated, and main is graded as it stands. Symmetric, with no new feature, but the baseline becomes less realistic, since a real human would ask.
- Decline: fix by hand: Daniyal's stated alternative: the coordinator fixes failed integrations himself, in both arms. This breaks §9's 'never write code' rule in both arms and puts the coordinator's skill into the results.
````

**Vihaan's selection:** `Approve D-107 (Recommended)`

**Question 2, as asked:**

````text
Coupled changes (SC-1 to SC-3): a change can span both tasks, so neither task can land alone through a test-gated land. What should the playbook do, in both arms?

- Tests first, untested on failure (Recommended): Integrate each task with tests. If the FIRST integration fails, it counts for M9a, then it's integrated with --no-tests (`harness land --no-tests` exists; the baseline's `merge` gets the same flag). The second task must land green. It's mechanical, needs no judgment from the coordinator, and keeps M9a meaningful.
- First always untested: In both arms, the first task to finish is integrated without tests and the second with tests, as the original baseline design had it ('merge both, then run tests'). It's simplest, but M9a then measures only the second integration in those scenarios.
- Build 'land together': A product feature that lands two tasks as one unit. It pulls new work into 0B and delays the counted runs. Not recommended now.
````

**Vihaan's selection:** `Tests first, untested on failure (Recommended)`

**Question 3, as asked:**

````text
D-108 (PR #63): refuse a task wait_for that would close a wait cycle, already in 0B? D-27 and D-95 defer cycle detection to Phase 1, with timeouts as the backstop.

- Approve for 0B (Recommended): Merge #63 (59 lines, server only). The agent's wait is refused with 'finish your part and say what the other task needs'. It pulls the simplest part of Phase 1's cycle detection forward, because the rehearsal lost 10 of its 30 minutes to a mutual wait.
- Keep it in Phase 1: Close #63. Timeouts stay the backstop, and any mutual wait in a counted run counts against the harness arm, as the design stands.
````

**Vihaan's selection:** `Approve for 0B (Recommended)`
