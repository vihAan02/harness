# S11: The co-owner makes OpenRouter the real-model provider, and lets stream A take over stalled tasks (raw record)

> **Status:** Raw source record. **Do not edit.**
> - The newest source. Where S1–S11 conflict, S11 wins.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan. Recorded there as D-104.
>
> **Provenance:** pasted into co-owner Daniyal Mughal's (GitHub `DaniyalMughal1`) Claude Code session on 2026-10-04, after the B5/B6/B9a review rounds. The message is verbatim below, including its spelling.

````text
Check the repository and GitHub state from scratch before continuing.
Vihan did not necessarily complete the work we were previously waiting on, so do NOT rely on the old status update or assume B3/B4/B5/B6/B7/B9a etc. are finished.
1. Re-orient from the actual repo
First:
- git fetch origin
- inspect latest origin/main
- inspect all open PRs
- inspect recently merged PRs
- inspect the current GitHub issues/workboard
- read the latest HANDOFF.md
- read the relevant current sections of PLAN.md / roadmap
Determine from the actual GitHub state:
- what Daniyal's stream has merged
- what Vihan's stream has merged
- what Vihan started but did not finish
- which PRs are stale / conflicted / abandoned
- which tasks are still genuinely blocking the MVP
- whether any of our old assumptions are now wrong
Give priority to the code and GitHub state over stale planning docs.
Do not wait for Vihan if work can safely be completed from our side without overlapping or destroying his existing work.
2. Switch our real-model provider to OpenRouter
We are not using DeepSeek as our primary provider anymore.
We can provide an OpenRouter API key immediately, so make OpenRouter the primary provider for development, smoke tests, and the next real-model runs.
Keep the overall provider system configurable — DO NOT hardcode the harness architecture specifically to OpenRouter.
Desired configuration should be approximately:
- provider: openrouter
- key from environment: OPENROUTER_API_KEY
- no API keys committed anywhere
- no secrets in logs
- config remains able to support other providers later
Inspect the provider implementation that already exists before changing anything.
If OpenRouter already works through the current generic/provider-compatible path, make the smallest possible change:
- document/configure OpenRouter as the current default real-model provider
- update commands/scripts that currently assume deepseek
- update examples and HANDOFF where appropriate
- make real-model test commands accept/use --provider openrouter
Do NOT unnecessarily rewrite the provider abstraction.
If OpenRouter requires a different compatibility layer than the current DeepSeek path, implement it cleanly behind the existing provider interface.
Before asking me for anything, do everything possible without the key.
When the only remaining blocker is authentication, tell me exactly:
1. where OPENROUTER_API_KEY should be set
2. what command verifies the key/provider connection
3. what command runs the first Harness real-model test
Do not ask me to paste the key into chat.
3. Pick a FIXED OpenRouter model
For controlled testing, do not use a router that randomly changes the underlying model between requests.
Choose a specific inexpensive model available through OpenRouter that:
- supports the tool/function behavior Harness needs
- is reliable enough for development
- is inexpensive enough for many agent runs
- can be pinned by exact model ID
Use the exact same fixed model on both sides of any controlled A/B comparison.
Keep the model itself configurable.
If there are multiple sensible cheap choices, give me your recommended one and why, but don't block development on an unnecessary model debate.
4. Unblock the real-model work
Anywhere our work was waiting specifically for a DeepSeek key, convert it to OpenRouter.
In particular inspect things like:
- A7 real-model validation
- real demo:0b
- provider probes
- e17/e18 or equivalent real-model checks
- baseline launcher validation
- any A/B infrastructure that references DeepSeek
Once OPENROUTER_API_KEY is available, use OpenRouter for those runs.
Do not redo key-free scripted tests that are already proven unless a provider change actually affects them.
5. Continue anything that is currently unblocked
After inspecting GitHub, identify all work we can perform right now without waiting for Vihan.
Do not sit idle merely because the original parallel plan assigned something to stream B.
If Vihan has clearly not started a blocking task, or a stale PR is effectively abandoned, flag it and determine whether we should take ownership.
However:
- do not silently overwrite active Vihan work
- do not force-push his branches
- do not duplicate work that has meaningful active changes
If taking over one of his tasks is the fastest path, create a fresh Daniyal branch from latest main and implement it there.
Prioritize by critical path to functional MVP, not by the old A/B ownership table.
Focus first on anything required for:
1. multiple real agents running
2. coordination / waits / claims / leases / messaging working
3. security tests passing
4. demos passing
5. a real OpenRouter-backed end-to-end run
Formal A/B validation can come after the functional MVP if it is not blocking the product itself.
6. Clean up stale assumptions
Search the repo for references to:
- deepseek
- DEEPSEEK_API_KEY
- DeepSeek-specific real-model commands
Decide case-by-case whether each should:
- become OpenRouter
- stay as an optional provider example
- become generic provider documentation
Do not remove DeepSeek support just because we aren't using it right now.
OpenRouter should become the current/default development provider, while the architecture stays multi-provider.
7. Then proceed, don't just report
After re-orienting:
- make the provider/config changes
- test them
- continue the highest-priority unblocked work
- open small PRs
- keep main green
- update HANDOFF with the actual new state
If you encounter a decision that genuinely requires me, ask me.
Otherwise, keep moving.
At the next checkpoint, report:
Area	Current state	What changed	Blocker / next action
GitHub/main			
Vihan's unfinished work			
OpenRouter provider			
Real-model testing			
Functional MVP			
Work taken over by Daniyal			


Start by fetching GitHub and establishing the actual current repo state, then switch the real-model path to OpenRouter and continue everything that can safely proceed.
````
