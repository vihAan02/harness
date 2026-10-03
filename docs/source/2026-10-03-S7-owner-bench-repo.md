# S7: Owner's choice of the benchmark repo, and go-ahead for 0A item 10 (raw record)

> **Status:** Raw source record. **Do not edit.**
> - The newest source. Where S1–S7 conflict, S7 wins.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan. The choices are recorded there as D-83.
>
> **Provenance:** written by the owner on 2026-10-03 in a Claude Code session, answering the proposal below. Verbatim.

**The proposal it answers** (Claude's recommendation for where the benchmark app lives, and its stack):

````text
One thing I need from you first: where should the benchmark app live? validation.md says it gets its own repo, because every run starts from a fresh clone at a tagged commit.
- A new GitHub repo, say vihAan02/harness-bench (my recommendation). Creating it is your call, since it's a public-facing action under your account.
- A folder in this repo that the test scripts copy into a fresh Git repo for each run. That's simpler now, but it isn't the dedicated repo the plan describes.

For the app itself I'd use TypeScript on Node 24, with Node's built-in SQLite for the database, so there's nothing extra to install and no network needed after setup.
````

**The owner's answer:**

````text
new repo: https://github.com/vihAan02/harness-bench.git , go ahead with your picks
````
