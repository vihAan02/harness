# S16: The owner moves development and the live demos to Haiku 5.5 on OpenRouter, within $0.50 a day (raw record)

> **Status:** Raw source record. **Do not edit.**
> - The newest source. Where S1–S16 conflict, S16 wins.
> - See [PLAN.md](../../PLAN.md) for the reconciled plan. Recorded there as D-126.
>
> **Provenance:** owner Vihaan (GitHub `vihAan02`), in his Claude Code session (stream B) on 2026-10-07. His OpenRouter key was set up in `~/.config/harness/keys.env` just before. Claude's preceding message is quoted first, then his reply, verbatim, including its spelling.
> - **Claude's text:** the message below.
> - **Vihaan's decision:** his reply.
>
> **How Claude applied it** (D-126 says so):
> - It read "0.50 c a day" as $0.50 a day.
> - It used `anthropic/claude-haiku-5.5`, not the `:batch` variant he named. `:batch` is OpenRouter's asynchronous Batch API, which can't drive an agent (F-120).

**Claude's message:**

````text
Confirmed again: `OPENROUTER_API_KEY` is exported in that terminal.

You have three steps left:
1. **Make it permanent (optional):** add `source ~/.config/harness/keys.env` to `~/.zshrc`, so new terminals have the key too.
2. **Say go for the provider check.** It costs about $0.02 and checks that the key works end to end.
3. **Set a budget for the dry runs.** I'd suggest $2 for the first round.
````

**Vihaan's reply:**

````text
set budget a bit and instead of deepseek lets use: anthropic/claude-haiku-5.5:batch with a budget of 0.50 c a day

continue with what needs to be done lmk when a live demo is ready to run
````
