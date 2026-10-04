# Agent adapters

> **Status:** design spec. `ClaudeAdapter` is built in `packages/adapters` (0A item 5, D-77); `CodexAdapter` is Phase 1. [PLAN.md](../PLAN.md) wins on any conflict.
>
> F-IDs refer to [research/vendor-capabilities.md](research/vendor-capabilities.md), checked 2026-10-01 against Claude Code 2.1.286 / Agent SDK TS 0.3.286 and Codex CLI/SDK 0.159.3. **Re-verify before coding.** Both vendors change these surfaces monthly.
>
> **The Claude side was then tested empirically** against Claude Code 2.1.287 / Agent SDK TS 0.3.287 in the 0A spike ([research/spike-0a.md](research/spike-0a.md), SP-xx). The `ClaudeAdapter` mapping in §5 reflects those results and decisions D-60 to D-70.
>
> **Implemented (0A item 5, D-77):** the interface in `packages/adapters/src/adapter.ts`, and `ClaudeAdapter` in `packages/adapters/src/claude/`. Where the code differs from the sketch in §2:
> - `startSession` and `resumeSession` take the first message, since a streaming session starts with one;
> - `getStatus` is synchronous, read from the stream;
> - the observation stream adds `process.started {pid}` (for orphan supervision), `session.init`, `status` and `ended`;
> - the hook sink has a `gate`, through which the adapter holds tool calls until the session's hardening is verified.

## 1. Why adapters exist (D-17, R-4)

Claude Code, Codex, Cursor-style environments and future agents all differ in:
- lifecycle APIs;
- sandbox models;
- hooks;
- session-resume rules;
- permissions;
- how messages can be injected.

**The rule:** all of that lives behind one interface, and **vendor-specific behaviour never leaks** into the coordination server, `harnessd`'s core, or the protocol.

**Rollout:**
- `ClaudeAdapter`: Phase 0A.
- `CodexAdapter`: Phase 1.
- Others later.

## 2. Interface (spec, not code)

```ts
interface AgentAdapter {
  readonly vendor: string;                       // "claude" | "codex" | …
  capabilities(version: VendorVersion): Capabilities;

  startSession(spec: SessionSpec): Promise<SessionHandle>;
  resumeSession(ref: VendorSessionRef, spec: SessionSpec): Promise<SessionHandle>;
  injectMessage(h: SessionHandle, msg: EnvelopedMessage): Promise<DeliveryReceipt>;
  queueNotice(h: SessionHandle, msg: EnvelopedMessage): Promise<DeliveryReceipt>;  // high-priority harness notices (D-99)
  withdrawNotice(h: SessionHandle, messageId: string): boolean;                    // a queued notice a newer one replaced
  stopSession(h: SessionHandle, mode: "graceful" | "kill"): Promise<void>;
  getStatus(h: SessionHandle): Promise<SessionStatus>;   // working | idle | waiting | errored | ended

  compilePermissions(policy: EffectivePolicy, worktree: string): VendorPolicyBundle; // pure; no side effects
  setupHooks(spec: SessionSpec, sink: HarnessHookSink): VendorHookBundle;           // read capture, notices, stop gate

  observations(h: SessionHandle): AsyncIterable<Observation>;  // normalized stream (see §3)
}

// Required by S3:
interface Capabilities {
  canCaptureReads: boolean;     // can observe file reads at all
  canDenyToolCalls: boolean;    // a pre-tool deny exists
  canInjectTurn: boolean;       // can deliver input to a live/idle session without restarting it
  canResume: boolean;
  supportsMCP: boolean;         // can consume the harness tool shim via MCP
  supportsHooks: boolean;
  // Proposed additions (detail the six flags can't express):
  readCaptureFidelity: "tool-observed" | "command-parsed" | "none";
  canInjectBetweenTools: boolean;   // delivery inside a running turn at a tool boundary
  canSandboxReads: boolean;         // OS-level read confinement available
  hooksFailClosed: { preToolUse: boolean; postToolUse: boolean; stop: boolean }; // per event; Claude SDK: PreToolUse on timeout only (a throwing callback fails open, SP-10)/false/false
  authModes: Array<"api-key" | "subscription" | "cloud-provider">;
}
```

**SessionSpec** carries:
- the worktree path;
- the task (text and scope);
- the agent principal;
- the port block;
- secret *references*, already resolved by `harnessd` into an explicit env;
- the harness tool shim;
- the standing instructions (envelope rules);
- the effective policy;
- the auth mode chosen by the user ([Q-04](open-questions.md#q-04), D-48).

**Degradation rule:** when a capability is `false` or weaker, the adapter says so, and `harnessd`:
- **lowers the confidence label** on what it derives. For example, read sets from parsed commands are labeled `low`.
- **or refuses the run** if the current policy requires the missing capability. For example, a policy that needs read confinement on a vendor that can't sandbox reads.

It **never pretends** (security §5).

## 3. Normalized observations

Adapters translate vendor events into one stream that `harnessd` consumes:

| Observation | Used for |
|---|---|
| `turn.started` / `turn.ended {reason}` | Turn-boundary delivery, presence, A/B timing |
| `tool.called {category: read\|search\|edit\|write\|shell\|mcp\|other, paths?, command?}` | Observed claims, read sets, coverage metric (H-03) |
| `read.observed {path, range?, source, confidence}` | Read sets (0B) |
| `edit.observed {path}` | Observed soft claims (0A) |
| `usage {input, output, cached, cumulative: bool}` | A/B token metric M8, budgets |
| `error {kind: rate_limit\|billing\|auth\|sandbox\|other, message}` | Pause and alert; never retry in a loop (F-65) |
| `delivery {message_id, landed: between_tools\|new_turn\|stop_hook}` | Message latency metric |

## 4. Capability matrix (as of 2026-10-01)

| Capability | Claude Code via Agent SDK (TS) | Codex via `codex exec` / TS SDK | Codex via app-server / Python SDK |
|---|---|---|---|
| `canCaptureReads` | **Yes**: `PostToolUse` on Read/Grep/LSP, absolute `file_path` (F-07). Gaps: @-mentions, shell reads, reads whose hook failed open (F-08, D-47). Repeated reads still fire the hook but return no content, so hash from disk. Instruction files are injected and recorded by `harnessd` (D-45) | **Partial**: no read tool; reads only appear inside shell command strings (F-39) | **Partial**: best-effort parsed `commandActions` `{type: read, path}` (F-34, F-39) |
| `readCaptureFidelity` | tool-observed (+ command-parsed for Bash) | command-parsed (harness parses strings) | command-parsed (vendor-parsed) |
| `canDenyToolCalls` | **Yes**: `PreToolUse` deny. In-process SDK callbacks fail **closed on timeout only**; a callback that throws fails **open**, so wrap it (SP-10, D-62). Shell/HTTP hooks fail **open** (F-05, F-06) | **Yes**: `PreToolUse` deny (hooks GA), fail **open**; a guardrail, not a boundary (F-35) | Yes (hooks), plus approval requests answered by the host (F-34) |
| `canInjectTurn` | **Yes**: streaming input; a pushed message lands **at the next tool boundary** in a running turn, or starts a new turn if idle; `command_lifecycle` receipts. `origin` isn't model-visible, and text is expanded unless `client_composed` (F-02, SP-02, D-63) | **Between turns only**: one process per turn; follow-up = `exec resume <thread> "<msg>"` (F-31, F-33) | **Yes**: `turn/steer`, `thread/inject_items`, `ExternalMessage` (tool-level authority) (F-34). Labelled experimental. |
| `canInjectBetweenTools` | Yes (streaming input; also `PostToolUse`/`PostToolBatch` `additionalContext`, 10,000-char cap) (F-02, F-05) | Via hooks only: `PostToolUse` `additionalContext` (~2,500-token cap) (F-35) | Yes (`turn/steer`) |
| `canResume` | Yes: `resume`/`sessionId`/`forkSession` (F-04) | Yes: `exec resume` (F-31) | Yes: `thread/resume` (F-34) |
| `supportsMCP` | Yes: in-process SDK MCP server for harness tools (F-15) | Yes: MCP client via `[mcp_servers]` (F-40) | Yes |
| `supportsHooks` | Yes: 33 events in TS (F-05) | Yes: 12 events, **hash-trusted**; generated hooks are skipped unless trusted or managed (F-35, F-36). Never use the trust-bypass flag (D-45) | Yes |
| Stop gate | `Stop` `decision: block`, `stop_hook_active`, max 8 in a row (F-09) | `Stop` `decision: block` continues with the reason as a new prompt (F-35) | Same |
| `canSandboxReads` | **Yes, via one channel:** `Read(//…)` deny rules in the SDK's `settings` (flag) layer cover file tools, `@`-expansion **and** shell reads at the OS level. Sandbox `denyRead` alone covers shell reads only (F-12, SP-13, D-61) | Permission profiles (beta) with deny-read; **incompatible with `--sandbox`**; default read access is the whole filesystem (F-38) | Same |
| Usage reporting | Per-turn `usage` + cumulative `modelUsage` (estimates) (F-16) | `turn.completed.usage` = running totals (F-43) | `thread/tokenUsage/updated` (F-34) |
| Auth modes | API key / cloud providers; subscription is a terms grey zone (F-60 to F-67) | API key or ChatGPT login (F-68 to F-71) | API key, or ChatGPT login for local/non-commercial use only: app-server **ChatGPT** auth is "never permitted for commercial or hosted services" (F-70) |
| Built-in peer messaging to disable | Cross-session messaging (`SendMessage`/`ListAgents`, inbox socket, on by default); agent teams (experimental) (F-17, F-18) | Multi-agent collab tools are subagents within one session (n/a) | n/a |

## 5. `ClaudeAdapter` (Phase 0A): how each method maps

The adapter is implemented on the **Agent SDK (TypeScript)**. Python lacks many hook events and control methods (F-01), and raw `claude -p` stream-json is only partly documented as a protocol (F-23).

| Method | Implementation (proposal, updated by the spike) |
|---|---|
| `startSession` | `query({ prompt: <harness-controlled AsyncIterable>, options })`. The options are listed below the table. |
| `injectMessage` | Push an `SDKUserMessage` with **`client_composed: true`** (always; otherwise `@path` and `/commands` in the text are executed, SP-02), the envelope text, a `uuid`, and `origin` (`peer` or `coordinator`; host metadata only, not model-visible). Default priority lands at the next tool boundary or starts a new turn; `priority: 'later'` waits for turn end; never `'now'` for peer traffic. The delivery receipt is the `command_lifecycle` `started` frame for that `uuid` (D-63). |
| `queueNotice` / `withdrawNotice` | **0B, as built (D-99):** while a turn runs, the notice waits in the session's queue, and the `PostToolBatch` hook returns the queued notices that fit in 10,000 characters together as `additionalContext` (F-106); they're delivered `between_tools`. Not in a turn, or too long to attach whole: `injectMessage`. Still queued at turn end: injected, opening the next turn with no idle reported in between. A message injected while notices are queued sends them first. Queued notices fail when the session ends; `withdrawNotice` takes one back (its receipt fails). |
| `resumeSession` | `resume: <sessionId>` with the **same per-agent `CLAUDE_CONFIG_DIR`** (resume fails otherwise) and the session's **own worktree** (the CLI would resume into another `cwd`), re-passing every option (SP-07, D-65). A tool call killed mid-flight comes back as "interrupted, outcome unknown"; reconcile the worktree diff before continuing (D-70). Never resume one session from two processes (F-04). |
| `stopSession` | Graceful: `interrupt()` (the turn ends with `terminal_reason: aborted_tools`), reconcile `still_queued` (F-03), then `close()`. Kill: `close()`, which kills the subprocess and any in-flight tool (SP-01, SP-07). |
| `getStatus` | `session_state_changed` (`running` / `idle` / `requires_action`; needs `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`); `idle` is the turn end (D-67). Plus the last `result` (`is_error`, `terminal_reason`), `api_retry` frames, and child-PID liveness (SP-09). |
| `compilePermissions` | **0A (D-60):** scoped allows `Edit(//<worktree>/**)`, `Write(//<worktree>/**)` (never bare `Edit`/`Write`), plus `Read`, `Grep`, `Glob`, `Bash` and the shim tools; the same `Edit` rule in flag settings; sandbox `filesystem.denyWrite` on the shared Git dir's `config`, `hooks`, `refs`, `objects`, `packed-refs`, `info`, `worktrees`, `HEAD`, `index`, `logs`; `allowUnsandboxedCommands: false`; `credentials.envVars` deny for the auth variable (D-64); `network.allowLocalBinding: true` when the agent has a port block (D-68); `bashEditDiffEnabled: true` (F-07). **0B, as built (D-98):** read confinement in three layers.<br>• flag-settings `Read(//…)` deny rules for every entry of the home directory, harness state and main checkout that isn't on the way to the worktree, the shared `.git` or an allowed toolchain;<br>• a call-time read check in PreToolUse;<br>• sandbox `filesystem.denyRead` on those roots, with `allowRead` re-opening the allowed paths for shell commands. |
| `setupHooks` | **In-process SDK callbacks** (F-05): a **dead-man `PreToolUse`** registered in every session, short timeout, body wrapped so any exception returns `deny` (D-62); `PostToolUse` (edit capture in 0A via file paths and `bashEditDiff`; read capture and notices in 0B), `PostToolBatch` (batched notices, built in 0B: D-99), `Stop` (keep-alive gate, 0B). PostToolUse and Stop fail **open**, so worktree diffs (D-70) and a missed-hook monitor (0B) back them up. Shell/HTTP hooks aren't used. `canUseTool` isn't used for gating: it has no timeout (a hang stalled the session), and under sandbox auto-allow Bash never reaches it (SP-10). |

**`startSession` options:**
- `cwd` = the worktree;
- `sessionId` assigned by `harnessd`;
- `permissionMode: 'dontAsk'` with the scoped allow list from `compilePermissions` (D-60). It's set explicitly, because an omitted mode can start in auto (F-11). Nothing prompts; out-of-list calls are denied and logged. A human approval path isn't needed before Phase 1;
- `tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash']` (Proposal, D-66): an explicit base set, so self-scheduling, worktree, network and background-subagent tools aren't offered (about 49 KB less per request, SP-09);
- `settingSources: []`, so the **repo's hooks, MCP servers and plugins don't run** (D-45, F-14);
- `systemPrompt: {type: 'preset', preset: 'claude_code', append: <harness standing instructions + repo CLAUDE.md/AGENTS.md text loaded by harnessd as context>}`;
- `mcpServers: {harness: createSdkMcpServer(...)}`, the tool shim, with `alwaysLoad: true` so tool search doesn't defer it (F-15);
- `hooks:` in-process callbacks (see `setupHooks`);
- `sandbox: {enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: {denyWrite: <shared .git paths>}, credentials: {envVars: [{name: <auth var>, mode: 'deny'}]}, network: {allowLocalBinding: <has ports>}}` (F-13, D-60, D-64, D-68). `allowUnsandboxedCommands: false` is load-bearing: with `true`, `dangerouslyDisableSandbox` ran a command unsandboxed (SP-05);
- `env:` an **explicit** env, since it replaces the inherited one (F-22). It contains:
  - a minimal base (`PATH`, `HOME`, and the auth variable for the user's chosen mode, F-67);
  - the ports;
  - the allowlisted secret references (D-52);
  - `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, because auto memory is shared across worktrees of one repo (F-14);
  - a **per-agent `CLAUDE_CONFIG_DIR`** owned by `harnessd` (D-65; API-key mode only);
  - `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` for the turn-end signal (D-67);
  - **no secrets in any option value**: options become command-line arguments visible in `ps` (SP-01);
- `disallowedTools: ['SendMessage', 'ListAgents']`, so peer traffic only flows through the harness (D-46, F-17);
- **harness-owned settings** (permission rules; `crossSessionInbound: refuse`; `bashEditDiffEnabled`), passed through the SDK's **`settings` option** (the flag-settings layer). Verified: its deny rules reach the OS sandbox even with `settingSources: []` (SP-13). The SDK's `managedSettings` also work but are dropped on machines with an IT-managed tier, so they're not relied on;
- agent teams left disabled;
- `permissionMode` **never `auto`**, for the A/B test as well: auto-mode classifier calls are excluded from usage totals, which would skew M8 (F-11, F-16).

**Alternative transport.** For a non-TS `harnessd`, or as a fallback, use `claude -p --restricted --settings <harness file>` (v2.1.248+). It loads only managed settings plus `--settings`, confines file tools to the working directories, and refuses bypass mode (F-14). Every option has to be re-passed on each resume (F-23).

**Things the ClaudeAdapter must handle:**
- **Hash reads from disk in the hook,** not from `tool_response`. A repeated read returns a "file_unchanged" stub (F-08).
- **`CLAUDE_CONFIG_DIR`:** per agent in API-key mode (D-65). Only in subscription mode (not used in Phase 0) does it re-key the macOS Keychain and break login (F-22).
- **Treat a result as an error when `is_error` is true,** whatever the `subtype`: a billing error comes back as `subtype: "success"`, `is_error: true`, `terminal_reason: "api_error"`, `api_error_status: 400` (SP-09).
- **Supervise against your own crash:** record each child PID; on `harnessd` start, kill orphans from a previous run and reconcile the worktree diff before resuming (D-62).
- **Model endpoints (D-87):** `SessionSpec.auth` carries an optional `baseUrl` and `scheme` (`x-api-key` or `bearer`), and `SessionSpec.model` a vendor-neutral `ModelConfig` (`id`, `background`, context and output limits, `stripExperimental`, `extraBody`, `prices`). The Claude adapter maps them onto `ANTHROPIC_BASE_URL`, the auth variables (both, for bearer, so `apiKeySource` stays the API key: C-21), `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL` (F-25), `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` (F-26), the `CLAUDE_CODE_MAX_*` limits and `CLAUDE_CODE_EXTRA_BODY` (F-29). Secrets (`SessionSpec.secrets`) are checked against reserved names before the session opens (TH-21). The usage observation carries per-session `costBasis` (`config`, `list` or `unknown`) and the models used; with configured prices the adapter enforces `maxBudgetUsd` itself and scales the CLI's own cap, whose rate for unknown models is a guess (F-27).
- **Verify the hardening at session start:** `init.apiKeySource` is the expected source, and `init.model` is the configured model (D-87), no MCP servers or repo skills are listed, and a probe Bash command can't see the auth variable (D-56, D-64). *As built (D-77):* every turn's `init` is checked, and tools wait for the first check. The probe runs in the adapter's test suite against the pinned version, because only the model can run a Bash command in a session.
- **Phrase notices as facts.** Imperative "system command" wording in injected context can trigger the model's prompt-injection defenses (F-10).
- **Stop-gate cap:** respect the 8-continuation limit (F-09). After the cap, escalate to the human rather than looping.
- **Detect billing and rate-limit errors.** Pause and alert; don't retry in a loop (F-65).
  - **Rate limits and overload:** `api_retry` frames carry `attempt`, `max_retries` (10), `retry_delay_ms` and `error_status`. They were observed for 429, 529 and 401 (SP-09).
  - **Billing:** a billing 400 is not retried. It shows up as an assistant `error: "billing_error"` plus an `is_error` result.
  - **Real error texts are still to confirm** (U-6).
- **Don't rely on Claude Code's own stale-edit guard.** It was relaxed in v2.1.208+, and it only ever covered the agent's own directory, not peers' worktrees (F-20). Stale-context detection is the harness's job (D-22).

## 6. `CodexAdapter` (Phase 1): the likely shape

**Two transports, chosen by capability need:**
1. **`codex exec --json` / TS SDK.**
   - Not labelled experimental, but the protocol changes often, so pin the version (F-30).
   - Delivery between turns only.
   - Read capture by parsing command strings.
   - Approvals are forced to `never` in exec unless `approvals_reviewer=auto_review` (F-32). So enforcement must come from the sandbox, permission profiles and rules; hooks are only a secondary layer (D-47, F-35).
2. **App-server (JSON-RPC) / Python SDK.** Mid-turn `turn/steer`, `ExternalMessage` with tool-level authority (which suits peer messages, since they can't impersonate the user), host-answered approvals, and parsed read actions. But it's **labelled experimental and not for production** (F-34).

**Decide in Phase 1** by re-checking app-server stability. Pin the version and generate TypeScript types from `codex app-server generate-ts` either way.

**Must-dos already known:**
- **Approval policy:** never emit `untrusted` (retired) or `on-failure` (deprecated) (F-37).
- **Removed and conflicting flags:** never emit `--full-auto` (removed in 0.147.0, though the docs still mention it). Don't pass `--worktree`, because `harnessd` owns worktrees (F-31, D-50).
- **Python SDK default:** it uses `auto_review` approvals, an extra reviewer model that doesn't surface approvals to the host. Set the mode explicitly (F-34).
- **Repo Claude config:** don't let Codex import it. The app-server can import Claude Code hooks and MCP config (F-42, D-45).
- **Read confinement:** use a **permission profile** with deny-read for sibling worktrees and secrets, and **don't pass `--sandbox`**, which disables profiles (F-38).
- **Hooks and repo config (D-45):**
  - Supply harness hooks as **managed** or **hash-trusted** hooks in a per-agent `CODEX_HOME`. Untrusted generated hooks are silently skipped (F-36).
  - **Never** pass `--dangerously-bypass-hook-trust`: if the project were trusted, it would also run the repo's own `.codex/hooks.json`.
  - Keep the project's `.codex` layer untrusted, and deliver repo instructions with `-c developer_instructions`, since untrusted projects skip AGENTS.md (F-41).
  - Exact behavior to verify in Phase 1.
- **Commits:** `workspace-write` keeps `.git` read-only, so agents in linked worktrees probably can't commit. `harnessd` owns commits and checkpoints (D-50; inference in F-38, test it).
- **Stale context is entirely on the harness:** there's no stale-read check, and `apply_patch` falls back to whitespace-insensitive matching (F-44).
- **Token usage:** compute per-turn usage from successive running totals (F-43).
- **Auth:** API key by default. Never copy `auth.json`. ChatGPT-login mode is local-only, if allowed at all (F-68 to F-70, [Q-04](open-questions.md#q-04)).

## 7. Adding a future vendor

1. Implement the interface. Fill `capabilities()` honestly per version.
2. Add the vendor's facts to `vendor-capabilities.md` with F-IDs and dates.
3. Add a row to the matrix above.
4. Run security tests T-1 and T-2 with that vendor before it's allowed in a project.
