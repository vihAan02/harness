# Phase 0A adapter spike (throwaway)

**Not product code.** Product packages must never import from here (D-44, D-59). Results and conclusions are in [docs/research/spike-0a.md](../../docs/research/spike-0a.md).

- **What it does:** runs the real Claude Code binary (bundled in the pinned Agent SDK) against `lib/mock-api.ts`, a scripted stand-in for the Messages API. Each experiment can then issue exact tool calls, including escape attempts, and observe what the client allows, captures and delivers.
- **Auth:** a dummy API key and a throwaway `CLAUDE_CONFIG_DIR` per session. No real credentials, no subscription login (D-56). The mock never logs credential values.
- **Run:** `npm ci`, then `node experiments/<file>.ts`. Node strips the TypeScript types: the spike ran on Node 26.9 and was re-run on Node 24.13.1. Each run writes raw request bodies and a `result.json` under `.runs/<experiment>/` (git-ignored). If `npm ci` reports the optional `@anthropic-ai/claude-agent-sdk-darwin-arm64` binary as failed, retry it alone: `npm install --no-save @anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.287`.
- **Configs:** `lib/session.ts` holds two. `hardenedOptions` is the pre-spike proposal the experiments attack; `correctedOptions` is the config the spike arrived at (D-60 to D-68), which `ClaudeAdapter` starts from.
- **Real model:** only `e17` calls the real API, and only when `ANTHROPIC_API_KEY` is exported (D-56). Each session is capped by the SDK's `maxBudgetUsd` (default $0.25, `E17_BUDGET_USD` to change).

| File | Question |
|---|---|
| `e00-smoke.ts` | Does the binary run against the mock, hardened? |
| `e02-inject.ts`, `e15-slash-injection.ts`, `peek-lifecycle.ts` | Q2: injection timing, priorities, receipts, `@`/`/` expansion |
| `e03-capture.ts` | Q3/Q4: edit and read capture vs. a filesystem diff |
| `e05c-confinement-clean.ts` | Q5: 53 write-escape attempts (51 valid), bare vs scoped rules, recording what blocked each (supersedes `e05`/`e05b`, which had confounds). The D-60 regression check |
| `e05-write-confinement.ts`, `e05b-read-then-write.ts` | Q5, first pass (`--restricted` variant; read-only Git commands) |
| `e06-repo-config.ts` | Q6: hostile repo hooks, MCP, `apiKeyHelper`, instructions |
| `e07-resume.ts` | Q7: graceful and hard-kill resume, cwd and config-dir changes |
| `e08-two-sessions.ts`, `e08b-exposure.ts` | Q1/Q8: two sessions, ports, env exposure, sockets, network |
| `e09-state-errors.ts` | Q9: state signals, API errors, usage, tool surface |
| `e10-fail-modes.ts`, `e10b-canusetool-and-crash.ts`, `e10c-orphan-continues.ts` | Q10: fail open vs closed, supervisor crash |
| `e11-cross-session.ts`, `peek-tools.ts` | The vendor's peer channel (F-17, D-46) |
| `e12-setup-sandbox.ts` | Setup/test commands under `srt` (D-52) |
| `e13-read-confinement.ts` | Which channel confines reads (F-12) |
| `e14-baseline-and-gaps.ts` | The A/B baseline's flags; background-write capture gap |
| `e16-review-followups.ts` | Idle `shouldQuery: false`; `bashEditDiff` with and without the flag; all messaging sockets |
| `e17-real-model.ts` | U-1 to U-3 with a **real model** (needs `ANTHROPIC_API_KEY`): `ask`/`answer` round trip through the tool shim, hostile enveloped peer messages, token overhead. `--mock` checks the plumbing for free (SP-15) |
