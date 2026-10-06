# S14: The co-owner declares the functional MVP, with the real-model run's scope stated (raw record)

> **Status:** Raw source record. **Do not edit.**
> - The newest source. Where S1–S14 conflict, S14 wins.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan. Recorded there as D-109.
>
> **Provenance:** co-owner Daniyal Mughal (GitHub `DaniyalMughal1`), in his Claude Code session (stream A) on 2026-10-06, after the A8 run on `main` @ `ab9eba8`. Claude asked one question through the session's multiple-choice question control. Daniyal picked one option and wrote no text of his own.
> - **Claude's text:** the question and the option descriptions below.
> - **Daniyal's decision:** the selection under the question.
>
> Under D-85 an owner gate needs the approval of either owner. The definition the question refers to is Milestone 1 in the workboard (issue #4, §1).

**Question, as asked:**

````text
A8 passed on main @ ab9eba8: EC2 9/9 three times, check 308/307/0/1, both demos, the provider check, a real demo:0b ($0.022), a real SC-0 harness-arm rehearsal ($0.021), and CI green. But the real-model runs didn't touch leases or wait_for (no lease.* or wait.* events). Those are covered only with the scripted model (the real CLI). The workboard's Milestone 1 lists them for the real run; the brief only asks for the real demo:0b. How should I declare it?

- Declare now, scope stated (Recommended): D-109 declares the functional MVP and says exactly which parts ran on a real model and which only on the scripted one. The B11 dry runs of both arms (real models, before the freeze) will exercise leases and wait_for with real agents anyway. I open the A8 PR now.
- One more real run first: Before declaring, I run a real SC-1 harness-arm rehearsal (cap 20 min, under $0.25), where agents tend to use wait_for. There's no guarantee they take leases. Without D-108 on main, a mutual wait could run to the 600 s timeout. Then D-109 reports what it showed.
- Hold until D-107/D-108 land: Don't declare yet. Merge reopen and wait-cycle refusal first, then run a fuller real rehearsal and declare after.
````

**Daniyal's selection:** `Declare now, scope stated (Recommended)`

**What Claude found next, and put to Daniyal as a second question:** the first question's "didn't touch ... wait_for" was wrong for one run.
- The real `demo:0b`'s frontend agent had called `wait_for`.
- A second real `demo:0b`, kept for inspection, recorded two `wait.started` and two `wait.resolved` events, and a notice delivered between tools.
- What the real-model runs on Shelf didn't exercise was leases and the Stop gate.

**Question 2, as asked:**

````text
Correction to what I asked before: a second real demo:0b (kept for inspection) showed wait_for working with a real model (2 waits, started and resolved) and a notice delivered between tools. What the real-model runs on Shelf did NOT exercise is leases and the Stop gate (no lease events; the Stop-hook delivery ran with a real model only in the provider check, which runs outside Shelf). Both are covered with the real pinned CLI and the scripted model: T-2 and the leases integration test; the adapter's Stop-gate test. Does your 'declare now, scope stated' still stand with this corrected scope?

- Yes, declare with this scope (Recommended): D-109 and S14 record the corrected scope: leases and the Stop gate on Shelf are covered by the real CLI with the scripted model, and by the B11 real-model dry runs before the freeze. I open the A8 PR.
- Run one more real check first: Before declaring, I try a real run that forces a Stop-gate hold and a lease, e.g. a real SC-1 harness-arm rehearsal (under $0.25). There's no guarantee the model takes a lease.
- Hold the declaration: Don't declare yet. Merge D-107/D-108 and wait for the B11 real dry runs, then declare on those.
````

**Daniyal's selection:** `Yes, declare with this scope (Recommended)`
