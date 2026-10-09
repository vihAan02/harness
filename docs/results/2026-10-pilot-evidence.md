# The two-Mac pilot: release evidence (PB6; D-110)

This is the record of what has actually run, on which commit, and with what result, against board #86's acceptance tests. Nothing goes here that hasn't happened. "D" means deterministic in CI with scripted agents; "M" means manual, on both Macs against real GitHub. Spend is real-model spend only.

**Candidate SHA:** not chosen yet. Both Macs install it with `scripts/pilot/install.sh install <sha>`.

## Acceptance tests (#86)
| # | Test | D (deterministic) | M (both Macs) |
|---|---|---|---|
| 1 | **Join without SQL:** distinct keys, pins and allowlists; each Mac runs its own approved agent | `test/pilot/bootstrap.integration.test.ts` (PB1, #115/#116). Two homes join through the real CLI; two harnessds connect with distinct identities; `doctor` passes, then names a wrong pin. 5 runs out of 5 on Vihaan's Mac | Not yet: needs the coordinator host (H1a) |
| 2 | **Trust:** a wrong principal or device, a replayed hello, a squatter key, a modified or replayed dispatch, an unauthorized remote start, policy widening, a message asking to disable checks, localhost reach. T-3/T-4/T-5/T-5b, with T-1/T-1b/T-2 still green | • Identity (PA2, `acd8e02`): squatter frames, replayed hello, revoked device.<br>• Server dispatch checks (PB2a, #111): every refusal reason, replay, owner-or-agent's-human, one live session.<br>• T-5 (PA3b, `be3f0c1`).<br>• Localhost Postgres (PA11, `520f5d5`).<br>• T-3/T-4 wait for PA3. T-1/T-1b/T-2 are green on `main` | n/a |
| 3 | **Two clones, coupled change, A→B and B→A** | PA5a/PA5c/PA5d/PA6/PA7 (`fd85fee`, `8689af3`, `3be2127`, `b9b30ac`, `c11dae7`) against the fake GitHub | Not yet |
| 4 | **Fencing and reservation:** stale token, held reservation, changed head or base, squash verification, one `land.completed` | PA6 (`b9b30ac`) | Not yet |
| 5 | **Crash windows:** all 8 fault points | PA10 (`34026a0`) | Not yet |
| 6 | **Sleep and disconnect:** reconnect, no revived lease, D-103, conflict → unblock, a peer's reconcile | Partly: PA4a (`058d6b5`), PA4b (`543afa3`). A peer's reconcile isn't built yet (my #101 review) | Not yet |
| 7 | **Provider failure:** 401, rate limit and budget stop safely and can be resumed | PA8 (`bb2fdc2`) | Not yet |
| 8 | **Dogfood:** every UI file from a Harness session and its PR; both humans run a later real task from the UI | PU task texts are ready (PB4a #119); fixtures in PB4b (#121) | Not yet: after R1 |
| 9 | **Candidate:** the exact SHA, `check`, targeted suites, both demos, the required checks, new suites 5 runs and once under `test:ci`, no hidden-check access, no A/B change | | Not yet |

## Vihaan's Mac
| Date (UTC) | What | Result |
|---|---|---|
| 2026-10-08 | Baseline on `main` @ `818ccef`, Node 24.13.1, Postgres 18.6 trust | `check` 360 tests, 359 pass, 0 fail, 1 skipped; both demos pass (H0, #4) |
| 2026-10-09 | `scripts/pilot/pg-harden.sh` on Postgres 18 :5432 (with Vihaan's OK) | Every check `ok`: a password-less login is refused, `harness_agent` can't `COPY … TO PROGRAM`. Backup at `pg_hba.conf.pre-harness` |
| 2026-10-09 | Node 24.21.0 (the nvm default, matching Daniyal's); `gh auth setup-git`; tunnel key; device key `dev_vihaan_mbp` | Done. Public keys only, handed to Daniyal by Vihaan |
| 2026-10-09 | `npm run check` on `main` @ `6ffbee7`, hardened Postgres, Node 24.21.0, `PGPASSFILE` | 376 tests, 375 pass, 0 fail, 1 skipped |

## Real-model spend (D-116: $0.10 a session, $0.25 a day per Mac)
| Date (UTC) | Mac | Run | Cost |
|---|---|---|---|
| — | — | none yet | $0.00 |

## Task, session and PR record (dogfood)
None yet. Each PU task gets a row: task id, session ids, PR, head SHA, integration, cost.
