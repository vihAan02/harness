# Researched facts (F-IDs)

> **Checked:** 2026-10-01.
> - **Versions:** Claude Code 2.1.286 (the local install is 2.1.280); Claude Agent SDK TS 0.3.286 / Python 0.2.163; Codex CLI / `@openai/codex-sdk` / `openai-codex` 0.159.3 (2026-09-30); PostgreSQL 18 (19 in beta); Git 2.56.0 (local Apple Git 2.50.1).
> - **Method:**
>   - Seven parallel research passes against primary sources: official docs, source code, registries, terms pages.
>   - Then **two independent checkers** re-opened the primary sources for every load-bearing claim. One covered Claude Code and the Agent SDK; the other covered Codex, infrastructure and vendor terms.
>   - Corrections from the checkers, and from a later citation-accuracy review, are folded in below.
> - **Empirical re-check:** the Claude facts the design leans on were re-tested against Claude Code 2.1.287 / Agent SDK 0.3.287 in the 0A spike ([spike-0a.md](spike-0a.md)). See the *Spike* lines under each F-ID, and C-14 to C-20.
> - **What an F-ID is:** a researched claim with a source and a confidence mark. Trust the mark: `?` and `◐` items are **not** verified facts. They're kept here so the evidence for them stays in one place.
> - **Added 2026-10-03:** F-24 to F-29 (Claude Code behind third-party endpoints), F-58 (`srt` loopback binding) and F-72 to F-77 (model providers), from one research pass over official docs, the pinned 2.1.287 binary and the srt 0.0.78 source, for D-87. Single-pass facts are ✔ at most; mock probes upgrade them where noted.
> - **Added 2026-10-04 and 2026-10-05:** F-111 to F-113 (OpenRouter as the real-model provider, D-104), from OpenRouter's live model API and docs, then with the project's key.
> - **Re-verify before writing code that depends on any of this.** Both agent vendors changed these surfaces several times in 2026.
>
> **Checker results:** Claude checker, 26 load-bearing claims: 18 confirmed, 8 corrected (details, none reversing a design conclusion), 0 refuted. Codex/infra/terms checker, 53 claims: 40 confirmed, 8 corrected, 2 "refuted" (both were claims the researcher had already marked contradicted, so the contradiction is confirmed), 3 uncertain (Anthropic's 2026 enforcement history and the OpenAI ToU clauses, secondary sources only).
>
> **Status legend:**
> - **✔ verified:** a primary source says this (one research pass).
> - **✔✔ double-checked:** an independent checker confirmed it against a primary source.
> - **◐ partial:** true with caveats, or only part is confirmed.
> - **✖ contradicts an earlier assumption.**
> - **? unverified.**
> - **(2°):** secondary source only.

## Contradictions and qualifications of S1/S2/S3

Each item lists which source it affects. C-14 to C-20 were found by the 0A spike ([spike-0a.md](spike-0a.md)), not by desk research. Nothing in S1–S3 was silently rewritten; [PLAN.md §11](../../PLAN.md#11-what-the-research-changed-or-qualified) records how each one is handled.

| # | Earlier assumption | What the research found | F-IDs |
|---|---|---|---|
| C-1 | S1: "With the SDK, the daemon can inject the message as a new user turn" | **Better than assumed.** A message pushed into a live SDK session is picked up **between tool calls inside the running turn**. It only starts a new turn if the session is idle. A running tool is never interrupted. | F-02 |
| C-2 | S1: "Claude Code PreToolUse can deny a call" (as an enforcement layer) | **True, but qualified.** Command, HTTP and MCP-tool hooks **fail open** on timeout, crash, missing script or non-2xx. Agent SDK in-process callbacks fail closed only for PreToolUse/UserPromptSubmit timeouts; PostToolUse and Stop callbacks fail open. The vendor says to use permission rules and the sandbox for hard enforcement. | F-05, F-06 |
| C-3 | S1: Codex limits come from "sandbox_mode and approval policy"; only Claude has pre-tool hooks | **Partly outdated.** Codex now has **hooks** (GA around 2026-05) with PreToolUse deny, PostToolUse context and Stop continuation. They fail open. The `untrusted` approval policy is retired and `on-failure` is deprecated. `codex exec` forces approvals to `never`. | F-32, F-35, F-37 |
| C-4 | S1: drive Codex through "its SDK, or codex exec" and inject at turn boundaries | **Qualified.** The TS SDK and `exec` start one process per turn, so injection happens **only between turns**. Mid-turn steering needs the **app-server** or Python SDK, and the app-server is labelled experimental and not for production. | F-33, F-34 |
| C-5 | S3: "Native Read/Grep/Glob hooks may give strong coverage" | **True for Claude, with gaps:** a repeated-read stub with no content, @-mentions, auto-loaded instructions, and shell reads. **Codex has no read tool at all**, so read capture there is command parsing only. Glob gives names, not contents. | F-07, F-08, F-39 |
| C-6 | S1: "Postgres LISTEN/NOTIFY is enough for fan-out at first" | **Holds only as a payload-free wake-up.** Notifications aren't durable, LISTEN doesn't work through PgBouncer transaction pooling, and NOTIFYing commits are serialized by a cluster-wide lock. | F-54, F-55 |
| C-7 | S1: "per-project monotonic sequence number so clients can resume from a cursor" | **Holds, but a `bigserial` cursor silently skips events** that commit late. Use a per-project counter row updated in the same transaction. | F-56 |
| C-8 | S1: "GitHub merge queue plus required CI checks do the integration" | **Not universally available.** Merge queue works only on org-owned public repos, or private repos on GitHub Enterprise Cloud. It needs `merge_group` triggers, and it had a squash-merge regression in April 2026. Needs a fallback. | F-50 to F-53 |
| C-9 | S1: "check each vendor's terms… An API key may be required for a commercial product" | **Confirmed, and sharper.** Anthropic's Agent SDK docs say third-party products may not offer claude.ai login unless approved, and `claude -p` counts as the Agent SDK. A separate legal-page carve-out lets end users sign in to the **unmodified** binary with their own subscription. That's a grey zone. OpenAI documents `codex exec` with the user's saved ChatGPT login (F-68) and forbids app-server ChatGPT auth for commercial or hosted products (F-70). The orchestrator-plus-`exec` case is undocumented (F-71). | F-60 to F-71 |
| C-10 | S1: "Codex, Cursor, and Warp parallel agents are single-user, so this is the gap" | **Vendors: confirmed.** But **Axis** targets the exact wedge (small), Amp and Conductor added multiplayer, and the gap is closing. | [landscape.md](landscape.md) |
| C-11 | Implicit: the vendor's own "file modified since read" guard limits stale edits | **No longer true.** Claude Code relaxed it (v2.1.208+). Codex appears to have none (F-44 ◐), and `apply_patch` falls back to whitespace-insensitive context matching. And by construction, a per-worktree guard can't see changes in another worktree. | F-20, F-44 |
| C-12 | Implicit: a worktree is an isolated sandbox for an agent | **Not by default.** Worktrees share `.git` hooks, config and refs. Headless Claude sessions run **repo-committed hooks** and MCP servers by default. Codex's default sandbox can read the whole filesystem. | F-13, F-14, F-38, F-57 |
| C-13 | Implicit: agent-to-agent messaging is something we add | **Claude Code ships its own** cross-session messaging (on by default) and agent teams. Left alone, they would let peer traffic bypass the harness's typed, budgeted, enveloped channel. | F-17, F-18 |
| C-14 | Plan (agent-adapters §5): `origin: {kind: 'peer'}` labels peer messages for the model | **Found by the spike:** `origin` changes nothing the model sees. Mid-turn the CLI frames every injection as "The user sent a new message". The harness envelope is the only model-visible provenance (D-63). | SP-02 |
| C-15 | Implicit: injected text is inert | **Found by the spike:** without `client_composed: true`, injected `@<path>` reads a file (even outside the worktree) into context, and `/clear` runs and wipes the conversation (D-63). | SP-02 |
| C-16 | F-05 as read in D-47/TH-15: in-process PreToolUse fails closed | **Found by the spike:** only on **timeout**. A callback that throws lets the tool run. And if `harnessd` dies, the orphan keeps working unless a PreToolUse callback is registered (D-62). | SP-10 |
| C-17 | agent-adapters §5: the sandbox + `dontAsk` + allow list confine writes | **Found by the spike:** the sandbox covers Bash only. Bare `Write`/`Edit` allows let file tools write anywhere the OS user can, including peer worktrees: 17 of 51 escapes succeeded vs 0 of 51 with scoped rules (D-60). | SP-05 |
| C-18 | D-48: passing the API key through env is safe | **Found by the spike:** the key is in the agent shell's environment, readable by any repo script, unless `sandbox.credentials.envVars` denies it (D-64). | SP-08 |
| C-19 | F-22 read as "no per-agent `CLAUDE_CONFIG_DIR`" | **Found by the spike:** that caveat is subscription-only. In API-key mode a per-agent dir is the strongest isolation available (D-65). | SP-08, SP-11 |
| C-20 | F-11's order (hooks run before deny rules), relied on by the missed-hook monitor (D-47) | **Found by the spike (2026-10-02):** a Read whose path matches a `Read(//…)` deny rule is rejected at input validation, and **no hook fires** (no PreToolUse, PermissionDenied or PostToolUseFailure). The monitor and T-1 must count attempts from the stream's `tool_use` blocks. Only Read was tested. | SP-15 |
| C-21 | D-56/D-77: an API key from any provider reports `apiKeySource: 'ANTHROPIC_API_KEY'` | **Only for `x-api-key` providers.** A provider that takes only a bearer token (`ANTHROPIC_AUTH_TOKEN`) reports `'none'`, the same value as a subscription login, so the auth-source check can't tell them apart (D-87). | F-24 |

---

## Claude Code and the Claude Agent SDK

**F-01 ✔✔ The SDK is TypeScript-first.**
- `@anthropic-ai/claude-agent-sdk` 0.3.286 tracks Claude Code 2.1.286. Python `claude-agent-sdk` 0.2.163 gets only 10 hook callbacks (the others only as settings-file shell hooks) and fewer control methods.
- One `claude` subprocess per session.
- Defaults differ: TS `env` *replaces* the environment while Python *merges* it, and TS `failIfUnavailable` defaults to true.

Sources: [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart), [npm](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest), [PyPI](https://pypi.org/pypi/claude-agent-sdk/json), [hooks](https://code.claude.com/docs/en/agent-sdk/hooks). *Impact: TS adapter ([Q-01](../open-questions.md#q-01)); pin versions.*

**F-02 ✔✔ Streaming-input delivery semantics.**
- **API:** `query({prompt: AsyncIterable<SDKUserMessage>})` / `streamInput()`.
- **When it lands:** a message pushed mid-turn is picked up **between tool calls in the same turn**, and that turn then answers it. A running tool is never interrupted. If the turn has ended, the message starts a new turn. Messages sent close together may merge.
- **Silent context:** `shouldQuery: false` appends context without starting a turn.
- **Origin:** set it explicitly. `origin.kind` can be `human`, `peer`, `coordinator`, and others. A message with no origin is "unattributed" (v2.1.210+), and `queued_turn_count` counts only human-origin messages.
- **Receipts:** track `uuid` / `user_message_uuid(s)`.

Sources: [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript), [streaming vs single](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode), [agent loop](https://code.claude.com/docs/en/agent-sdk/agent-loop). *Impact: 0A delivery (D-26).*

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED for delivery timing (next tool boundary mid-turn, new turn when idle, merged when close together), with additions and one contradiction: `priority` `later`/`now` exist; `command_lifecycle` frames are the receipt; **`origin` is not model-visible** (C-14); injected text is expanded unless `client_composed: true` (C-15). (SP-02)

*0A item 5, 2026-10-03, SDK 0.3.287 type definitions:* `origin.kind` is typed as `human`, `channel`, `peer` or `task-notification`; there's no `coordinator`. The adapter sends harness notices as `peer` from `harness`, which changes nothing the model sees (C-14). A session-wide `verbatimPrompts` option sets `client_composed` on every message; the adapter sets both (D-63, D-77). Re-tested end to end through `ClaudeAdapter` (`packages/adapters/test/session.test.ts`): a mid-tool injection rode in with that tool's result and an idle one opened a new turn, each with a `command_lifecycle` `started` receipt.

**F-03 ✔✔ `interrupt()` doesn't cancel queued messages.**
- In TS it returns `{still_queued, cancelled?}`.
- Messages that aren't cancelled still run, so re-sending them duplicates them.
- Only a raw control-protocol client can send `cancel_queued`.
- For a clean stop: SIGINT or `interrupt()`, not SIGTERM.
- `close()` kills the subprocess.

Source: [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript).

**F-04 ✔✔ Sessions.**
- `resume`, `forkSession`, `continue`, and a caller-chosen `sessionId`.
- Stored at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`.
- **Never resume one session from two processes**; the transcripts interleave.
- A session that ended inside a worktree resumes into it, and can be refused (`worktree_unverified`).

Sources: [sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [CLI sessions](https://code.claude.com/docs/en/sessions).

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED: harness-chosen IDs, the transcript path, resume from another process. A killed tool call is closed as "interrupted, outcome unknown". Resume needs the same `CLAUDE_CONFIG_DIR`, and it **does** resume into a different `cwd`. (SP-07)

**F-05 ✔✔ Hooks: exactly 33 events, same JSON in the CLI and the TS SDK.**
- **Deny:** `PreToolUse` `permissionDecision: deny` (or exit 2). The reason is shown to Claude.
- **Context:** `additionalContext` on PreToolUse, PostToolUse, PostToolBatch, UserPromptSubmit, SessionStart, Stop and others. It arrives as a system reminder, **capped at 10,000 characters**.
- **Timeout behavior differs by event.**
  - SDK in-process callbacks **fail closed** only on a **PreToolUse** or **UserPromptSubmit / UserPromptExpansion** timeout.
  - A **PostToolUse** callback that times out keeps the tool result, and the turn continues.
  - A **Stop** callback that times out counts as no decision, so the agent stops.
  - So capture and keep-alive hooks fail **open** even in-process.
  - In-process callbacks keep running even under a managed `disableAllHooks` / `allowManagedHooksOnly`.
  - (The PostToolUse/Stop timeout behavior is from the citation critic's check of the SDK hooks page, "Hook timeout", 2026-10-01.)
- **Precedence:** deny wins even in `bypassPermissions`. A hook `allow` doesn't override deny or ask rules.

Sources: [hooks](https://code.claude.com/docs/en/hooks), [SDK hooks](https://code.claude.com/docs/en/agent-sdk/hooks).

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* PARTIAL: PreToolUse timeout fails closed, and PostToolUse/Stop fail open as stated. But a PreToolUse callback that **throws fails open** (C-16). The Stop cap of 8 was confirmed. (SP-10)

**F-06 ✔✔ Command, HTTP and MCP-tool hooks fail open.**
- These all let the call proceed: exit 1 without valid JSON, a timeout, a missing script (127), or an HTTP non-2xx or connection failure.
- The docs say to use permission rules for hard allow and deny.

Source: [hooks](https://code.claude.com/docs/en/hooks). *Impact: D-47.*

**F-07 ✔✔ Hook input payloads.**
- **Common fields:** `session_id`, `cwd`, `permission_mode`, `agent_id` (in subagents), `tool_name`, `tool_input`, `tool_use_id`.
- **Paths:** `Read`/`Edit`/`Write` `file_path` is always **absolute**.
- **Search inputs:** `Grep {pattern, path, glob, output_mode}`, `Glob {pattern, path}`. Bash gives `{command}`.
- **Responses:** PostToolUse adds `tool_response`. Read's structured output is documented (`FileReadOutput`).
- **`bashEditDiff`** (v2.1.269+, public beta per the hooks reference) is a best-effort Bash **write** list, at most 200 paths.
  - It's recorded only in auto or bypass mode **unless `bashEditDiffEnabled` is set**, so the harness must set it, since it forbids auto mode.
  - It's meant "to find what to review, not to enforce a policy".

Sources: [hooks](https://code.claude.com/docs/en/hooks), [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript).

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED: absolute paths. `bashEditDiff` arrives in `tool_response` with `files[]`/`changedFiles` in `dontAsk` mode when `bashEditDiffEnabled` is set via the SDK's `settings` (flag) channel. Background-process writes are missed. (SP-03)

**F-08 ✔✔ Gaps in read capture.**
- **Repeated reads:** an identical repeated Read of an unchanged file returns `file_unchanged` with **no content** (`source: 'seeded'` for CLAUDE.md and memory). The dedup is controlled per session by a remote flag, per GitHub issue #88118 (2°).
- **Not seen by Read hooks:** @-mentioned files and IDE context; instructions files (use `InstructionsLoaded`, which doesn't fire for AGENTS.md loaded through the "Project instructions" setting); and shell reads (the command string only).
- **Read-only Bash commands** run without a prompt in every mode.
- **Grep `files_with_matches`** shows matches, not the set of files scanned.

Sources: [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript), [tools reference](https://code.claude.com/docs/en/tools-reference), [issue #88118](https://github.com/anthropics/claude-code/issues/88118). *Impact: hash reads from disk; read sets are best-effort (D-23).*

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED: the repeated-read stub `file_unchanged`. `@`-mentions fire no tool hook. Grep `content` mode returns empty structured `filenames`. (SP-04)

**F-09 ✔✔ Stop hook.**
- `decision: "block"` plus a `reason` keeps the agent working.
- The input carries `stop_hook_active`.
- **Capped at 8 consecutive continuations** (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`; 0 disables the cap). The cap applies to Stop and SubagentStop.

Source: [hooks](https://code.claude.com/docs/en/hooks).

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED: `block` continues, capped at 8 consecutive. (SP-10)

**F-10 ✔✔ Mid-turn context.**
- PostToolUse / PostToolBatch `additionalContext` is read on the next model request.
- **The docs warn** that text framed as out-of-band system commands can trigger Claude's prompt-injection defenses. **Write injected text as factual statements.**
- Injected context is replayed from the transcript on resume, not recomputed.

Source: [hooks](https://code.claude.com/docs/en/hooks). *Impact: envelope wording ([protocol.md §8](../protocol.md#8-peer-message-envelope)).*

**F-11 ✔✔ Permissions.**
- **Evaluation order:** hooks → deny → ask → mode → allow → `canUseTool`.
- **Always pass `permissionMode` explicitly.** If it's omitted, the session can start in **auto** mode, which drops broad allow rules, and its classifier calls are **excluded from cost and usage totals**.
- **Deny at any level** can't be overridden.
- **Rule coverage:**
  - `Read(...)` rules cover Read, Grep, Glob and LSP.
  - `Edit(...)` rules cover Edit and Write.
  - A Read deny also blocks Edit and Write on the same path.
  - Write, Glob and NotebookEdit path rules are never consulted.
- **`--settings`** ranks above project and local settings. Use `//absolute` paths in it, because `/path` anchors at the settings file.
- **Project allow rules** are ignored in `-p`/SDK for untrusted folders (deny and ask rules still apply).
- **Writes to protected paths** (`.claude`, `.git`, `.mcp.json`, shell rc files and others) are never auto-approved, except under bypass.

Sources: [permissions](https://code.claude.com/docs/en/permissions), [SDK permissions](https://code.claude.com/docs/en/agent-sdk/permissions), [settings](https://code.claude.com/docs/en/settings).

*Spike, 2026-10-02, Claude Code 2.1.287 / SDK 0.3.287:* PARTIAL for the order. A Read under a flag-settings `Read(//…)` deny rule is rejected at input validation, before any hook, and fires no hook event (C-20). (SP-15)

**F-12 ✔✔ ✖ Read deny rules now apply to recognized Bash file commands**, contrary to a commonly assumed limitation.
- **Covered:** `cat`, `head`, `tail`, `sed`, `tee`, and redirect targets.
- **Not covered:** `grep -r .`, scripts, and arbitrary subprocesses.
- **With the sandbox on,** Read and Edit deny rules are merged into OS-level enforcement for Bash. Rules from setting sources that were **excluded** are left out of the sandbox config.
- **Bash permission rules are text matches, not a security boundary.** The docs' own evasion examples include `/bin/rm`, `bash -c …`, `git -C . push` and `git -c … push`.

Sources: [permissions](https://code.claude.com/docs/en/permissions), [sandboxing](https://code.claude.com/docs/en/sandboxing).

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED: `Read(//…)` deny rules passed through the SDK `settings` option reach the OS sandbox even with `settingSources: []`. They block file tools, shell reads (including Python) and `@`-expansion. Sandbox `denyRead` alone covers shell reads only. (SP-13)

**F-13 ✔✔ The sandbox covers Bash, and only Bash.**
- **Platforms:** macOS (Seatbelt), Linux and WSL2 (bubblewrap + socat).
- **Scope:** Bash and its child processes. File tools use permission rules instead.
- **Default reads:** **the whole machine**, including `~/.ssh` and `~/.aws`, unless `denyRead` or `blockReadsOutsideWorkingDirectories` is set.
- **Default writes:** cwd plus added dirs. In a linked worktree it also allows the shared `.git`, **except `hooks/` and `config`**.
- **Protected paths** can't be written.
- **Network:** a hostname proxy with no TLS inspection.
- **Set** `failIfUnavailable: true` and `allowUnsandboxedCommands: false`.

Source: [sandboxing](https://code.claude.com/docs/en/sandboxing).

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED: Bash is confined to the cwd, and reads and network are open or closed as stated (outbound internet blocked by default). In a linked worktree the shared `.git` `refs/`, `objects/`, `worktrees/` and `info/` are writable by default, while `config` and `hooks/` aren't. Local port binding needs `allowLocalBinding`. **The sandbox doesn't confine the file tools** (C-17). (SP-05, SP-08)

**F-14 ✔✔ What a session loads by default.**
- **SDK `settingSources` and headless trust:** by default, `settingSources` loads user, project and local settings, **including the repo's hooks, `.mcp.json` servers and CLAUDE.md**.
  - `-p` and SDK sessions treat the folder as trusted, so **repo-committed hooks run** with the user's full permissions, outside the sandbox.
  - For multi-tenant isolation the docs recommend `settingSources: []` plus `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Auto memory is shared across all worktrees of one repo.
  - The SDK's minimal default system prompt leaves out Claude Code's safety instructions, so use `systemPrompt: {type:'preset', preset:'claude_code'}`.
- **`--restricted`** (v2.1.248+, CLI) is made for evaluation harnesses. It:
  - loads only managed settings plus `--settings`;
  - confines file tools to the working directories;
  - drops command tools unless they're named;
  - refuses bypass mode.

Sources: [SDK + Claude Code features](https://code.claude.com/docs/en/agent-sdk/claude-code-features), [hooks](https://code.claude.com/docs/en/hooks), [headless](https://code.claude.com/docs/en/headless). *Impact: D-45; TH-13.*

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED, and worse than stated: under default sources an **untrusted** folder's hooks (7 events), `.mcp.json` server, **`apiKeyHelper`**, env, skills, agents, commands and instructions all ran or loaded. `settingSources: []` stops all of it. Built-in plugins still load. (SP-06)

**F-15 ✔✔ In-process custom tools.**
- `tool()` + `createSdkMcpServer()` run inside the host process.
- Tool search defers SDK tools by default, so pass `alwaysLoad: true`.
- The first turn waits for SDK servers to connect, up to `MCP_TIMEOUT`.
- The default tool timeout is very long, about 28 hours.

Sources: [custom tools](https://code.claude.com/docs/en/agent-sdk/custom-tools), [MCP](https://code.claude.com/docs/en/agent-sdk/mcp).

**F-16 ✔✔ Usage reporting.**
- The result message has per-turn `usage` (main loop only) and cumulative `modelUsage` / `total_cost_usd`. The cumulative figures include subagents and compaction, and **exclude** auto-mode classifier calls.
- Costs are client-side estimates.

Source: [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking). *Impact: A/B metric M8.*

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED: a turn's `usage` equals the sum of API-reported usage; cost is a list-price estimate. Note: a billing error yields `is_error: true` with `subtype: "success"`. (SP-09)

**F-17 ✔✔ Built-in cross-session messaging** (v2.1.224+, on by default).
- `SendMessage` / `ListAgents` and a per-session inbox socket (`CLAUDE_CODE_MESSAGING_SOCKET`); `-p` sessions bind it too.
- Messages are delivered between tool calls, or start a turn if the session is idle.
- `crossSessionInbound: accept | hold | refuse`.
- Same OS user only (same claude.ai account across machines via Remote Control).
- Messages are labeled as not from the user.

Source: [cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging). *Impact: D-46.*

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED: the inbox socket is bound and its path and token are exported to the agent's shell, but sandboxed Bash can't connect to it. Separate `CLAUDE_CONFIG_DIR`s make peers undiscoverable; `refuse` blocks delivery; disallowing the tools removes them. (SP-08, SP-11)

**F-18 ✔ Agent teams.**
- Experimental, interactive only, one lead, one machine.
- File-locked **task** claims; JSON mailboxes.
- The docs say two teammates editing one file overwrite each other.

Source: [agent teams](https://code.claude.com/docs/en/agent-teams).

**F-19 ✔ (single pass, not re-checked) Agent view / background sessions.** `claude --bg`, `claude agents --json`, automatic worktrees under `.claude/worktrees/`. Overlaps single-user supervision.

Source: research pass only (not independently re-checked). [docs index](https://code.claude.com/docs/llms.txt).

**F-20 ✔ ✖ Claude Code's stale-edit guard was relaxed.**
- **Edits:** since v2.1.208, an Edit to a file that changed on disk goes through if `old_string` still matches exactly.
- **Unread files:** newer models may edit unread files (v2.1.208+) and overwrite them (v2.1.228+). Opus 4.6, Haiku 4.5 and older still require a read first.

Source: [tools reference](https://code.claude.com/docs/en/tools-reference). *Impact: stale-context detection is entirely the harness's job (D-22).*

**F-21 ✔ Claude Code behavior is documented per version.** Many features cite v2.1.19x–2.1.28x; the latest CHANGELOG entry is 2.1.286 and the local install is 2.1.280. *(D-49 draws the conclusion.)*

Sources: [CHANGELOG](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md), [npm](https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest).

**F-22 ✔ Environment and config directory.**
- The TS `env` option replaces the environment.
- **A per-agent `CLAUDE_CONFIG_DIR` re-keys the macOS Keychain entry**, which breaks subscription login.

Sources: [TS reference](https://code.claude.com/docs/en/agent-sdk/typescript), [authentication](https://code.claude.com/docs/en/authentication).

*Spike, 2026-10-01, Claude Code 2.1.287 / SDK 0.3.287:* VERIFIED that `env` replaces the environment. With API keys (D-56), a per-agent `CLAUDE_CONFIG_DIR` works and isolates sessions (D-65). The Keychain caveat applies to subscription mode only. **The auth variable is visible to the agent's shell** unless `sandbox.credentials.envVars` denies it (C-18). (SP-08)

**F-23 ✔✔ Raw `claude -p` stream-json** works for multi-message sessions, but the control protocol has **no standalone spec**. Resume doesn't restore `--settings`, `--mcp-config`, `--add-dir` or `--fallback-model`. Prefer the TS SDK.

Sources: [CLI reference](https://code.claude.com/docs/en/cli-reference), [headless](https://code.claude.com/docs/en/headless).

**F-24 ✔ Auth headers and `apiKeySource` behind a custom endpoint** (checked 2026-10-03).
- `ANTHROPIC_API_KEY` is sent as `X-Api-Key`; `ANTHROPIC_AUTH_TOKEN` as `Authorization: Bearer`. An `apiKeyHelper`'s output goes in both headers.
- The SDK's `apiKeySource` values are `'ANTHROPIC_API_KEY' | 'apiKeyHelper' | '/login managed key' | 'none'`. The type's own doc says `'none'` covers "claude.ai OAuth login, a bearer token, or a third-party cloud provider".
- When `ANTHROPIC_API_KEY` is set, `apiKeySource` is `'ANTHROPIC_API_KEY'` whatever the base URL. Setting both variables to one key is the documented pattern for bearer gateways ("the copy in x-api-key is ignored"); the CLI then warns about two credential sources.
- A custom `ANTHROPIC_BASE_URL` still counts as the first-party provider inside the CLI (◐, from the binary).

Sources: [env vars](https://code.claude.com/docs/en/env-vars), [LLM gateway: connect](https://code.claude.com/docs/en/llm-gateway-connect), [authentication](https://code.claude.com/docs/en/authentication); pinned `sdk.d.ts` (`ApiKeySource`). *Impact: D-87, C-21.*

*Probe, 2026-10-03, Claude Code 2.1.287 / SDK 0.3.287, scripted mock (`packages/adapters/test/provider.test.ts`):* VERIFIED. `ANTHROPIC_AUTH_TOKEN` alone gives `apiKeySource: 'none'` with `accountInfo().tokenSource: 'ANTHROPIC_AUTH_TOKEN'` and only a bearer header. Both variables set give `apiKeySource: 'ANTHROPIC_API_KEY'` and send both headers to the configured host. A base URL with a path (`/anthropic`) is honoured. The warm-up `HEAD /api/hello` carries no credential.

**F-25 ✔ Model variables behind a custom endpoint.**
- `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` set what the aliases resolve to; the Haiku one is "also used for background functionality" (summaries, titles, classifiers). `ANTHROPIC_SMALL_FAST_MODEL` is deprecated. `CLAUDE_CODE_SUBAGENT_MODEL` sets subagent and workflow models.
- Behind `ANTHROPIC_BASE_URL`, the background model is **the main model** unless `ANTHROPIC_DEFAULT_HAIKU_MODEL` is set; default Haiku is used only with an Anthropic Console key (`sk-ant-api…`) and no `ANTHROPIC_AUTH_TOKEN` (the prefix test is ◐, from the binary).
- Model ids aren't validated up front: a bad id fails on the first request.

Sources: [model config](https://code.claude.com/docs/en/model-config), [env vars](https://code.claude.com/docs/en/env-vars), [LLM gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol). *Impact: pin every tier to the configured model, or opus-named aliases bill at another model's price.*

**F-26 ✔ What the CLI sends for a model id it doesn't know.**
- Unknown ids behind a base URL get what current Claude models accept: adaptive `thinking`, effort (`output_config`) and `context_management`. The CLI retries automatically when a provider rejects `thinking` or effort, but **not** `context_management` or tool-schema fields.
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` strips pre-release `anthropic-beta` values and their fields: `context_management`, tool `strict` / `defer_loading` / `eager_input_streaming`, `output_config.format` (2.1.287+), `task_budget`. It keeps effort and adaptive thinking.
- Unknown ids assume a 200K context (1M with a `[1m]` suffix) and 32,000 output tokens. `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` override them. `ANTHROPIC_DEFAULT_*_SUPPORTED_CAPABILITIES` has no effect behind a base URL.

Sources: [LLM gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [env vars](https://code.claude.com/docs/en/env-vars).

*Probe, 2026-10-03, 2.1.287, scripted mock:* VERIFIED. For `deepseek-flash` the CLI sends `thinking: {type: 'adaptive'}`, `output_config: {effort: 'high'}`, `max_tokens: 32000` and `context_management`, with nine `anthropic-beta` values. `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` removes `context_management` and cuts the betas to four (`claude-code`, `interleaved-thinking`, `mid-conversation-system`, `effort`); a strict endpoint then accepts every request. A `[1m]` suffix is stripped on the wire and adds the `context-1m` beta; `init.model` keeps the suffix.

**F-27 ✔ Cost for unknown models is a guess.** `modelUsage[id].costBasis` is `'list' | 'managed' | 'unknown'`. For `'unknown'`, `costUSD` (and so `total_cost_usd` and the `maxBudgetUsd` cap) is "a guess at the default model's rate". `modelPricing` is ignored in `--settings`.

Sources: pinned `sdk.d.ts` (`ModelUsage`), [cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking), [settings](https://code.claude.com/docs/en/settings). *Impact: M8 needs harness-side pricing for non-Anthropic models (D-87).*

*Probe, 2026-10-03, 2.1.287, scripted mock:* VERIFIED. An unknown id gets `costBasis: 'unknown'` priced at $5 in / $25 out per million tokens, about 17 to 21 times DeepSeek's `deepseek-flash` rates. `claude-haiku-4-5` gets `costBasis: 'list'` at its real $1 / $5. With no model configured, the default model on an API key is `claude-opus-5-5`.

**F-28 ✔ Other endpoints the CLI contacts.**
- `/v1/messages` and the optional `/v1/messages/count_tokens` go to `ANTHROPIC_BASE_URL`; so does a `HEAD /api/hello` warm-up, skipped when an HTTP proxy is set. `GET /v1/models` only with `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`.
- Feature flags, event logging and Datadog go to Anthropic or Datadog hosts, **never** the base URL, and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` turns them off (the adapter sets it). Whether it also stops the model-catalog fetch from `downloads.claude.ai` is ?.

Sources: [LLM gateway protocol](https://code.claude.com/docs/en/llm-gateway-protocol), [network config](https://code.claude.com/docs/en/network-config), [data usage](https://code.claude.com/docs/en/data-usage). *Impact: spike unknown U-4: the mock never saw flag requests because they're turned off, not because the mock lacks them.*

**F-29 ✔ `CLAUDE_CODE_EXTRA_BODY`** is a JSON object merged into the top level of every request body. `ANTHROPIC_CUSTOM_HEADERS` (2.1.227+) adds headers. `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS` arrived in 2.1.288, after the pin.

Sources: [env vars](https://code.claude.com/docs/en/env-vars), [CHANGELOG](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md).

*Probe, 2026-10-03, 2.1.287, scripted mock:* VERIFIED: `{"provider": {"allow_fallbacks": false}}` arrives as a top-level `provider` field. Model ids with `/` and `:` (`qwen/qwen3.8-27b:free`) pass through unchanged.

**F-78 ✔ The pinned CLI is a Bun-compiled binary, and Bun's own environment variables work on it** (2.1.287, checked 2026-10-03 by the D-87 review). `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` is a Bun 1.4.3 compiled Mach-O (its fetches send `User-Agent: Bun/1.4.3`). Probed with a dummy key: `BUN_OPTIONS="--preload ./setup.js"` ran a file from the working directory inside the CLI process, before `init` and outside the sandbox, with the key in its environment; `BUN_CONFIG_VERBOSE_FETCH=curl` printed every request's `x-api-key` header to stderr.

Source: the D-87 adversarial review's probes against the pinned binary. *Impact: TH-21; `BUN_*` is a reserved secret prefix (D-90).*

**F-97 ✔ The Bash tool's working directory carries over between commands, unless `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`** (2.1.287, checked 2026-10-03). By default, `cd sub` in one Bash call leaves the next call in `sub`. With the variable set, every call starts in the session's project directory (the worktree). The PostToolUse input names only the command, not the directory it ran in.

Source: the variable is in the pinned binary's env-var list and the [env vars](https://code.claude.com/docs/en/env-vars) page. *Probe, 2026-10-03, 2.1.287, scripted mock:* VERIFIED. `cd sub && pwd` then `pwd` printed `…/wt/sub` twice without the variable, and `…/wt/sub` then `…/wt` with it. *Impact: shell-read capture resolves relative paths against the worktree (D-91), so the adapter sets the variable.*

## OpenAI Codex

*Docs moved: `developers.openai.com/codex/*` now 308-redirects to `learn.chatgpt.com/docs/*`.*

**F-30 ✔ Current version** is 0.159.3 (CLI, TS SDK and Python SDK, 2026-09-30); 0.161 alphas are already out.
- In 2026, releases removed or retired flags and policies (F-31, F-37, F-40), and profile handling changed (F-42). The app-server docs say it "may change without notice".

Sources: [releases](https://github.com/openai/codex/releases), [npm](https://registry.npmjs.org/@openai/codex-sdk), [app-server](https://learn.chatgpt.com/docs/app-server).

**F-31 ✔✔ `codex exec --json`.**
- **Events:** `thread.started`, `turn.started`, `turn.completed{usage}`, `turn.failed`, `item.*`.
- **Items:** `command_execution{command, aggregated_output, exit_code}`, `file_change{changes[{path, kind}]}`, `mcp_tool_call`, `agent_message`, `reasoning`, `todo_list`, `collab_tool_call`.
- **Missing:** cwd, parsed read paths and diffs.
- **Resume:** `codex exec resume <thread_id> "<prompt>"`.
- **Defaults:** the exec sandbox is read-only, and a Git repo is required.
- **Checker corrections (source at tag `rust-v0.159.3`):**
  - **`--full-auto` was removed** in 0.147.0. The docs still describe it as deprecated, so they're stale. Never emit it.
  - **`--worktree` exists** ("Run the session in a new managed Git worktree"). `harnessd` must not pass it, or must reconcile with Codex-managed worktrees.
  - **`--approve-for-me`** (alias `--not-so-yolo`) turns on `auto_review` + `on-request` + `workspace-write`.
  - **`exec fork <id>`** exists.

Sources: [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [exec_events.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/exec_events.rs).

**F-32 ✔✔ In `exec`, approval requests are rejected,** and the approval policy is forced to `never` unless `approvals_reviewer=auto_review`. SIGINT becomes a graceful interrupt.

Source: [exec/src/lib.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs) (source, not docs; confirmed by the checker at v0.159.3).

**F-33 ✔✔ The TS SDK runs one `codex exec … resume` process per turn.**
- Follow-ups only between turns; no steer or inject.
- `AbortSignal` kills the process with SIGTERM.
- Its `ApprovalMode` type still offers the retired `untrusted`.

Sources: [sdk/typescript](https://github.com/openai/codex/tree/main/sdk/typescript).

**F-34 ✔✔ The app-server (JSON-RPC) and the Python SDK built on it.**
- **Steering and injection:** `turn/steer` (append to the running turn), `turn/interrupt`, `thread/inject_items`; `turn/start` with `toolOutput` joins an active turn.
- **`ExternalMessage`** injects untrusted content **with tool-level authority**, below user instructions.
- **Approvals** arrive as server requests that the host answers.
- **More methods:** `thread/start|resume|fork`, and `thread/tokenUsage/updated` notifications.
- **Types:** version-matched TypeScript and JSON schemas come from `codex app-server generate-ts` / `generate-json-schema`.
- **Reads:** `commandActions` gives best-effort parsed `{type: read, path}`.
- **Caveat:** the app-server page itself says the command and WebSocket transport "are experimental and aren't supported for production workloads".
- **More injection channels:** `turn/steer` needs `expectedTurnId`. `turn/start` and `turn/steer` also take an experimental `additionalContext` map keyed by source ID, a structured channel for injecting at turn boundaries.
- **Python SDK default:** `ApprovalMode.auto_review`, which adds a reviewer agent and model spend, and doesn't surface approvals to the host.

Sources: [app-server](https://learn.chatgpt.com/docs/app-server), [Python SDK](https://github.com/openai/codex/blob/main/sdk/python/README.md).

**F-35 ✔✔ Codex hooks are GA** (around 2026-05-14, on by default).
- **Events:** SessionStart/End, SubagentStart/Stop, PreToolUse, PermissionRequest, PostToolUse, PreCompact/PostCompact, UserPromptSubmit, Stop, Interrupt.
- **Behavior:**
  - PreToolUse deny (`permissionDecision: deny`, exit 2) or rewrite;
  - PostToolUse `additionalContext` (about 2,500 tokens) or block;
  - Stop `decision: block` continues with the reason as a new prompt.
- **They fail open.** The docs call them "a guardrail, not an enforcement boundary".

Source: [hooks](https://learn.chatgpt.com/docs/hooks).

**F-36 ✔✔ Codex hook trust.** Non-managed hooks must be trusted by **hash**. New or changed hooks are skipped until trusted, or until `--dangerously-bypass-hook-trust` is passed. `allow_managed_hooks_only` can disable non-managed hooks entirely.

Source: [hooks](https://learn.chatgpt.com/docs/hooks).

**F-37 ✔✔ ✖ Approval policies** are `on-request | never | {granular…}`. **`untrusted` was retired** in 0.149.0 (and can stop Codex from starting); `on-failure` is deprecated.

Sources: [config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [v0.149.0](https://github.com/openai/codex/releases/tag/rust-v0.149.0).

**F-38 ✔✔ Codex sandbox and permission profiles** (the last bullet's commit claim is an inference, ◐).
- **Modes:** read-only, workspace-write, danger-full-access.
- **Platforms:** macOS Seatbelt; Linux bwrap + seccomp (Landlock as a fallback); a native Windows sandbox.
- **Network** is off by default.
- **Default read access is the whole filesystem.** Least-privilege reads need **permission profiles** (beta, with deny-read), which are **ignored if `--sandbox` / `sandbox_mode` is set**.
- **Inside writable roots,** `.git`, the resolved gitdir, `.codex` and `.agents` stay read-only. So agents in linked worktrees probably can't commit (an inference; to be tested).

Sources: [sandboxing](https://learn.chatgpt.com/docs/sandboxing), [permissions](https://learn.chatgpt.com/docs/permissions), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference).

**F-39 ✔✔ ◐ Codex read capture.** (The fact is double-checked; the capability itself is only partial.)
- There's no read tool, so reads happen through shell commands.
- `exec --json` exposes command strings only; the app-server exposes best-effort parsed read paths.
- Reads inside scripts, builds and pipelines are invisible.
- Full fidelity would need OS-level tracing.

Sources: [parse_command.rs](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/parse_command.rs), [app-server](https://learn.chatgpt.com/docs/app-server).

**F-40 ✔✔ ✖ MCP.** Codex is an MCP **client** (`[mcp_servers]`). `codex mcp-server` was **removed** in 0.154.0.

Sources: [MCP](https://learn.chatgpt.com/docs/extend/mcp), [v0.154.0](https://github.com/openai/codex/releases/tag/rust-v0.154.0).

**F-41 ✔✔ AGENTS.md.**
- **Discovery:** global, then project files root to cwd, closer files winning, 32 KiB cap.
- **Extra instructions:** `-c developer_instructions` adds instructions without touching the repo.
- **Untrusted projects** skip the project AGENTS.md.

Source: [AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

**F-42 ✔✔ Config.**
- `-c key=value` overrides are repeatable.
- Profiles are separate `$CODEX_HOME/<name>.config.toml` files since 0.134.0; old `[profiles.x]` tables are silently ignored.
- `--strict-config` catches drift.
- Managed `requirements.toml` can override harness settings.
- **Codex can import Claude Code config.** App-server `externalAgentConfig` imports AGENTS.md, hooks and MCP server config, so it must not pick up repo Claude config either (D-45).

Source: [config](https://learn.chatgpt.com/docs/config-file/config-advanced).

**F-43 ◐ Codex usage.** `turn.completed.usage` holds **running totals**; compute deltas. Whether totals carry across a resumed process wasn't verified.

Source: [event_processor_with_jsonl_output.rs](https://github.com/openai/codex/blob/main/codex-rs/exec/src/event_processor_with_jsonl_output.rs).

**F-44 ◐ Codex has no stale-read check.** `apply_patch` locates hunks by context and falls back to whitespace-insensitive matching.

Source: [seek_sequence.rs](https://github.com/openai/codex/blob/main/codex-rs/apply-patch/src/seek_sequence.rs).

## Infrastructure

**F-50 ✔✔ GitHub merge queue availability.**
- **Available:** any **public repo owned by an organization**, or **private repos in orgs on GitHub Enterprise Cloud**. On GHES, any org-owned repo.
- **Not available:** personal-account repos, or private repos on Free or Team.

Source: [docs source](https://raw.githubusercontent.com/github/docs/main/data/reusables/gated-features/merge-queue.md). *Impact: [Q-11](../open-questions.md#q-11); D-51 fallback uses GitHub's own required checks + "require up to date" + auto-merge, not a harness-run merge train.*

**F-51 ✔✔ Merge-queue triggers.**
- Required checks must also run on `merge_group` (`types: [checks_requested]`).
- Third-party CI builds `gh-readonly-queue/{base}` branches.

Source: [managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).

**F-52 ✔✔ Configuring the queue.**
- Required through branch protection or a **repo-level** ruleset. Not org-level rulesets, and not wildcard branch patterns.
- `enqueuePullRequest` takes `expectedHeadOid`.

Source: same as F-51; [rulesets](https://raw.githubusercontent.com/github/docs/main/content/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets.md).

**F-53 ◐ Merge-queue incident on 2026-04-23.** Squash merges in multi-PR groups reverted earlier PRs' changes, affecting 230 repos and 2,092 PRs, per GitHub's community incident thread. *Impact: verify that the base contains each PR's diff after a merge.*

Source: [discussion #193645](https://github.com/orgs/community/discussions/193645).

**F-54 ✔✔ Postgres `NOTIFY`.**
- **Payload** must be under 8000 bytes.
- **Delivery** happens only at commit and only between transactions.
- **Not durable:** delivered to each client that has previously executed `LISTEN` (and is still connected), and "not expected to survive database crashes".
- **Queue** is 8 GB; when it's full, commits fail.
- **LISTEN** isn't supported under PgBouncer transaction pooling, and doesn't work on hot standbys.

Sources: [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html), [LISTEN](https://www.postgresql.org/docs/current/sql-listen.html), [PgBouncer](https://www.pgbouncer.org/features.html).

**F-55 ✔✔ Every transaction that NOTIFYs takes a cluster-wide lock at commit,** so those commits are serialized (seen in source). PG19 reduces wake-ups but keeps the lock.

Sources: [async.c (18)](https://raw.githubusercontent.com/postgres/postgres/REL_18_STABLE/src/backend/commands/async.c), [async.c (master)](https://raw.githubusercontent.com/postgres/postgres/master/src/backend/commands/async.c), [PG19 release notes (draft)](https://www.postgresql.org/docs/19/release-19.html), [Recall.ai (2°)](https://www.recall.ai/blog/postgres-listen-notify-does-not-scale). *Impact: one coalesced NOTIFY per transaction at most.*

**F-56 ✔✔ Sequence numbers and cursors** (the counter-row ordering property is ◐, inferred from lock semantics).
- **The problem:** `nextval` is non-transactional, so a `bigserial` cursor can permanently skip events that commit late.
- **The fix:** a per-project counter row (`UPDATE … RETURNING`) in the append transaction gives dense seqs that are commit-ordered per project, at the cost of serializing writers per project. That property is inferred from row-lock semantics.
- **The alternative:** an xid8 "safe horizon", which is cluster-wide and can stall the feed.

Sources: [sequence functions](https://www.postgresql.org/docs/current/functions-sequence.html), [Sequin (2°)](https://blog.sequinstream.com/postgres-sequences-can-commit-out-of-order/), [Cybertec (2°)](https://www.cybertec-postgresql.com/en/gaps-in-sequences-postgresql/).

**F-57 ✔✔ Git worktrees.**
- **Branches:** a branch can be checked out in one worktree at a time. Pass an explicit base SHA; Git 2.56 fixed a `-b` DWIM bug, and the local Git is 2.50.1.
- **Shared state:** **objects, refs, config and hooks are shared** across worktrees; HEAD and the index are per worktree.
- **Submodules:** support is "incomplete".
- **Cleanup:** `remove` needs `--force` for dirty or submodule worktrees. `prune` only cleans entries whose directories are gone.

Sources: [git-worktree](https://git-scm.com/docs/git-worktree), [gitrepository-layout](https://git-scm.com/docs/gitrepository-layout). *Impact: D-50; TH-14.*

**F-58 ◐ `srt` loopback binding is wider than loopback** (srt 0.0.78, macOS, from reading the source; checked 2026-10-03). `network.allowLocalBinding: true` emits `(allow network-bind (local ip "*:*"))`, `(allow network-inbound (local ip "*:*"))` and `(allow network-outbound (remote ip "localhost:*"))`. So a sandboxed process may bind any interface and accept inbound connections from anywhere, while its outbound traffic is limited to localhost (plus the proxy's allowed domains).

Source: `@anthropic-ai/sandbox-runtime` 0.0.78, `macos-sandbox-utils.js`. *Impact: the land step's test sandbox (D-83): a test server bound to `0.0.0.0` is reachable from the LAN while tests run.*

## Model providers (Anthropic-compatible endpoints)

Checked 2026-10-03, one research pass over each provider's official docs (D-87). Prices and model lists change often: re-check before relying on them.

**F-72 ✔ DeepSeek's Anthropic-compatible API.**
- **Endpoint:** `https://api.deepseek.com/anthropic`. It accepts the key as `x-api-key` and as a bearer token (both answered 401 with the key's tail when probed with fake keys, so both headers are read).
- **Models:** `deepseek-flash` is DeepSeek-V4.1-Flash (released 2026-09-10): 1M context, 384K max output, tool calls, thinking on by default. `deepseek-chat` and `deepseek-reasoner` were retired after 2026-07-24. **Any unknown model name maps silently to `deepseek-flash`, and `claude-opus*` names map to `deepseek-v4-pro`** at Pro prices.
- **Compatibility table:** `anthropic-beta` and `anthropic-version` ignored; `cache_control` ignored; `thinking` supported with `budget_tokens` ignored; `output_config` supports only `effort`; `tool_choice` supported with `disable_parallel_tool_use` ignored; `document`, `redacted_thinking`, MCP and code-execution blocks not supported; `mcp_servers` and `container` ignored.
- **Claude Code guide:** sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL=deepseek-flash[1m]`, every `ANTHROPIC_DEFAULT_*_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` to `deepseek-flash`.
- **Known issue:** [claude-code#65863](https://github.com/anthropics/claude-code/issues/65863) (subagents sending thinking disabled plus effort → 400) was closed for inactivity, not fixed. Subagents are removed in harness sessions (D-66).

Sources: [Anthropic API guide](https://api-docs.deepseek.com/guides/anthropic_api), [Claude Code integration](https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code), [models and pricing](https://api-docs.deepseek.com/quick_start/pricing), [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode).

**F-73 ◐ DeepSeek pricing and billing** (volatile).
- `deepseek-flash`, USD per 1M tokens, peak: input $0.30 (cache miss), $0.006 (cache hit); output $1.20. Off-peak is half: peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday. Caching is automatic; `cache_control` is ignored.
- **Prepaid:** a 402 means insufficient balance. Keys at [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys), top-up at [platform.deepseek.com/top_up](https://platform.deepseek.com/top_up).
- **Limits:** concurrency-based, 2,500 concurrent requests per account for flash; no RPM or TPM limit documented.

Sources: [pricing](https://api-docs.deepseek.com/quick_start/pricing), [error codes](https://api-docs.deepseek.com/quick_start/error_codes), [rate limit](https://api-docs.deepseek.com/quick_start/rate_limit).

**F-74 ✔ OpenRouter's Anthropic-compatible endpoint.**
- **Endpoint:** `https://openrouter.ai/api` (requests go to `/api/v1/messages`). Its guide uses `ANTHROPIC_AUTH_TOKEN` (bearer) and says `ANTHROPIC_API_KEY` must be explicitly empty. Whether it also accepts `x-api-key` is ?.
- **Official position:** "Claude Code with OpenRouter is only guaranteed to work with the Anthropic first-party provider"; the blog says non-Anthropic models "aren't supported through the native endpoint". Anthropic's docs say the same of any gateway. The API itself accepts any model id.
- **Pinning:** no model fallback unless the request sends `models` or `fallbacks`; provider fallback is on by default and is turned off with `provider: {allow_fallbacks: false}` in the body (through `CLAUDE_CODE_EXTRA_BODY`, ◐). Router ids (`openrouter/auto`, `openrouter/free`, `~…-latest`) pick models and must not be used for the A/B (D-87).
- Keys at [openrouter.ai/settings/keys](https://openrouter.ai/settings/keys); the docs name the variable `OPENROUTER_API_KEY`.

Sources: [Claude Code integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md), [messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message.md), [model fallbacks](https://openrouter.ai/docs/guides/routing/model-fallbacks.md), [provider selection](https://openrouter.ai/docs/guides/routing/provider-selection.md).

*Re-checked 2026-10-04: F-111 (the model list, pinning a provider, both auth headers documented) and F-112 (the Claude Code guarantee is unchanged).*

**F-75 ◐ OpenRouter free models** (volatile; from the live model list, 2026-10-03).
- 17 `:free` models; none is a DeepSeek, Kimi, GLM or Qwen-Coder model. Tool-capable ones with at least 64K context include `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `cohere/north-mini-code:free` and `google/gemma-4-31b-it:free`, each served by one provider.
- **Free limits:** 20 requests a minute; 50 a day with under $10 of credits ever bought, 1,000 a day above that. Claude Code's background calls count too.

Sources: `GET https://openrouter.ai/api/v1/models?supported_parameters=tools`, [limits](https://openrouter.ai/docs/api_reference/limits.md).

**F-76 ✔ Kimi (Moonshot) Anthropic-compatible endpoint.**
- **Endpoint:** `https://api.moonshot.ai/anthropic` (mainland China: `api.moonshot.cn`); bearer via `ANTHROPIC_AUTH_TOKEN`. Keys are tied to their platform, at [platform.kimi.ai/console/api-keys](https://platform.kimi.ai/console/api-keys); the docs name the variable `MOONSHOT_API_KEY`.
- **Models:** the cheapest with tool calls is `kimi-k2.6` (262K context; $0.95 in, $4.00 out per 1M tokens), which accepts only `tool_choice` `auto` or `none`. The messages API reference lists only `kimi-k3` as an allowed model, so whether `kimi-k2.6` works on the Anthropic endpoint is ?.
- **Limits:** a $1 top-up gives 3 requests a minute; $10 gives 100 a minute.

Sources: [Claude Code guide](https://platform.kimi.ai/docs/guide/claude-code-kimi.md), [models](https://platform.kimi.ai/docs/models.md), [pricing](https://platform.kimi.ai/docs/pricing/chat.md), [limits](https://platform.kimi.ai/docs/pricing/limits.md), [messages API](https://platform.kimi.ai/docs/api/messages.md).

**F-77 ✔ Anthropic Haiku 4.5** (for the later comparison, D-87). Model id `claude-haiku-4-5`: 200K context, $1 in and $5 out per 1M tokens, endpoint `https://api.anthropic.com` with `x-api-key`. Keys at [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys). Haiku 4.5 still requires a Read before an Edit (F-20).

Source: Anthropic model reference (cached 2026-09-25 in the claude-api skill), [models overview](https://docs.anthropic.com/en/docs/about-claude/models/overview).

## Vendor terms (not legal advice)

**F-60 ✔✔ Anthropic's Agent SDK note.** "Unless previously approved", third-party developers may not offer claude.ai login or rate limits in their products, including Agent SDK agents. Use API keys or cloud providers.

Sources: [overview](https://code.claude.com/docs/en/agent-sdk/overview), [quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart).

**F-61 ✔✔ `claude -p` is "the Agent SDK via the CLI".** Switching from the SDK to `-p` doesn't change which rules apply.

Source: [headless](https://code.claude.com/docs/en/headless).

**F-62 ✔✔ Anthropic's Claude Code legal page.**
- **Running Claude Code inside a product** requires the Commercial Terms, plus all of these:
  - an **unmodified binary**;
  - **no built-in auth method removed or restricted**;
  - **no paying for, reselling or intermediating usage**;
  - **each end user signs in with their own credentials**.
- **Developers may not:** collect, store or intermediate claude.ai credentials or tokens; or route requests through Free, Pro or Max credentials on behalf of users.
- **Carve-out:** nothing stops an end user signing in to the **unmodified** binary with their own subscription.
- **Usage expectations:** Pro and Max limits assume "ordinary, individual usage".

Source: [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance).

**F-63 ✔✔ Anthropic Consumer Terms.** Automated access is allowed only via an API key "or where we otherwise explicitly permit it".

Source: [consumer terms](https://www.anthropic.com/legal/consumer-terms).

**F-64 ✔✔ Anthropic support articles.**
- API keys are the preferred route for third-party tools.
- Anthropic may bill third-party tool use to usage credits.
- The planned separate Agent SDK credit was **paused on 2026-06-15**, so SDK, `-p` and third-party app usage still draws from subscription limits.

Sources: [log in article](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account), [Agent SDK with plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

**F-65 ? (2°) Anthropic enforcement in 2026.** (The checker couldn't open a primary source. It's corroborated by The Register and TechCrunch, and by the error text in issue #45134.)
- Jan 9: spoofing blocks.
- Apr 4: third-party harnesses moved to "extra usage". Classifier false positives were reported on the official CLI, with a 400 "Third-party apps now draw from your extra usage" error.

*Impact: detect the error, pause, alert, never retry in a loop.*

The research pass also reported stream-json `system/api_retry` events carrying `billing_error` or `rate_limit`. That wasn't re-checked (◐).

Sources: [The Register](https://www.theregister.com/2026/04/06/anthropic_closes_door_on_subscription/), [TechCrunch](https://techcrunch.com/2026/04/04/anthropic-says-claude-code-subscribers-will-need-to-pay-extra-for-openclaw-support/), [issue #45134](https://github.com/anthropics/claude-code/issues/45134).

**F-66 ✔✔ `--bare` never reads OAuth or the keychain,** and is slated to become the default for `-p`. That would break subscription mode for raw-CLI drivers.

Source: [headless](https://code.claude.com/docs/en/headless).

**F-67 ✔✔ Claude auth precedence.**
- Order: cloud provider > `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` > apiKeyHelper > `CLAUDE_CODE_OAUTH_TOKEN` > /login.
- **Scrub inherited keys** that the user didn't choose for this mode.

Source: [authentication](https://code.claude.com/docs/en/authentication).

**F-68 ✔✔ Codex auth.**
- Supports ChatGPT sign-in and API keys. **API keys are recommended for automation.**
- `codex exec` reuses the saved login by default.
- Keep `CODEX_API_KEY` out of environments where repo-controlled code runs.

Sources: [auth](https://learn.chatgpt.com/docs/auth), [non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode).

**F-69 ✔✔ ChatGPT auth in CI** is an "advanced" path: trusted private runners only, and one machine or serialized job stream per `auth.json`. Concurrent local processes sharing one `auth.json` aren't covered in the docs, so test that.

Source: [CI/CD auth](https://learn.chatgpt.com/docs/auth/ci-cd-auth).

**F-70 ✔✔ Codex app-server auth and plan usage.**
- App-server ChatGPT auth "has never been permitted for commercial or hosted services".
- Local or open-source apps that already use app-server auth "can continue using it" (migrating to SIWC is recommended).
- **"Sign in with ChatGPT"** (launched 2026-09-29) is the sanctioned route for apps that use a user's plan, and it documents a recipe for driving `codex app-server` with the user's SIWC token. It's open to open-source and local projects; commercial use is a limited trial.

Sources: [app-server](https://learn.chatgpt.com/docs/app-server), [SIWC](https://learn.chatgpt.com/docs/sign-in-with-chatgpt).

**F-71 ◐ OpenAI and orchestrators.**
- **Covered by primary sources:** apps that drive **`codex app-server`** (F-70). Commercial or hosted products can't rely on Codex's built-in ChatGPT auth; they use the user's API key, or become a SIWC partner.
- **Not covered:** a daemon spawning **`codex exec`** with the user's own saved `~/.codex/auth.json`.
- **Secondary reports** suggest OpenAI is permissive. Those statements have no contractual force ([manifest.build (2°)](https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/)). OpenAI's Terms of Use pages returned 403 to every fetch, so their clauses couldn't be confirmed.

## Prior art

| F-ID | Fact | Source |
|---|---|---|
| F-80 ✔ | Leases are only safe with **fencing tokens** (monotonic), checked by the resource at the point of effect. Checking expiry before writing doesn't help, because a pause can happen anywhere. | [Kleppmann 2016](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) |
| F-81 ✔ | Chubby: sequencers carry lock generation numbers; "lock-delay" is the fallback for resources that can't check them | [Burrows, OSDI 2006](https://static.googleusercontent.com/media/research.google.com/en//archive/chubby-osdi06.pdf) |
| F-82 ✔ | Optimistic concurrency control validates read sets against concurrent writes before commit. This is the basis for "dependency changed since you read it". | [Kung & Robinson 1981](https://www.eecs.harvard.edu/~htk/publication/1981-tods-kung-robinson.pdf) |
| F-83 ✔ | Deadlock = cycle in the wait-for graph; detection is delayed (`deadlock_timeout`) because it's expensive; cancel one waiter | [Postgres lmgr README](https://github.com/postgres/postgres/blob/master/src/backend/storage/lmgr/README) |
| F-84 ✔ | Leases depend on bounded clock drift, so run all expiry arithmetic on one clock (the server) | [Gray & Cheriton 1989](https://web.eecs.umich.edu/~mosharaf/Readings/Leases.pdf) |
| F-85 ✔ | About a third of merge conflicts are invisible to version control (build or test failures after a clean merge) | [Brun et al. 2011](https://people.cs.umass.edu/~brun/pubs/pubs/Brun11fse.pdf) |
| F-86 ✔ | Most build conflicts come from a declaration removed or renamed by one side and still referenced by the other | [da Silva et al. 2022](https://spgroup.github.io/papers/build-conflicts.html) |
| F-87 ✔ | Generated unit tests caught 9 of 28 semantic conflicts, so landing gates reduce risk; they don't prove correctness | [da Silva et al. 2024](https://arxiv.org/abs/2310.02395) |
| F-88 ✔ (preprint) | Multi-agent LLM coding with perfect textual convergence still had 5–10% semantic conflicts. Parallelism ranged from 21% faster to 39% slower. | [CodeCRDT](https://arxiv.org/abs/2510.18893) |
| F-89 ✔ | MAST failure taxonomy: 14 modes; 32% inter-agent misalignment, 24% verification failures | [Cemri et al. 2025](https://arxiv.org/abs/2503.13657) |
| F-90 ✔ | Multi-agent systems use about 15× the tokens of chat. Coding is less parallelizable than research. | [Anthropic engineering](https://www.anthropic.com/engineering/multi-agent-research-system) |
| F-91 ✔ | Prompt injection can self-replicate across agents ("Prompt Infection"); tagging agent-originated messages helps | [Lee & Tiwari 2024](https://arxiv.org/abs/2410.07283) |
| F-92 ✔ | Multi-agent orchestrators can be hijacked into running arbitrary code (58–90% of trials), even when the individual agents resist injection | [Triedman et al. 2025](https://arxiv.org/abs/2503.12188) |
| F-93 ✔ | OWASP Agentic Top 10 (2026): cross-agent confused deputy and TOCTOU (ASI03); insecure inter-agent communication and replay (ASI07) | [OWASP](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) |
| F-94 ✔ | Tools for dependency tracking: LSP references and call hierarchy; Claude Code's LSP tool (its queries are reads too); tree-sitter tags (syntactic); dependency-cruiser `--affected`; Nx affected; Bazel `rdeps`. **TypeScript 7.0 ships with no compiler API**, so use LSP. | [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/), [dependency-cruiser](https://github.com/sverweij/dependency-cruiser/blob/main/doc/cli.md), [TS 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) |
| F-95 ✔ (preprint) | **Claim Plane** (2026-07): versioned change intents, monotonic fencing tokens, worktree locks, premise invalidation, fail-closed. Tiny evaluation (6 pairs); strict mode removed all parallelism. Closest academic prior art. | [arXiv 2607.21909](https://arxiv.org/abs/2607.21909) |
| F-96 ? | Unread 2026 preprints in this niche: ATM (2607.00041), AgentRoom (2608.23740), concurrency anomalies in multi-agent LLM systems (2606.17182) | Follow-up |

## Facts added during parallel 0B (D-94)
Each stream appends new facts to its own block, so the two never edit the same lines. Use the same format as above: an ID, a confidence mark, the claim, then the source and date. A later docs pass may move them into the topical sections.

### Stream A (Daniyal; F-98 to F-119)
**F-98 ✔ A Read deny rule beats every allow, so a denied directory can't have the worktree carved back out for the file tools** (2.1.287, checked 2026-10-03). With a flag-settings `Read(//home/**)` deny and sandbox `allowRead` on the worktree, Read, Grep and Glob were refused *inside the worktree too* ("File is in a directory that is denied by your permission settings"), while shell reads of the worktree worked. Sandbox `allowRead` doesn't reach the file tools' permission check.

**F-99 ✔ Sandbox `filesystem.allowRead` re-opens paths inside `denyRead` for shell commands, and `denyRead` applies to entries created later** (2.1.287, checked 2026-10-03). Documented in the pinned `sdk.d.ts` ("takes precedence over denyRead for matching paths"; Read deny rules are "merged" into `denyRead`). With `denyRead` on a fake home and `allowRead` on the worktree and the shared `.git`, `cat` of the worktree, `git status`/`log`/`show` and `node` worked, while `cat`, `grep -r` and Python reads elsewhere in the home failed with "Operation not permitted", including a directory created after the session started. Sandbox `denyRead` doesn't restrict the file tools (consistent with SP-13).

**F-100 ✔ Static Read deny rules are resolved, but only cover what existed when they were written** (2.1.287, checked 2026-10-03).
- Per-entry `Read(//entry)`/`Read(//entry/**)` denies blocked Read, Grep and Glob of those entries, including Read through a symlink inside the worktree that points into one (the target is resolved).
- Grep searching from an ancestor skipped denied entries.
- The deny rules also caught a path spelled in another case (on case-insensitive APFS) when it named an existing denied entry; the sandbox caught it for `cat` too.
- But a sibling directory created after the session started was readable through Read and Grep, so a call-time check is needed for the file tools. That check must compare paths in their on-disk case: Node's `fs.realpathSync` keeps the case it's given, and `fs.realpathSync.native` doesn't. T-1 failed with the former, through a mis-cased read of the later sibling.

Source for all three: a probe against the pinned CLI and the scripted mock, a fake home with a canary, sibling worktrees (one created later) and a symlink; four policy variants (D-98). *Impact: D-98's three layers.*
**F-101 ✔ The CLI saves a tool result too big for the conversation to a file in its config dir, and tells the agent to read it there** (2.1.287, checked 2026-10-03). From about 30,000 characters (`seq 1 7000`, 33 KB), the result is replaced by "Output too large … Full output saved to: `<CLAUDE_CONFIG_DIR>/projects/<cwd with non-alphanumerics as ->/<session id>/tool-results/<name>.txt`". The config dir is the agent's own (D-65), inside harness state, so a read policy has to allow that one directory.

**F-102 ✔ A leading `~` is expanded in Read's `file_path` before PreToolUse sees it, but in Grep's and Glob's `path` only after** (2.1.287, checked 2026-10-03). A hook resolving `~/x` relative to the cwd judged a different file than the one the tool then read. `$HOME/...` and `~user` aren't expanded. *Impact: D-98's call-time check refuses any `~` path.*

**F-103 ✔ A `Read(//link/**)` deny rule for a symlink denies wherever the link points** (2.1.287, checked 2026-10-03). The CLI resolves the rule's path, so a symlink in the home directory pointing at the agent's worktree (or out of home) denied that target for Read, Grep and Glob. *Impact: the static deny list skips symlinks.*

**F-104 ✔ Read deny rules reach the sandbox one by one, and travel as one command-line argument** (2.1.287, checked 2026-10-03). With 2,000 rules each Bash call took about 5 s (0.07 s without), and with about 4,300 long paths the settings argument passed 1.3 MB and the session failed to start (`spawn E2BIG`). *Impact: a size budget for the static list, with the call-time check and the sandbox covering the rest.*

**F-105 ✔ Git stops when it can't read a global config file that exists** (Git 2.50, checked 2026-10-03). Under read confinement, a `~/.gitconfig` or `~/.config/git/config` gives "fatal: unable to access …: Operation not permitted" (exit 128) for `status`, `log`, `diff` and the rest. `GIT_CONFIG_GLOBAL=/dev/null` plus `core.excludesFile` and `core.attributesFile` set to `/dev/null` (`GIT_CONFIG_COUNT`) fixes it.

Source for F-101 to F-105: the A3 adversarial review's probes against the pinned CLI and the scripted mock, re-run by its skeptic, and the regression tests that now pin them (`test/security/t1-*.integration.test.ts`).

**F-106 ✔ PostToolBatch `additionalContext` reaches the next model request whole, up to exactly 10,000 characters** (2.1.287, checked 2026-10-03).
- **When:** the hook runs once per batch of tool calls (two parallel Bash calls: one call, listing both), after every result is in and before the next request.
- **How it arrives:** a `system` message right after the tool results, "PostToolBatch hook additional context: <text>". The CLI already sends its own mid-conversation notices (the sandbox description, the token count) this way, also with experimental betas off (`CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`), so it adds no new request shape for a third-party endpoint.
- **Not framed as the user's:** a message injected mid-turn arrives as "The user sent a new message while you were working: …" (C-14). Hook context doesn't.
- **The cap:** 10,000 characters arrived intact. At 10,001 the CLI saved the text to `<config>/projects/<cwd>/<session>/tool-results/hook-…-additionalContext.txt` and sent "Output too large" with a 2 KB preview instead (the same mechanism as F-101).

**F-107 ✔ Stop hook outputs, as the model sees them** (2.1.287, checked 2026-10-03).
- **`additionalContext` continues the turn** (no `decision` needed). It arrives as a user message, "<system-reminder>\nStop hook additional context: <text>\n</system-reminder>".
- **`decision: 'block'`** continues it too. Its reason arrives **twice**: as a plain user message, "Stop hook feedback:\n<reason>" (no system-reminder around it), and then as a `system` message, "Stop:Callback hook blocking error from command: \"callback\": <reason>". So only `additionalContext` keeps a Stop hook's text out of a bare user-role message.
- **`stop_hook_active`** is false on the first Stop of a turn, and true on every later Stop of that turn once one continuation has happened, tool batches in between or not.
- **The cap counts continuations with no tool batch between them:** the CLI starts its count again after every batch. A hook that always returned context, in a turn that ran a tool after each of its first 12 continuations, was called 21 times: 12 with a batch between, then 8 in a row, and the 9th didn't continue.
- **The cap of 8 consecutive continuations (F-09) covers `additionalContext` as well:** a hook that always returned context was called 9 times, and the 9th didn't continue. The pinned binary reads it as `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP ?? 8`.

**F-108 ✔ An interrupt while the PostToolBatch hooks run ends the session's turn with a crash** (2.1.287, checked 2026-10-03). The CLI checks for an abort right after those hooks and before the next request, and an abort that lands during them escapes as `AbortError` (`error_during_execution: [session_crash] error_name=AbortError`). The same interrupt during PostToolUse ends the turn cleanly (`aborted_tools`). A graceful stop then still ends the session as `stopped`; the only effect is one extra error line. Every session registers PostToolBatch (D-99), so this window exists on every tool batch.

Source for F-106 to F-108: probes against the pinned CLI and the scripted mock (in-process SDK callbacks), the 10,000-character boundary tested at 10,000, 10,001 and 12,000, and the A5a review's probes, re-run by its skeptics (the block reason's two copies, the interrupt). F-106 is pinned by `packages/adapters/test/notices.test.ts`, including the exact boundary. *Impact: D-99; the Stop gate (A5b).*
**F-109 ✔ An interactive Claude Code with an API key in its environment asks whether to use it, defaults to no, and then offers a subscription login** (2.1.287, checked 2026-10-04). In a fresh `CLAUDE_CONFIG_DIR` it first runs onboarding (a theme picker), then shows "Detected a custom API key in your environment … Do you want to use this API key?". Pressing Enter declines, and the CLI starts its browser sign-in for a Claude account. The CLI keeps its answers in `$CLAUDE_CONFIG_DIR/.claude.json`: an approved key as its last 20 characters in `customApiKeyResponses.approved`, onboarding as `hasCompletedOnboarding`, and a trusted folder as `projects["<dir>"].hasTrustDialogAccepted`. With those set, the session starts on the key at once ("API Usage Billing"). *Impact: D-102 seeds them; an interactive agent never gets near a subscription login (D-56).*

**F-110 ✔ The CLI warns that a `Write(path)` allow rule isn't matched by file permission checks: only `Edit(path)` rules are, and they cover every file-editing tool** (2.1.287, checked 2026-10-04). Printed at startup for the harness's own allow list. *Impact: the path-scoped `Edit(//<worktree>/**)` rule is what allows writes in the worktree (D-60); the `Write` rule beside it is redundant, and harmless.*

Source for F-109 and F-110: the pinned CLI in a pseudo-terminal against the scripted mock; F-109 is pinned by `test/baseline.integration.test.ts`.

**F-111 ✔ OpenRouter serves DeepSeek V4.1-Flash from 30 providers at different precisions, and one request field pins one** (checked 2026-10-04 from OpenRouter's live API; volatile).
- **The model:** `deepseek/deepseek-v4.1-flash` (released 2026-09-10): 1,048,576 tokens of context, tools, `tool_choice` and reasoning. The listing's price is DeepSeek's own: $0.30 in, $1.20 out and $0.006 for cached input per million tokens (as F-73).
- **Who serves it:** 30 endpoints, from $0.003 to $0.45 per million input tokens. Several are quantized (`fp8`, `fp4`) and others don't say. Default routing chooses among them per request, so the weights behind one model id can change between requests.
- **Pinning:** the Messages API reference (`POST /api/v1/messages`) takes OpenRouter's `provider` object in the body (`only`, `order`, `allow_fallbacks`, `require_parameters`, `quantizations` and more) and up to three `models` fallbacks. `provider = { only = ["<tag>"], allow_fallbacks = false }` keeps every request on one endpoint (DeepSeek's own is tag `deepseek`, 99.99% uptime over 30 minutes when checked). Probed with a live key in F-113.
- **Auth:** the reference lists both `Authorization: Bearer` and `x-api-key`. F-113 confirms the pair the harness sends.
- **Haiku 4.5 on OpenRouter:** `anthropic/claude-haiku-4.5`, 200K context, $1 in, $5 out, $0.10 cached input and $1.25 cache writes per million tokens; served by Anthropic, Amazon Bedrock and Google Vertex.

Sources: `GET https://openrouter.ai/api/v1/models?supported_parameters=tools`, `GET https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints` and `…/anthropic/claude-haiku-4.5/endpoints` (public, no key), [messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-a-message.md). *Impact: D-104's default and its pin.*

**F-112 ✔ OpenRouter still guarantees Claude Code only on Anthropic's own provider** (checked 2026-10-04; re-checks F-74).
- **The guide:** Claude Code with OpenRouter is "only guaranteed to work with the Anthropic first-party provider". It also warns that Claude Code is tuned for Anthropic models and may not work correctly with others, and recommends putting Anthropic first in provider order.
- **Its settings:** `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN` set to the OpenRouter key, and `ANTHROPIC_API_KEY` explicitly empty; `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is optional.
- **The harness differs on one point:** it sets both variables to the key (D-90, C-21), so the check that rules out a subscription login still holds. The CLI then sends the key in both headers. OpenRouter accepts that pair (F-113).

Source: [Claude Code integration](https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration.md). *Impact: D-104's fallback, `openrouter-haiku`.*
**F-113 ✔ OpenRouter with a live key: what reaches the model, and one account setting that blocks a provider** (checked 2026-10-05, with the project's key; pinned CLI 2.1.287).
- **A privacy setting can refuse a provider:** with the account's OpenRouter privacy setting excluding providers that may train on paid inputs, a request pinned to DeepSeek's own endpoint got 404, "0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy". The listed reason was paid model training (account settings), configurable at [openrouter.ai/settings/privacy](https://openrouter.ai/settings/privacy). The endpoints API doesn't show which providers train on inputs.
- **Six other providers answered:** Together, Parasail (fp8), BaseTen (fp8), Fireworks, DeepInfra (fp8) and Novita (fp8) each served `deepseek/deepseek-v4.1-flash` through `provider.only`, with a correct tool call.
- **Auth:** the pair the harness sends, `x-api-key` and `Authorization: Bearer` both carrying the OpenRouter key, is accepted. This settles F-112's question.
- **Through the pinned CLI, with harnessd's policy and experimental betas stripped (on Parasail):**
  - every request was accepted, including the mid-conversation system messages that carry hook context (F-106) and Stop-hook context (F-107);
  - the model used Read and a harness MCP tool, and acted on a notice riding a tool result (PostToolBatch) and on one delivered at the Stop gate.
- **Caching:** about 17,000 to 18,000 cache-read tokens per probe session. Usage arrives in Anthropic's shape, with `cache_read_input_tokens` set and `cache_creation_input_tokens` null (no cache-write charge).
- **One harmless log line:** the CLI logs `[claude-code:unrecognized_model]` for the model id.
- **The first `demo:0b --real`:**
  - two sessions, $0.028 in total at the configured prices, 128 s;
  - 3 of the S3 example's 4 criteria were met. The fourth exposed a gap in how a waiting or finishing agent gets a landed change (D-106).

Sources: `scripts/provider-check.ts` runs and the `demo:0b --real --provider openrouter` run, 2026-10-05. *Impact: D-104's provider pin; D-106.*
<!-- Stream A: append new F-IDs (F-98 to F-119) above this line. -->

### Stream B (Vihaan; F-120 to F-139)
*(none yet)*
<!-- Stream B: append new F-IDs (F-120 to F-139) above this line. -->
