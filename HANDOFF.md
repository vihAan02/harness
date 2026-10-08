# Handoff: harness, Phase 0B (state as of 2026-10-06; the pilot sprint from 2026-10-08)

## Update (2026-10-08): the two-Mac pilot sprint (D-110). Read this first
- **Who and when:** written by Daniyal's Claude (stream A), 2026-10-08, with PC0.
- **What changed:** the owner put a two-Mac private pilot and its thin UI ahead of the counted A/B (S17, D-110). The design is D-111 to D-119. The A/B gate is not passed; the `ab-v1` freeze and counted runs come after the pilot candidate, and the open A/B PRs (#80, #83, #84, #65) wait unchanged.
- **Where the work is:** the workboard (#4) and the `P…` issues: cards, dependencies, acceptance tests, owners and an ops log per card. AGENTS.md's "Pilot sprint" section has the added ownership rows and rules; product agents read the block at the top of AGENTS.md.
- **The baseline (`main` @ `818ccef`, Node 24.21.0, Postgres 18 on 5433, this Mac):** `npm run check` 360 tests, 359 pass, 0 fail, 1 skipped (1 min 47 s); `npm run demo` and `npm run demo:0b` pass (scripted).
- **This file is updated at the sprint's checkpoints** (T+24, T+48, T+72). The sections below describe 0B before the sprint.


## Update (2026-10-06): the functional MVP is declared (D-109); the A/B freeze is next. Read this first
- **Who and when:** written by Daniyal's Claude (stream A) at about 23:15 UTC on 2026-10-06.
- **Precedence:** this section supersedes the older ones where they disagree.
- **Mirrored:** the workboard (#4) has the same status in a comment.

### Where things are
- **`main` is at `8f06bd6` (#78).** 21 PRs merged on 2026-10-06 (table below), including every piece of the functional MVP and its declaration (#77).
- **CI runs again:** the repo is public.
  - Every merged PR's head ran the required checks (`guard`, `unit-linux`, `full-macos`) with steps, and passed.
  - On `main`, the run after #66 (`2e6fc33`) failed `full-macos` with the T-2 teardown flake, which #67 fixed. Every later run on `main` passed.
- **The rules for CI, rebases and flakes are in AGENTS.md**, under "CI capacity and flakes" (#69):
  - one PR in flight;
  - rebase only the PR that's next;
  - a zero-step job failure is infrastructure: stop and tell the owners;
  - a flake gets a fix that states its cause;
  - tests wait for exactly what they assert;
  - handoff records are exact.
- **How PRs merge:**
  - **Stream A's** merge with GitHub auto-merge (squash). It's turned on once the PR is rebased onto `main`, verified locally (when the tree hash matches a tree already verified, the push goes out without re-running), and reviewed where AGENTS.md asks (Daniyal's choice, 2026-10-06).
  - **Stream B's** are merged by Vihaan's side.

### The functional MVP (D-109, S14; #77)
**What ran, on `main` @ `ab9eba8`:**
- EC2 (T-1, T-1b, T-2): 9/9, three times.
- `npm run check`: 308 tests, 307 pass, 0 fail, 1 skipped.
- Both scripted demos: pass.
- The provider check: all three stages pass.
- The real `demo:0b`, twice, on OpenRouter pinned to Parasail (D-104): $0.022 and $0.027. The kept run recorded two waits and a delivery between tools.
- A real SC-0 harness-arm rehearsal: $0.021.
- CI: green.

**What a real model didn't exercise on Shelf:** leases and the Stop gate. Daniyal accepted the real-CLI, scripted-model coverage for those (S14). The B11 real dry runs come before the freeze.

The full record is in D-109 and #77.

### Merged on 2026-10-06 (UTC, squash SHA)
| Time | PR | Squash | What |
|---|---|---|---|
| 05:50 | #66 | `2e6fc33` | CI: the nightly latency job (Vihaan) |
| 14:30 | #67 | `4ae0b26` | T-2 waits for harnessd's land before teardown (Vihaan) |
| 16:06 | #36 | `64808ac` | B9a: the A/B runner and recorder, harness arm (Vihaan) |
| 17:25 | #68 | `82a2655` | S13: D-122 to D-124, the owner's decisions on reopen, wait cycles and coupled landing (Vihaan) |
| 17:32 | #51 | `eebc9d3` | D-97 settled; a hard claim's notice says the land step enforces it |
| 17:50 | #44 | `e1020fb` | A7: the A/B baseline launch (D-102) |
| 17:57 | #60 | `94e8b58` | waits.integration: wait for the delivery record |
| 18:04 | #72 | `38eff66` | sync-land: two races in the recovery test |
| 18:18 | #73 | `85bcfe4` | harnessd's stop finishes the land in flight (the land-teardown race) |
| 18:26 | #69 | `2a19322` | AGENTS.md: CI capacity and flakes |
| 18:54 | #54 | `64e521c` | B3: T-1b |
| 19:04 | #58 | `bd067bb` | B2: real-model results (U-1 and U-2 verified, U-3 measured) |
| 19:11 | #53 | `42d047b` | OpenRouter as the real-model provider (D-104) |
| 19:24 | #55 | `536f73e` | B7: `contract_request` and `task_blocked` (D-105) |
| 19:30 | #57 | `6cb7386` | D-106: a task's work reaches a waiting agent through its land |
| 19:37 | #62 | `ab9eba8` | Leases judged as the lease commands judge them (D-97) |
| 20:55 | #77 | `9bb2b6f` | A8: the functional MVP is declared (D-109, S14) |
| 21:03 | #61 | `d56166a` | The A/B contract (`scripts/ab/summary.ts`) |
| 21:16 | #64 | `97f3fcd` | A9: the scorer |
| 21:22 | #63 | `ef81649` | D-108: a wait that would close a cycle is refused (approved as D-123) |
| 21:38 | #78 | `8f06bd6` | adapters session test: wait for the killed process to go |

### What's open, and who it waits on
| Item | State | Waits on |
|---|---|---|
| **#75**, the waits `immediate` flag (fixes #70, a CI flake and a product bug) | Green when opened. Conflicts with `main` now (#63 also changed `waits.ts`): needs a rebase at its turn | **Vihaan's review** (an additive event field) |
| **#76**, D-107 task reopen (approved as D-122) | Open. Conflicts with `main` now: needs a rebase at its turn | **Vihaan's review**: it touches his `tasks.ts`, the CLI and `metrics.ts` |
| **#65**, the A9 judge | Approved. Restacked with the §9 rubric change (SC-4 has no M6 coupling) | **Vihaan's choice** between option 1 and option 2 (#65's comments): option 1 adds `done_at` to `RunSummary` (#61) and both runners, so the judge applies "caught before its task finished" exactly; option 2 keeps "before it was integrated" and lists it as an interpretation. Then auto-merge |
| **#59**, B10 (validation.md §9) | Vihaan signed `e2acb96`. **Daniyal didn't, and asked for changes** (comment on #59, 2026-10-06) | **Vihaan revises §9;** both owners sign the revision once. The four blockers are listed below the table |
| **B9b**, baseline integration | Branch `daniyal/b9b-baseline`, no PR | **Vihaan** restacks it and opens the PR. The §9 review lists its gaps: `surfaced` still counts a sync, there's no `merge --no-tests`, nothing builds the `.first` tree, and the cap defaults to 60 min |
| **B8**, status | Branch `daniyal/b8-status`, no PR | **Vihaan** |
| **#74**, harnessd stop and recovery follow-ups | Issue | Stream A, not blocking |
| **The `ab-v1` freeze** | | B9b, #59 signed by both owners, and #76 (D-107). D-108 is in (#63) |
| **A10, the counted runs** | | The freeze. Daniyal coordinates and never reads the hidden checks |

**#59's four blockers:**
1. P1's "surfaced" counts `claim_conflict`;
2. M3 drops the harness arm's sync conflicts;
3. the void rule re-draws crashes only the harness arm can have;
4. the coordinator's limits and the audit cover the baseline only.

### Owner decisions on 2026-10-06
- **Vihaan (S13, #68):**
  - D-122 approves D-107 (reopen);
  - D-123 approves D-108 for 0B;
  - D-124 sets the coupled-landing rule for both arms.
- **Daniyal:**
  - **D-109, S14:** declared the functional MVP, scope stated.
  - **Merging:** stream A's PRs merge by auto-merge.
  - **#59:** didn't sign §9 at `e2acb96` and asked for changes.
  - **The HANDOFF:** it merges now, at the milestone, rather than last.
- **Still pending:**
  - both owners sign the revised §9;
  - Vihaan's `done_at` choice on #65.

### Environment notes
- **Where to work:** from `~/code/harness-ai`, the clone outside iCloud, with worktrees under `~/code/wt/`. The Desktop clone is in iCloud, so it's never used for runs.
- **"Could not resolve host: github.com" in a demo** meant the internet had dropped (twice on 2026-10-06), not a code problem. Check with `git ls-remote https://github.com/vihAan02/harness-bench.git HEAD`, then re-run.
- **Real-CLI integration tests time out on a saturated machine.** On 2026-10-06, another project's video renders pushed the load average to 50 to 77. Several real-CLI tests then hit their 30 s waits, for example `test/claims.integration.test.ts:33`. They passed when re-run alone, and CI runners are unaffected. Re-run alone before suspecting code, and check `uptime`.
- **The OpenRouter key** is in `~/.config/harness/keys.env`. Source it in the same command, and never print it.

### Stream A's next steps
1. As Vihaan answers, merge #75, #76 and #65.
2. Follow §9's revision in #64 (`PASS_BAR`, M3) and #65 (the rubric).
3. Tag `ab-v1` once B9b and the signed #59 are in.
4. Coordinate A10.
5. The #74 follow-ups when there's room.

## Overnight update (2026-10-05, S12): stream A ran both streams, then handed stream B back (historical)
Superseded by the 2026-10-06 section above where they disagree. Its CI paragraph was corrected on 2026-10-06. The same text is on the workboard: https://github.com/vihAan02/harness/issues/4#issuecomment-5988673344

**For Vihaan, and any agent working on stream B: read this before you touch any stream B task.**
- **Written:** about 05:28 UTC on 2026-10-05, by Daniyal's Claude (stream A). **Corrected at about 06:00 UTC**, after a read-back check: the "behind" lines, the B8/B9b restack steps, what was validated, the new PRs #63 to #65, and the CI blocker.
- **Why stream A was on stream B:** under S12, Daniyal's instruction for that night (`docs/source/2026-10-05-S12-coowner-overnight-both-streams.md` on PR #59), stream A temporarily ran both workstreams while Vihaan's Claude was unavailable.
- **The takeover has STOPPED, at Daniyal's request.** Every stream B task goes back to Vihaan as of now: B8, B9b, B10 and B11. Stream A no longer edits stream B files and won't open stream B PRs. It keeps its own PRs (stream A) moving and rebased.

### `main` that night, and why nothing could merge
- `main` is at `31a4e13`. Tonight **#37 (B5)** and **#38 (B6)** merged, both by Vihaan.
- **Every open PR except #59 is already up to date with `31a4e13`.** Stream A rebased its PRs at 05:28 UTC, and Vihaan updated #36 himself at 05:27 (head `9513713`, "B9a: review fixes").
- **The blocker was CI, not rebases (corrected 2026-10-06 from the run history).**
  - **When it began:** about 05:22 UTC on 2026-10-05.
    - The last job to start with steps started at 05:21:59 (run 37267268571, `daniyal/lease-followups`).
    - From 05:22:05, queued `full-macos` jobs failed with no steps.
    - The first run created with no steps at all was at 05:23:05 (`main`, 37267542206; it was re-run with steps on 2026-10-06).
    - "About 05:28", as first written, was wrong.
  - **What happened:** no GitHub Actions job started. The repo had been made private, and each job's annotation read "The job was not started because recent account payments have failed or your spending limit needs to be increased". The `main` ruleset requires `guard`, `unit-linux` and `full-macos`, so nothing could merge.
  - **How it ended:** the repo was made public again.
    - The nightly at 14:46 UTC on 2026-10-05 still had no steps.
    - The first jobs with steps again were a re-run of 37267542206 at 05:30 UTC on 2026-10-06.
    - The first new run with steps was at 05:44 (`vihaan/ci-fixes`).
  - **Meanwhile:** stream A ran `npm run check` locally for each PR and posted the results.

### Stream B tasks handed back to Vihaan: resume from these branches, don't redo the work

| Task | Issue | Where | State | What's left for Vihaan |
|---|---|---|---|---|
| **B8**, status: waits, blocked, capped Stop gate | #25 | branch `daniyal/b8-status` @ `848da99` (2 commits on top of local candidate `c3709fd`) | **Done**, no PR yet. It builds on #55 and #57's status and wait semantics | After #55 and #57 merge, take it onto **your own** branch (don't force-push `daniyal/*`): `git fetch origin && git switch -c vihaan/b8-status origin/daniyal/b8-status && git rebase --onto origin/main c3709fd && git push -u origin vihaan/b8-status`. Then open the PR as yours. Optional: fold `land.progress` |
| **B9b**, baseline integration | #27 | branch `daniyal/b9b-baseline` @ `3b9d6f5` (6 commits on top of `b94f9f7`, which is the local candidate `c3709fd` merged with #61 at `df55783`) | **Done**, no PR yet. Needs #36 (B9a), #44 (A7) and #61. It was built on top of exactly your B9a: `9513713` is your rebase of the same two commits (range-diff `=`). Its 6 commits apply cleanly onto `main` + #36 + #44 + #61: tsc is clean, and its tests plus the metrics tests pass 11/11 there | After those merge: `git fetch origin && git switch -c vihaan/b9b-baseline origin/daniyal/b9b-baseline && git rebase --onto origin/main b94f9f7`, run `node --test test/ab-baseline.integration.test.ts` and `npm run check`, then `git push -u origin vihaan/b9b-baseline` and open the PR |
| **B10**, the A/B protocol and parameters | #28 | **PR #59** (`validation.md` §9, D-121, S12's source record) | A proposal until both owners sign it (not a GitHub draft). It's the only PR still behind `main` | Review and edit it as yours. It depends on the owner decisions below (D-107, the coupled-landing rule) |
| **B11**, dry runs and grading | #29 | no branch; results below | Dry runs started. **Grading untouched**, and the hidden-checks repo was never read | All of grading, and more dry runs, per scenario |

Stream B tasks stream A did before tonight (S11, already PRs), waiting for Vihaan's review: **B2 #58**, **B3 (T-1b) #54**, **B7 #55**.

#### What B8 does (`daniyal/b8-status`)
- **`harness status` now shows:**
  - every open `wait_for`: who, waiting for what, since when, and when it times out. A wait on a task that's done but not landed says so, e.g. `agent/frontend (T-2) waits for T-1 to land (T-1 is done, not landed yet: harness land T-1)`;
  - a land line under each done task: not landed yet, landing, or failed with its reason;
  - a "Stop gate capped" section, from `stop_gate.capped` (D-100).
- **`view.ts`** folds `stop_gate.capped` (`stopGateCaps`, `cappedGates()`).
- **Tests:** `packages/daemon/test/view.test.ts` 7/7 (2 new tests, with a mutation check); `npm run demo` passes.
- **The PR description is drafted:** stream A has `pr-b8.md`. Ask Daniyal, or write your own.

#### What B9b does (`daniyal/b9b-baseline`)
- **`node scripts/ab/run.ts --arm baseline --scenario SC-n --phrasing n --real --provider openrouter`.** The baseline arm has no server and no harnessd:
  - a fresh clone; two worktrees and branches; the setup command run in each under harnessd's sandbox; a port block each;
  - two interactive Claude Code sessions from A7's launcher, each opening with its card: `--launch terminal` (two Terminal.app windows, the default), `print`, or `headless` (pseudo-terminals, for dry runs and rehearsals).
- **The coordinator's console:**
  - `merge <agent>` is the land step without fencing: commit, merge in an integration worktree, setup and tests under the land sandbox, move main only if green;
  - `sync <agent>` merges main into the agent's branch;
  - Enter toggles the M10 timer; `note`; `stop`. Both arms have the console.
- **What each run saves**, in both arms: `record/<run-id>/summary.json` (the `RunSummary` in #61), `diffs/<task>.patch`, `diffs/<task>.independent.patch` (up to the task's first sync, for M3), `diffs/main.patch` and `transcripts/<agent>.jsonl`.
- **Baseline measurements:** M5, M7, M5b and M8 come from the Claude Code transcripts. M8 is repriced through `sessionCost` with the same provider table as the harness arm.
- **Other changes:**
  - `harness metrics`: M3 counts conflicts at integration only; sync conflicts are a diagnostic (`lands.syncConflicts`); M9 is now M9a;
  - A7's launcher gains `--prompt-file` and `--session-id`.
- **Tests, and exactly what each covered:**
  - `test/ab-baseline.integration.test.ts`: 6 tests passed on the earlier B9b head `4ce069c`, including two real Claude Code CLIs in pseudo-terminals against the mock, with a negative control.
  - The 7th test (independent diffs) passed on its own at `3b9d6f5`. **The full file and `npm run check` haven't been re-run on `3b9d6f5` itself.**
  - `npm run check`: 309 tests, 308 pass, 1 skipped, on the B9b branch at `5c99aac`. Candidate 3 (313 tests, 312 pass, 1 skipped) contains B9b only up to `4ce069c`.
  - The commits after those runs: the port-range change, the M9a label, the contract update to `df55783` and independent diffs.
  - Dry runs of both arms on the scripted model, and the real SC-1 rehearsal pair, ran on the B9b of that time.

#### B11 dry runs tonight (results, not counted runs)

| Run | Arm | Result | Cost |
|---|---|---|---|
| SC-0 `--dry --auto-land` | baseline | integrated, 16 s | free |
| SC-1 `--dry --auto-land` | harness | integrated, 9 s | free |
| SC-1 phrasing 1, real model | harness | `land_failed`: T-1's land failed type-checking (`src/client/api.ts` still reads `.token`), which is the planted coupling. P1's surfaced was 1 of 1. The agents used `contract_request` and `answer` | $0.037 |
| SC-1 phrasing 1, real model | baseline | integrated in 120 s: backend merged green, frontend conflicted once, was synced, got a fix request, then merged green | $0.066 |
| SC-1 phrasing 2, real model, with the D-107 reopen | harness | **Mutual wait deadlock:** T-2 waited for T-1 to land while T-1 waited for T-2, until the 600 s timeout. Then each land failed type-checking alone, because the change spans both tasks. Both were reopened and started waiting on each other again. Stopped at the handback, after about 12 minutes | not recorded |

The model is `deepseek/deepseek-v4.1-flash` via OpenRouter, pinned to `parasail/fp8` (D-104).

### Stream A's own work tonight (Daniyal's files; stream A carries on)
- **#60:** fixes a race in `test/waits.integration.test.ts` (wait for the delivery record).
- **#61, the A/B contract** `scripts/ab/summary.ts`: `RunSummary`, `JudgeResult`, and **`Grades`, the format the scorer reads from Vihaan's hidden-check grading.** Vihaan, check that your grading can produce it.
  - Updated after review: whole-number counts; `surfaced ≤ planted`; `void` needs a reason; new `sync_conflicts`; independent diffs.
- **A9, the scorer (PR #64) and the judge (PR #65)**, both stacked on #61:
  - built, and they implement pass bar v1 (§5) and B10's §9 scoring rules;
  - an independent review found no blockers; its should-fix items are fixed in these PRs;
  - after #61 squash-merges, restack each with `git rebase --onto origin/main 1b9733c <branch>`;
  - judge: `anthropic/claude-sonnet-5.5` via OpenRouter, temperature 0. One smoke call cost $0.014.
- **#62:** the lease follow-ups from Vihaan's B5 review. The fencing check, `land.complete` and lease waits now judge leases as the lease commands do: a logged-expired lease is never current, and only current leases are released at a land. One commit on top of B5.
- **D-107, a proposal:** `harness task reopen <task> --text <msg>` sends a done, unlanded task back to its agent: a fresh session on its branch, opening with the human's message. It's on branch `daniyal/task-reopen` @ `315aaa5`, on top of `daniyal/candidate-overnight` @ `c201b9f`. Diff: https://github.com/vihAan02/harness/compare/daniyal/candidate-overnight...daniyal/task-reopen
- **D-108, draft PR #63** (`daniyal/wait-cycles`, one commit on `main`): refuse a `wait_for` on a task that would close a wait cycle. Needs an owner's decision, because D-27 defers cycle detection to Phase 1.
- **Rebases:** every Daniyal PR was rebased onto `main` after #37 merged (#57 needed a `protocol.md` conflict resolved), and again onto `31a4e13` after #38, at 05:28 UTC, all cleanly. #59 was left alone, because it's Vihaan's now.
- **The late-grant rule** ("renew at once a lease first seen late", D-97) is already in B6's LeaseKeeper, so no code is needed.

### Validation tonight
**Candidate 4: the functional MVP, as it will be on `main` once the PRs merge.** That's `main` @ `31a4e13` plus #51, #44, #60, #54, #53, #55, #57, #62, #36 and #58 (results also on the workboard).
- **EC2:** T-1, T-1b and T-2 passed 9/9 in all three runs.
- **`npm run check`:** 305 tests, 304 pass, 0 fail, 1 skipped.
- **Both scripted demos** pass.
- **The OpenRouter provider check** passes all 3 stages.
- **Real `demo:0b`:** S3 end to end with real agents, 4/4, 69.6 s, $0.027.

**Each open PR on its own:** a local `npm run check` on its head merged with `31a4e13` passed for all 14 (#36, #44, #51, #53, #54, #55, #57, #58, #60, #61, #62, #63, #64, #65), with 0 failures. Each PR has its numbers in a comment.

**Earlier, candidate 3:** `main` @ `741f3b5` plus that time's open PRs, B8, the lease follow-ups, and B9b as of `4ce069c`; branch `daniyal/candidate-overnight` @ `c201b9f`. These results came from it.
- **EC2:** T-1, T-1b and T-2 passed 9/9 in all three runs.
- **`npm run check`:** 313 tests, 312 pass, 0 fail, 1 skipped.
- **Demos:** `npm run demo` and `npm run demo:0b` both pass.

### Owner decisions needed before counted A/B runs (Daniyal and Vihaan)
**Decided on 2026-10-06:**
- **Items 1 to 3:** by Vihaan, as D-122 to D-124 (S13, #68).
- **Item 4, #59:** Vihaan signed; Daniyal asked for changes.

See the 2026-10-06 section.

1. **D-107 (reopen).**
   - **The problem:** a failed land leaves the task done with its agent's session over (D-96), so the playbook's "ask the agent to fix it" works only in the baseline, whose terminal is still open.
   - **Options:** approve D-107; or change the protocol so the coordinator fixes failed integrations by hand in both arms.
2. **Coupled changes.** In SC-1, and possibly SC-2 and SC-3, a change spans both tasks, so neither task can land alone through a test-gated land. The original design has the baseline human "merge both branches, then run tests".
   - **Options:** a playbook rule for both arms (integrate the first with `--no-tests`, the second with tests); or a "land together" feature.
3. **D-108 (wait-cycle detection) in 0B?** D-27 and D-95 defer it to Phase 1, "timeouts are the backstop". A real run lost 10 of its 30 minutes to two agents waiting on each other.
4. **B10 (#59):** both owners sign it. The A9 scorer's interpretations are listed in its PR.

### Merge order, once CI runs again (superseded)
**Status on 2026-10-06:**
- **Merged:** every PR listed here, plus #68, #69, #72, #73, #77 and #78.
- **Still open:** #59, #65, B9b, B8, D-107 (now #76) and this HANDOFF.

See the 2026-10-06 section.

1. #51
2. #44 (A7)
3. #60
4. #36 (B9a, Vihaan's)
5. #54 and #58
6. #53, then #55, then #57: stream A rebases each after the one before merges, because of PLAN.md D-ID conflicts
7. #62
8. #61, then #64 (scorer) and #65 (judge), and B9b (Vihaan)
9. #59 once both owners sign it
10. B8 after #55 and #57 (Vihaan)
11. #63 (D-108) and D-107, only if the owners approve them
12. #56 (HANDOFF) last

### Rules that still hold
- Stream A (Daniyal's side) never reads `vihAan02/harness-hidden-checks`.
- The OpenRouter key is never printed or committed.
- Squash merges only, nothing pushed to `main`, never force-push someone else's branch.
- **Real-model spend tonight:** about $0.16 that was measured (rehearsals $0.10, candidate 4's real runs about $0.04, judge calls $0.014), plus the stopped rehearsal.

## Update (2026-10-05, earlier that day): real models on OpenRouter, the MVP candidate passes
This was the current state earlier on 2026-10-05. The overnight update above supersedes it where they disagree.

### Where things are
- **The functional MVP is built, in PRs that are waiting to merge.**
  - A local candidate passed EC2 (T-1, T-1b and T-2) three times. That's `main` plus #51, #37/#38, #53, #54, #55 and #57.
  - It also passed `npm run check`, both scripted demos, and the S3 example with real agents on OpenRouter: `npm run check` 299 tests (298 pass, 1 skipped); `demo:0b --real` 4 of 4 in 86 s for $0.023. In that run the frontend agent used `request_contract`, and the backend answered it.
  - **The two-agent harness-arm rehearsal on Shelf,** with B9a's runner (#36) added to the candidate: `node scripts/ab/run.ts --scenario SC-0 --real --provider openrouter --phrasing 1 --auto-land`. It came out `integrated` in 32 s for $0.022: both tasks done and auto-landed, with Shelf's `npm run check` green in the land's sandbox.
  - What's left: merge the PRs, re-run the same on `main`, and declare it (A8).
- **Real models work through OpenRouter** (S11, D-104, F-113). The fixed model is `deepseek/deepseek-v4.1-flash`, served by Parasail at fp8.
  - DeepSeek's own endpoint is refused to this account by its OpenRouter privacy setting, which excludes providers that may train on paid inputs. The provider was changed, not the setting.
  - `node scripts/provider-check.ts --provider openrouter` passes all three stages: the endpoint and a tool call; a hardened Claude Code session; notices through the hooks, on a tool result and at the Stop gate.
- **The first real run found one product gap, now fixed in #57 (D-106).**
  - A task `wait_for` ended at `done`, before the land, and `report_done` went through while a landed change was still held.
  - Now a task wait ends at the land, the land is merged into the waiter's branch before it's told, and `report_done` waits for landed work.
  - With it, `demo:0b --real` meets all four S3 criteria (81 s, $0.018).
- **Q-18 is answered for this model** (#58): U-1 and U-2 verified (harmful compliance 0 of 3), U-3 measured. A7's baseline ran on it in a pseudo-terminal (#44).
- **Owner decision (2026-10-05):** an agent's `task_blocked` goes to the task's owner only (D-105).

### Merged into `main`
- **Stream A:** A0 to A6, AX, the D-97 currency fix (#50), the `server.close()` fix (#52), and earlier fixes (#40, #43, #46 to #49).
- **Stream B:** B1 (#31) and B4 (#34).
- `main` is at `741f3b5`, and CI is green.

### Open PRs, and what each waits for

| PR | What | Waits for |
|---|---|---|
| #51 | D-97 settled; the hard-claim footer | **A merge**: approved by Vihaan, CI green |
| #37 B5 | Leases (server, CLI, tools) | **A merge**: approved, CI green |
| #38 B6 | LeaseKeeper and T-2 | #37; then Vihaan restacks it onto `main` |
| #36 B9a | The A/B runner and recorder | **A merge**: approved, CI green |
| #44 A7 | The baseline launch | Approved by Vihaan; the real run is now done (D-102) |
| #53 | OpenRouter (D-104, F-111 to F-113) and the provider check | Vihaan's review |
| #54 B3 | T-1b | Vihaan's review |
| #55 B7 | Message kinds (D-105) | Vihaan's review |
| #57 | D-106, from the first real run | Vihaan's review (it changes the `wait.start` contract for tasks) |
| #58 B2 | The real-model results (Q-18) | Vihaan's review |
| #56 | This HANDOFF | After #53 |

- **Rebases after merges:**
  - #55 and #57 both edit the `wait_for` description and protocol.md's `wait.start` row. #53, #55, #57 and #44 all append D-IDs at the same marker in PLAN.md.
  - The `main` ruleset needs each PR up to date, so every merge means a rebase of the next. All of those are Daniyal's, and the conflicts are mechanical; the candidate merge resolved them the same way.
- **Not started (stream B):**
  - B8 (status for waits, the Stop gate and who waits for a land; issue #25);
  - B9b (baseline integration);
  - B10 (the playbook and A/B parameters, including the A/B model);
  - B11 (dry runs and grading).

### The OpenRouter key, and the real runs
- **Where the key is:** `~/.config/harness/keys.env` (chmod 600), sourced from `~/.zshrc`.
  - Non-interactive shells (an agent's Bash tool) don't read `~/.zshrc`. So `source ~/.config/harness/keys.env` in the command that needs it.
  - Never print it, and never put it in the repo or in `config.toml`.
- **The commands** (from a checkout outside iCloud):
  ```
  node scripts/provider-check.ts --provider openrouter
  npm run demo:0b -- --real --provider openrouter
  npm run demo -- --real --provider openrouter
  ```
- **e17:** see spike-0a.md §5, "Real-model results", for the `SPIKE_*` settings.
- **Costs so far:**
  - `demo:0b`: about $0.02 to $0.03 each;
  - the 0A demo: $0.04;
  - the provider check: about $0.01.

  Claude Code's prompt is served from cache after the first request.
- **What the real 0A demo shows:** it never lands tasks, so with D-106 an agent that waits for a peer's task runs to the wait's timeout (600 s). Its three overlap criteria need simultaneous edits, which real timing doesn't produce. Neither is a product fault (#58).

### Stream A follow-ups, after their dependencies merge
- **After #37:**
  - the fencing check and lease waits use the clock `lockLeases()` returns, and also require `expired_logged_at IS NULL`;
  - `land.complete` releases only current leases.
- **After #51:** D-97 gains "renew at once a lease first seen late". The code goes to stream B.
- **A9's `score.ts`:** subtract B9a's `runner_cancelled_lands` from M5c.
- **A human-driven U-5 baseline session**, with B9b.

## Previous update (2026-10-04): stream A's first wave

### How the work runs now
- **Two people in parallel (D-94):** Daniyal leads stream A and integration; Vihaan (`vihAan02`) leads stream B. AGENTS.md's "Parallel development (0B)" section has the file ownership table and the rules.
- **The workboard:**
  - the pinned "0B workboard" issue (#4), and one issue per task, labelled `stream:*` and `status:*`;
  - squash merges, gated on the required checks (`guard`, `unit-linux`, `full-macos`).
- **Start every session with:** `git fetch origin && git log --oneline origin/main -15`, `gh pr list -R vihAan02/harness`, and the `status:active` issues.

### Merged into `main` since 2026-10-03 (stream A)
- **A0 to A2:** the contracts and seams for stream B (D-94, D-97); approvals time out.
- **A3, read confinement (D-98):** three layers. T-1 passes.
- **A4 and A6, `wait_for` (D-95, D-101):** the agent ends its turn, and the outcome is pushed.
- **A5a and A5b (D-99, D-100):** high-priority notices ride tool results, and the Stop gate holds an agent while notices are unread. A capped gate is logged as `stop_gate.capped`.
- **A fix for a sync/diff deadlock** (#40). It hung about one run in three of `npm run demo:0b`.

**Every security-relevant PR had a multi-agent adversarial review before merging.** The findings and their fixes are in each PR and its D-ID.

### Open
- **A7** (#44), the A/B baseline launch (D-102). It waits for a run against a real model (Q-18) and B2's U-5 probe.
- **Stream B:** CI (merged), scenarios (#34), the runner (#36), leases (#37) and the LeaseKeeper with T-2 (#38), which are in Daniyal's review. Also #43: a one-word test change for Vihaan.
- **Next in stream A:**
  - **A8, the functional MVP:** needs B3, B6 and B7.
  - **A9, the scorer:** needs B10.
  - **A10, the counted runs:** after the `ab-v1` freeze.

### Environment notes
- Unchanged from the section below.
- **Still true:** run tests from a checkout outside iCloud.
- **Also, in an interactive Claude Code session** (as the A/B baseline uses): with an API key in the environment, the CLI asks whether to use it and defaults to *no*, then offers a subscription login (F-109). The baseline launcher seeds the answer.

## Previous update (2026-10-03, Daniyal's session): the first 0B stretch

### Where the work is
- **Branch:** `0b/stale-context` in `~/Desktop/harness-ai`, from `main` @ `1a94660`. **Pushed to GitHub on 2026-10-03 at Daniyal's request, as pull request [vihAan02/harness#1](https://github.com/vihAan02/harness/pull/1)** into `main`. `main` itself is unchanged until the PR is merged.
- **harness-bench:** cloned at `~/Desktop/harness-bench` (`main` @ `8c6ea60`), unchanged.
- **Commits on the branch,** oldest first:
  1. `e6340f3` S9 + D-86 to D-89: 0B approved (U-1 deferred), provider direction, Q-06 and Q-07 resolved.
  2. `526e10f` F-24 to F-29, F-58, F-72 to F-77, C-21: provider and gateway facts.
  3. `d173bad` configurable Anthropic-compatible model endpoints (D-87, D-90).
  4. `8038170` demo and spike take a provider.
  5. `183bea7` provider docs, TH-21, D-90, probe results, F-78.
  6. `3816297` harnessd's commits ignore `commit.gpgsign`.
  7. `407f47e` daemon integration test: stop daemons on failure, ignore presence flaps.
  8. `0f697ea` server: read sets, stale-context notices, land and sync.
  9. `9acb7e3` harnessd: read capture, sync at turn end, the land step; the S3 test.
  10. `e5f5317` `npm run demo:0b`.
  11. `dc676ca` docs: D-91 to D-93, S3 exit met.
  12. `78ccd01` metrics: M1 until landed, M3, M9, notice diagnostics.
  13. `62257c3` server: 0B review fixes (stale reads after a land, one lock order, cancel/complete, `all_changed`).
  14. `c0ecd88` read capture: Grep content-mode paths.
  15. `97ddc3c` adapter: every Bash command starts in the worktree (F-97).
  16. `85ae6d9` harnessd: read capture stays confined to the worktree.
  17. `6dfa9e7` harnessd: sync and land review fixes, never destroying work; `test/sync-land.integration.test.ts`.
  18. `fcc8cdd` HANDOFF: the 0B review outcome.
  19. This HANDOFF update: the branch is pushed, and the PR is open.

### What was decided (S9, PLAN.md)
- **D-86:** Phase 0B approved by Daniyal; U-1 deferred until a key exists; this stretch stops at the S3 example.
- **D-87:** the model endpoint is configured, never hardcoded. Priority: DeepSeek `deepseek-flash` → a fixed free OpenRouter model for smoke tests → Kimi → Haiku 4.5 as a comparison. An A/B uses one fixed model and config in both arms. *That priority list is superseded by D-104 (2026-10-04): OpenRouter first.*
- **D-88 / D-89:** Q-06 and Q-07 resolved.
- **D-90 to D-93** (Proposals): how providers, read capture, invalidation and sync, and the land step are built.

### What's built in this stretch
- **Providers (D-90):** `[providers.<name>]` in `~/.harness/config.toml` (https endpoint, `x-api-key` or bearer, the *name* of the key variable, model, limits, prices). Example tables in `docs/examples/providers.toml`; README "Choosing a model provider" explains. Bearer endpoints get the key in both auth variables so the subscription-login check still holds (C-21). Secrets can't use names the CLI reads (incl. `BUN_*`: the CLI is a Bun binary, F-78). Model and cost basis are recorded per session; metrics warn on mixed models.
- **Read capture (D-91):** Read/Grep reads, best-effort shell reads, instruction files and edit bases, as Git blob ids → `readset.add`; the missed-hook monitor and coverage counters (H-03).
- **Invalidation and sync (D-92):** `dependency_changed` notices in progress and landed; dedup and supersede; landed notices are held until harnessd has synced the reader's branch at its turn end, then delivered with a diff excerpt. A conflict blocks the task until `harness task unblock`.
- **Land (D-93):** `harness land <task>`: fencing check, merge in an integration worktree, approved setup and test commands under srt with loopback only (the D-83 fix), then a compare-and-swap or clean fast-forward of the base. Crash recovery. `harness approve` now also covers test commands (their own kind).
- **The S3 exit example passes** with the scripted model: `test/s3.integration.test.ts`, and on the real benchmark app with `npm run demo:0b`.

### Results (2026-10-03)
- **`npm run check`** at `6dfa9e7`: **194 tests: 193 pass, 1 skipped (intentional), 0 fail**, run from a checkout outside iCloud (see the caveat below). Every commit on the branch type-checks. The server-only commit `62257c3` was also run in full against the old harnessd: 181 pass, 1 skipped, and 1 failure, which was the known adapter flake below (that commit doesn't touch the adapter).
- **`npm run demo`** (0A regression): all six 0A criteria met (re-run at `6dfa9e7`).
- **`npm run demo:0b`** (scripted model, on Shelf; re-run at `6dfa9e7`): ✔ A reads `src/shared/types.ts` at its base blob; ✔ B's change lands with Shelf's 18 tests green under srt; ✔ A is synced at turn end (land.completed → worktree.synced → notice delivered) and told "Dependency changed: src/shared/types.ts has changed since you read it." with a diff containing `+  expiresAt: string;`; ✔ both tasks landed. ~14 s. Metrics: M1 10 s (landed form), 2 stale-context notices, both delivered.
- **Key-free provider probes** (`packages/adapters/test/provider.test.ts`, real pinned CLI against the mock): x-api-key with a base path, bearer, tier pinning, field stripping, `extra_body`, budget stop, reserved-name refusal, each security rule with a negative control.
- **Two adversarial review passes** (multi-agent):
  - **Provider review:** 10 confirmed issues, all fixed before commit (incl. a loopback-http hijack and `BUN_OPTIONS`).
  - **0B review** (read capture, sync, land; 55 agents across five areas): 50 findings, **47 confirmed, 3 refuted**. All 47 are addressed in commits 13 to 17, each by a code fix, a test, or both. The worst: a post-land teardown that force-removed a worktree with uncommitted work, a land reading the task tip before harnessd had committed it, a fast-forward overwriting the human's ignored `.env`, peer file names forging notice lines, a sync committing conflict markers, and notices lost when a sync failed.
  - Every new regression test was checked with a **negative control**: the fix removed, the test fails.
  - The new race test also found a **real deadlock**: a notice insert's foreign-key check waiting on a row lock while the other transaction waited on the invalidation lock. Fixed with one lock order (the advisory lock first) and `FOR NO KEY UPDATE` on task rows.
  - The review also produced **F-97**: Claude Code's Bash keeps its working directory between commands unless `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`, which the adapter now sets.

### Environment on Daniyal's Mac
- macOS on Apple silicon, Node 26.9.0, npm 11.19.1.
- **PostgreSQL 18.6** (Homebrew `postgresql@18`) on **port 5433**, beside the PostgreSQL 17 on 5432 that other projects use. Data dir `/opt/homebrew/var/postgresql@18`; databases `harness_dev`, `harness_test`.
  - After a reboot: `LC_ALL=en_US.UTF-8 /opt/homebrew/opt/postgresql@18/bin/pg_ctl -D /opt/homebrew/var/postgresql@18 -l /opt/homebrew/var/postgresql@18/server.log start`
  - Every shell that runs tests or demos: `export HARNESS_DATABASE_URL=postgresql://localhost:5433/harness_dev HARNESS_TEST_DATABASE_URL=postgresql://localhost:5433/harness_test` (a test now fails if it reaches a server older than 18).
- **⚠ iCloud caveat (important):** `~/Desktop` is iCloud-synced on this Mac. Inside it, real-CLI tests flake (a Bash edit's `bashEditDiff` goes missing; timeouts), and Git operations that delete and recreate files make iCloud create `name 2.ext` duplicates (a duplicate migration `0007_session_model 2.sql` once broke the tests). The same code passes 3/3 from a clone in `/private/tmp`. **Recommended:** move the repo out of iCloud (for example `~/code/harness-ai`), or turn off Desktop & Documents sync for it. Until then, verify from a worktree outside iCloud: `git worktree add /private/tmp/harness-wt HEAD && cd /private/tmp/harness-wt && npm ci && npm run check`. For uncommitted work, snapshot it without touching the real index: `GIT_INDEX_FILE=/tmp/idx git read-tree HEAD && GIT_INDEX_FILE=/tmp/idx git add -A && git commit-tree $(GIT_INDEX_FILE=/tmp/idx git write-tree) -p HEAD -m snapshot`, then check out that commit in the outside worktree. Avoid `git stash` inside iCloud: it triggers the duplicates. Check for duplicates with `git ls-files --others --exclude-standard | grep -E " [0-9]+\.[^/]+$"`.

### Commands
```bash
npm run check                                # type-check + all tests (Postgres 18 env vars above)
npm run demo                                 # 0A demo, scripted model
npm run demo:0b                              # 0B S3 demo on Shelf, scripted model
node scripts/provider-check.ts --provider openrouter   # check the key and the model first (D-104; about $0.02)
npm run demo:0b -- --real --provider openrouter   # real agents (needs OPENROUTER_API_KEY; ≤ $2 per session)
npm run demo -- --real --provider openrouter      # the 0A loop with real agents
# e17 (U-1..U-3) on OpenRouter: see "The OpenRouter key, and the first real runs" above. --provider deepseek still works with DEEPSEEK_API_KEY.
```

### API keys (never in a file in the repo; export in the shell that runs harnessd or the demo)
| Provider | Variable | Where to get it | Notes |
|---|---|---|---|
| OpenRouter (**the default since D-104**) | `OPENROUTER_API_KEY` | https://openrouter.ai/settings/keys | Pay-as-you-go credits. `deepseek/deepseek-v4.1-flash` on DeepSeek ≈ $0.30 in / $1.20 out per 1M tokens; `openrouter-haiku` is the fallback (F-112). |
| DeepSeek (optional since D-104) | `DEEPSEEK_API_KEY` | https://platform.deepseek.com/api_keys | Prepaid: top up at https://platform.deepseek.com/top_up. The same model on DeepSeek's own endpoint. |
| Kimi | `MOONSHOT_API_KEY` | https://platform.kimi.ai/console/api-keys | Needs ~$10 top-up for a usable rate limit. |
| Anthropic (Haiku comparison, U-1 on Claude) | `ANTHROPIC_API_KEY` | https://console.anthropic.com/settings/keys | |

A good place: a `chmod 600` file, e.g. `~/.config/harness/keys.env` containing `export OPENROUTER_API_KEY=…`, sourced from `~/.zshrc`.

### Unresolved
- **Real models are untested.** Everything ran against the scripted mock. First real run (since D-104): `node scripts/provider-check.ts --provider openrouter`, then `npm run demo:0b -- --real --provider openrouter`; expect to debug (the CLI's cost figure for a non-Anthropic model is a guess, so harnessd prices from the table). Then run e17 per provider to close U-1 to U-3 (Q-18, D-86).
- **OpenRouter free models:** none is a coding model like DeepSeek/Qwen-Coder; tool-call reliability unknown; smoke-test one (`openrouter-free` in the example file) before relying on it.
- **Not built in this stretch (later 0B, after an owner's review):** hook-based notice delivery and the Stop gate (item 3), `wait_for` (4), lease commands and `harness claim --force` (rest of 5, D-89), `contract_request`/`task_blocked` from agents (6), read confinement (7), T-1/T-1b/T-2 (8), the A/B setup and run (9, 10).
- **Known gaps:**
  - A land that fails its tests leaves the task `done`; reopening it needs Phase 1 resume (D-40).
  - `waitForApproval` has no timeout, so a missed approval waits forever.
  - harnessd still doesn't resume in-progress tasks after a restart (D-40).
  - A finished-but-unlanded task's landed notices are only shown to the human.
  - An agent that changes more than 5,000 non-ignored files: its claim reports are refused (the server's cap), and so is the land. Syncs past the cap mark all reads stale (`all_changed`).
  - Recovery when the base no longer contains a land's merge (the human rewound it) fails the land as `interrupted`; that path has no test.
- **Known flake:** under heavy load, the adapter test "a hardened session edits inside its worktree only" can miss the Bash edit. The CLI's own `bashEditDiff` field comes back empty, and harnessd's periodic worktree diff (D-70) is the backstop for exactly that. Seen in 2 of 3 full runs, including at `62257c3`, which doesn't touch the adapter, and earlier on the pre-change tree. It passes in isolation (3 of 3).

### Exact next steps
1. Read this section and PLAN.md D-86 to D-93; review the branch (`git log main..0b/stale-context`).
2. Optionally move the repo out of iCloud; run `npm run check` and `npm run demo:0b` from there.
3. Get an OpenRouter key (D-104), export `OPENROUTER_API_KEY`, run the provider check and `npm run demo:0b -- --real --provider openrouter`, then e17 on it; record results (Q-18) in docs/research/spike-0a.md §5.
4. Review and merge [vihAan02/harness#1](https://github.com/vihAan02/harness/pull/1) (owner), then decide whether to continue 0B: items 3, 4, the rest of 5 (D-89), 6, 7, 8, then 9 and 10 (the A/B on harness-bench, one fixed model in both arms, D-87).

### Progress on this stretch
- [x] M0 environment and baselines.
- [x] M1 governance records (S9, D-86 to D-89, F-IDs).
- [x] M2 provider integration (D-90), reviewed, 10 findings fixed.
- [x] M3 read capture and the missed-hook monitor (D-91).
- [x] M4 invalidation and sync (D-92).
- [x] M5 the land step (D-93).
- [x] M6 the S3 exit test, `demo:0b`, metrics and docs.
- [x] Fix the confirmed findings of the 0B review: all 47 addressed, with regression tests and negative controls; `npm run check` green (194 tests).

---

# Original 0A handoff (vihAan02, 2026-10-03)

> Written for Daniyal Mughal (GitHub `DaniyalMughal1`), who continues the work from here. It's a snapshot: where it disagrees with `PLAN.md`, `PLAN.md` wins.

## What this project is
**The harness** is a coordination layer for several humans, each running their own AI agents on their own machines, on one repo.
- **Coordination server:** Postgres + WebSocket, with an event log as the record.
- **harnessd:** the per-device daemon. It's the execution and security boundary: it runs agents, owns Git writes and sandboxes setup commands.
- **AgentAdapter:** the vendor boundary. ClaudeAdapter (Claude Agent SDK) is built; Codex comes in Phase 1.
- **The core thesis:** catching stale context matters more than file locks. Claims are awareness signals only; peer messages are typed and untrusted.

**Owners:** vihAan02 (GitHub, repo owner) and Daniyal Mughal (co-owner, GitHub `DaniyalMughal1`). A gate marked "owner" in the docs needs approval from either of them. This is recorded as D-85 (from source record S8), which supersedes D-71's owner line.

## Read before doing anything (in this order)
1. `AGENTS.md`: working rules for every agent. `CLAUDE.md` imports it.
2. `PLAN.md`: the source of truth. Decisions D-01 to D-85; §12 is the canonical "what's next".
3. `docs/roadmap.md`: what each phase builds, and what it must not build.
4. The doc for the area you're touching: `docs/{architecture,coordination,agent-adapters,local-runtime,protocol,security,validation}.md`. Before touching the Claude adapter, also read `docs/research/spike-0a.md` (what the vendor actually does) and the F-IDs in `docs/research/vendor-capabilities.md`.
5. `docs/open-questions.md`: never silently decide an open question; ask an owner.

## Where the code is
**Main repo:** github.com/vihAan02/harness, on **`main`**. All of Phase 0A is there. Branch from `main` for new work. (`claude/0a-skeleton` is the branch 0A was built on; `main` was fast-forwarded to it, so it holds nothing extra.)

| Commit | What it adds |
|---|---|
| `fc74ddc` | Spike follow-ups |
| `36d64ea` | Repo skeleton (D-71, D-72) |
| `43e10a6` | Data model v0 on Postgres 18 (D-73) |
| `2fc730c` | Coordination server v0 (D-74) |
| `8fc0061` | harnessd v0 (D-75, D-76) |
| `c5457ae` | AgentAdapter + ClaudeAdapter (D-77) |
| `762527d` | Agent tools: `harness_status`, `ask`, `answer`, `report_done` (D-78) |
| `1ad3783` | Soft claims and overlap warnings (D-79) |
| `2c6f154` | Typed message delivery: envelopes, budgets, `message.ack` (D-80) |
| `7eaa87b` | Human CLI and task lifecycle (D-81) |
| `e1f6cb6` | Metrics capture and the benchmark app (D-82, D-83) |
| `75e3393` | The 0A demo; every 0A exit criterion met with a scripted model (D-84) |

**Benchmark repo:** github.com/vihAan02/harness-bench, `main` at `8c6ea60`. It holds "Shelf", a small team book-lending app built for the A/B test:
- TypeScript on Node 24, using Node's built-in SQLite;
- an API, a typed client with HTML views, migrations, and shared types as the API contract;
- 18 tests that run in about half a second.

**Layout of the main repo:** an npm workspace, `packages/{protocol,server,daemon,adapters,cli}`, run straight from TypeScript source (Node 24+, `erasableSyntaxOnly`).
- `scripts/demo-0a.ts`: the demo.
- `test/`: end-to-end tests.
- `spikes/0a-adapter/`: the throwaway spike, with its own `package.json` (not part of the workspace). Product code must never import it.

**Access:** `DaniyalMughal1` is already a collaborator, with push access, on both repos (checked 2026-10-03).

## Status
- **Phase 0A, items 0 to 11: all built.**
- **`npm run check`:** 125 tests, 124 pass, 1 skipped (the skip is intentional). About 20 s.
- **`npm run demo`:** all six 0A exit criteria pass with the scripted model, about 15 s per run. The criteria: who's alive, who owns what, what each agent is changing, what the others are doing, overlaps, and a question/answer round trip with latency and delivery point recorded.
- **Checked on a fresh clone of `main`** (2026-10-03, macOS on Apple silicon, Node 24.13.1): `npm ci`, `npm run check`, `npm run demo`, and the spike's `e17 --mock` all ran clean.
- **The agent tests** run the real pinned Claude Code CLI (Agent SDK 0.3.287 / CLI 2.1.287) against a scripted stand-in for the model, in `packages/adapters/test/mock-api.ts`. They need no API key. Only the model is fake; Claude Code, the sandboxes, Git, Postgres and the CLI are all real.

## Still open for 0A (needs an owner: vihAan02 or Daniyal)
1. **Real-model checks (Q-18).** They need `ANTHROPIC_API_KEY` exported. API keys only, never a subscription login (D-56).
   - **U-1 to U-3**, for about $0.10 to $0.30:
     ```bash
     cd spikes/0a-adapter
     npm ci
     node experiments/e17-real-model.ts
     ```
     The spike has its own install, and the root `npm ci` doesn't cover it. `--mock` runs the same script free, to check the plumbing first.
     
     Output lands in `spikes/0a-adapter/.runs/` (git-ignored). The verdicts need a human read of the model's replies (see `docs/research/spike-0a.md` §5). Record them there, then close Q-18.
   - **The whole demo with real agents:** `npm run demo -- --real`, capped at $2 per session. This path has never run, so expect to debug it on the first try.
2. **An owner reviews 0A and approves starting 0B** (D-44). Don't start 0B without it.

## Running locally (macOS)
**Only macOS has been tested.** The sandboxes (`srt` and Claude Code's) are platform-specific, so other platforms are untested.

**You need:**
- Node 24 or later (`.nvmrc`);
- Git;
- Homebrew;
- network access for `npm ci` and the demo, which clones harness-bench and runs Shelf's `npm ci`.

**Steps:**
1. `npm ci` at the repo root.
   - If the optional `@anthropic-ai/claude-agent-sdk-darwin-arm64` binary is reported as failed, install it alone: `npm install --no-save @anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.287`.
2. **Postgres 18, once:** `brew install postgresql@18`.
3. **Postgres's binaries aren't on `PATH`,** in every shell that needs them:
   ```bash
   export PATH="/opt/homebrew/opt/postgresql@18/bin:$PATH"
   ```
4. **Start Postgres:**
   ```bash
   LC_ALL=en_US.UTF-8 pg_ctl -D /opt/homebrew/var/postgresql@18 -l /opt/homebrew/var/postgresql@18/server.log start
   ```
   - Without `LC_ALL`, it fails with "postmaster became multithreaded".
   - This start lasts until reboot. `brew services start postgresql@18` keeps it running across reboots.
5. **Databases, once:** `createdb harness_dev`, then `createdb harness_test`.
6. **Check and demo:**
   - `npm run check`: type-check plus every test.
   - `npm run demo`: the scripted demo.
7. **Run the pieces yourself:** `npm run server`, `npm run daemon` and `npx harness …`. See "Running locally" in README.md. The daemon needs `~/.harness/config.toml` and `~/.harness/token` (chmod 600).

## Conventions and gotchas
- **Git:**
  - Branch from `main` for new work.
  - Commit and push only when an owner asks; never commit secrets.
  - Commit under your own identity. Everything so far was authored as `vihAan02`.
  - End commit messages with: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- **Decisions:** a new D-ID supersedes an old one; never silently edit an existing decision.
- **Records:** `docs/source/` (S1 to S9) holds raw records of the owners' instructions. Never edit them.
- **Vendor facts:** keep them as F-IDs in `docs/research/vendor-capabilities.md`, and re-verify anything older than about 60 days. Most were checked on 2026-10-01.
- **Pinned vendor versions (D-49):** ClaudeAdapter refuses any Agent SDK other than 0.3.287 (CLI 2.1.287). To move the pin:
  1. re-run the spike's experiments on the new version (`spikes/0a-adapter/README.md`) and the adapter tests;
  2. update the F-IDs;
  3. then update `PINNED` and `BUILTIN_SKILLS` in `packages/adapters/src/claude/version.ts`.
- **Security defaults you must not weaken** (full list in AGENTS.md):
  - no repo-controlled executable config in agent sessions (D-45);
  - no vendor peer channels (D-46);
  - path-scoped Edit/Write rules only (D-60);
  - the dead-man PreToolUse callback (D-62);
  - injected messages always sent verbatim (D-63);
  - the API key hidden from the agent's shell (D-64);
  - harnessd owns every Git write (D-50).
- **Test pattern:**
  - each server test file gets its own throwaway Postgres schema;
  - `test/support.ts` starts the whole stack;
  - check each confinement or security test with a negative control: weaken the rule and confirm the test fails.
- **Known limitations:**
  - **Under the setup sandbox (`srt`),** a server can't serve or reach `127.0.0.1`. The 0B land step's test command needs local-port access in its `srt` config (noted in the roadmap and D-83).
  - **A restarted harnessd doesn't resume in-progress tasks;** that's Phase 1 (D-40). Abandon the task and add it again.
  - **Node 24's SQLite** prints an experimental-feature warning; Shelf's scripts silence it.

## Next phase (0B, after an owner approves; see docs/roadmap.md)
1. Read capture and a monitor for missed hooks.
2. The invalidation engine and sync at turn end ("Dependency changed: X has changed since you read it").
3. Notices delivered through hooks, and the Stop gate.
4. `wait_for`.
5. Hard claims (leases with fencing tokens) and the local `harness land` step. Remember the `srt` local-port fix.
6. The remaining message kinds (`contract_request`, `task_blocked`).
7. Read confinement.
8. Security tests T-1, T-1b and T-2.
9. A/B setup: scenarios SC-0 to SC-4 as tags in harness-bench, task cards, hidden checks, baseline recorder, playbook, rubric.
10. Run the A/B test against pass bar v1 (D-57).

**Validated-MVP gate:** 0B's exit criteria plus that A/B result, then an owner's go/no-go.
