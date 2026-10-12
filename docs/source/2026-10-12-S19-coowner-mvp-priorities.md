# S19: The co-owner sets the MVP's priorities after the UI dogfood: commit it, device keys everywhere, then the real two-Mac test (raw record)

> **Status:** Raw source record. **Do not edit.**
> - The newest source. Where S1–S19 conflict, S19 wins, within the scope it states. It doesn't change a D-ID; it sets the order of work and two calls below.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan.
>
> **Provenance:** co-owner Daniyal Mughal (GitHub `DaniyalMughal1`, D-85), in his Claude Code session (stream A) on 2026-10-12.
> - **Earlier the same day, in the same session:** "resume, ive upped the api limit" (the OpenRouter key's own limit, now $4). Asked whether harnessd's day cap on the dogfood device could rise from $0.25, he answered "just change the cap", and it went to $1.00 for that device only (HANDOFF, 2026-10-12).
> - **Daniyal's text:** the instruction below, pasted as one message.
> - **Claude's questions:** two, through the session's multiple-choice question control. Daniyal picked one option each and wrote no text of his own.
> - **One redaction:** another project's database names, in question 2, are withheld because this repository is public.

**Daniyal's instruction, verbatim:**

````text
We've finished the six UI tasks and verified the exercise environment. Now we need to get Harness into a fully working, real-world MVP.
Read the latest HANDOFF.md and MORNING.md, inspect the repository's current state, and continue from the actual implementation.
Priority 1: Commit and prepare the completed UI and backend work for review. Resolve outstanding PR dependencies and finish PostgreSQL hardening.
Priority 2: Get device-key authentication working in the real dogfood environment so every UI action works, including cross-device approvals and integration.
Priority 3: Prepare a real end-to-end test between my Mac and Vihan's Mac, each running an AI coding agent. Verify task assignment, concurrent execution, file conflict detection, approvals, PR creation, merging, and reconnect recovery.
Reuse everything already implemented. Don't rebuild the UI or introduce unnecessary features.
Keep the interface minimal. Prioritize reliability, security, and speed.
Run tests after significant changes, stay within the configured spending limits, and don't bypass review requirements.
Only declare the MVP ready when two real machines can successfully collaborate on the same project through Harness.
Move quickly, use parallel agents where safe, and report only genuine blockers or decisions that require my input.
````

**Question 1, as asked:** "Merging this session: several PRs (re-cuts of Vihaan's setup/doctor/CLI-signing and install/pg-harden work, plus the UI) touch his files and need his review under AGENTS.md. How should I handle merges?"
- Review-gated (Recommended): I merge, one PR at a time and pinned to its head, only PRs the rules let merge on green (e.g. #133 PA4c). PRs needing Vihaan's review wait for him. The two-Mac test runs from a pushed candidate branch SHA, so his reviews don't block it.
- S18 rule again: Like 10-10: I merge green PRs from both streams in order and Vihaan reviews afterwards. Fastest to main, but it skips review first.
- Stop at ready: I push, open and verify everything, and you or Vihaan press merge on each PR.

**Daniyal's selection:** `Review-gated (Recommended)`

**Question 2, as asked:** "Postgres hardening on this Mac: 5433 holds only Harness's databases. 5432 holds another project's ([database names withheld in this public record]). Agents already get no loopback (ports_per_agent = 0), and the pilot coordinator gets its own socket-only cluster. What should I harden?"
- 5433 only (Recommended): Run the fixed pg-harden.sh on 5433: a scram password stored in ~/.pgpass, which agents can't read. Harness tests keep working through ~/.pgpass. 5432 stays as it is and is stopped during real two-Mac runs.
- Both clusters: Harden 5433 and 5432. The [other] project breaks if any of its clients don't read ~/.pgpass (Prisma, for example, doesn't).
- Neither, script only: Finish and verify the script (on a throwaway cluster) and its PR, then stop 5432 and 5433 during real runs. Your dev clusters stay unchanged.

**Daniyal's selection:** `5433 only (Recommended)`
