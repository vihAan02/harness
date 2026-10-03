# Local runtime: `harnessd` on a laptop

> **Status:** design spec. `harnessd` v0 is built in `packages/daemon` (0A item 4, D-75, D-76; sessions D-77); the 0B and later rows are not. [PLAN.md](../PLAN.md) wins on any conflict.
>
> **Ranked risk R-6:** laptop, environment and resource realities.

`harnessd` is the per-device daemon. It's the **execution and security boundary** (D-32). It talks to the coordination server over the internal protocol (D-14) and supervises agents through `AgentAdapter` (D-17).

## 1. Responsibilities

| Responsibility | 0A | 0B | 1 | 2 |
|---|---|---|---|---|
| Device registration and identity (device key) | local only | | signed, server-registered | |
| Local policy (deny-by-default allowlist of repos and folders) | ✓ | | intersects with cloud policy | full compile |
| Worktree lifecycle | ✓ | | checkpoint pushes | bootstrap + cache |
| Setup command per worktree (approved by hash, run sandboxed, D-52) | ✓ | | | services, dependency cache, venvs, DB state, generated files |
| Per-agent port ranges | ✓ | | | full scheduler |
| Agent sessions through adapters (start/resume/inject/stop/status) | ✓ | | Codex | |
| Edit observation → observed soft claims | ✓ | | | |
| Presence heartbeat for agents and the device | ✓ | lease heartbeats | | |
| Message delivery at safe boundaries (D-26) | SDK streaming input: next tool boundary, or a new turn if idle (F-02) | + notices attached to tool results, Stop gate | Codex: between turns (F-33) | |
| Read capture → read sets | | ✓ | | |
| Confinement via `compilePermissions` (D-35) | write confinement, shared-`.git` deny, sandbox on | + read confinement for T-1 | | full compile |
| Git write operations: commit, sync, land, push (D-50) | ✓ (commits) | + sync (D-53), local land (D-51) | checkpoint pushes, PRs | |
| Sleep, shutdown and crash handling | | | ✓ | |
| Local approval prompts (CLI) | setup/test commands (D-52) | | remote requests (D-34) | dashboard |

## 2. Local state

```
~/.harness/                      # created by harnessd, never inside a repo
  config.toml                    # device id, server URL, local policy (allowlist), limits, agent model (format: packages/daemon/src/config.ts)
  token                          # the coordination server's local token (0600; D-74)
  approvals.json                 # approved setup-command hashes; pending-approvals/ holds requests (D-52)
  scratch/<project>/<task-id>/   # HOME and TMPDIR for that task's sandboxed setup command (D-76)
  state.json                     # event cursors per project
  device.key                     # device signing key (Phase 1; 0600)
  secrets.toml                   # secret references → values or OS-keychain items (0600; D-36)
  worktrees/<project>/<task-id>/ # git worktrees, outside the main checkout
  sessions/<agent-session>.json  # adapter state: vendor session/thread id, worktree, child PID + start time
  vendor/<agent>/claude-config/  # per-agent CLAUDE_CONFIG_DIR (API-key mode, D-65); part of the resume key
  logs/                          # harnessd logs (no secret values, no file contents); session-<id>.log = the vendor CLI's stderr
```

Worktrees live **outside** the main checkout, so tools that scan the repo don't find nested copies, and so policy can confine each agent to exactly one directory.

## 3. Worktree lifecycle (D-10)

1. **Create:** `git worktree add -b harness/task/<task-id> ~/.harness/worktrees/<project>/<task-id> <base-commit>`. Each branch can only be checked out in one worktree at a time.
2. **Set up:** run the project's setup command in the worktree (§4). Allocate ports (§5). Inject the referenced secrets into the agent process environment (§6).
3. **Run:** start the agent session through the adapter, with the worktree as its working directory.
4. **Observe:** run `git status` / `git diff --name-only $(git merge-base HEAD <base branch>)` at each turn end and on a timer, to get observed claims ([coordination.md §1](coordination.md#1-claims-d-20-d-21)). Using the merge base means files brought in by a sync never look like this agent's edits.
5. **Sync** (0B, D-53): after a peer's change lands, at this agent's next turn end (detected from the session stream), or immediately if it's idle:
   - hold input to the agent;
   - commit its work in progress;
   - merge the new base into the task branch;
   - then deliver the held `landed` notice with a diff excerpt.
   
   On a conflict: abort, mark the task `blocked`, pause the agent and ask the human to resolve it.
6. **Land** (0B, local, D-51): triggered by the human (`harness land <task>`):
   1. Fencing check through the server (`land.accepted` / `land.rejected`).
   2. Merge the task branch with the current base in a harness-owned **integration worktree**, and run the approved `test.command` there, sandboxed.
   3. **Green:** fast-forward the base branch and report `land.complete`. The server then sends `landed` notices to affected agents.
   4. **Red or conflict:** report `land.fail`. The base is untouched and the task goes back to its assignee.
7. **Tear down:** `git worktree remove`, delete the branch if it's merged, `git worktree prune`, and release ports and leases.

**Git write operations are `harnessd`'s alone (D-50).**
- Agents edit files and may run read-only Git, but don't commit, branch, merge or push.
- `harnessd` commits when the task is done (0A), at sync and land (0B), and at checkpoints (Phase 1).
- Each task has exactly one branch, `harness/task/<task-id>`, created from an explicit base SHA (F-57).

**Across machines (Phase 1):**
- Worktrees aren't shared. The task branch is pushed to the shared remote.
- Checkpoint pushes publish the task branch to the remote as `harness/wip/<agent>/<task-id>`, at meaningful boundaries only (D-29). That's the branch a reassigned task resumes from.
- The PR opens from `harness/task/<task-id>` when the human runs `harness land` (D-54).

## 4. Project config (proposal; the file name and format get fixed in 0A)

`harness.yaml` sits at the repo root. It's committed, so it's shared with teammates, which makes it **untrusted input** (D-52):
- **`setup.command` and `test.command` run only after approval.**
  - The local human approves a hash of the command plus the declared manifests, on first use and on every change.
  - The approval is only a tripwire, because the command runs repo-controlled code such as lifecycle scripts. **The sandbox is the real boundary:** commands run sandboxed with no secrets by default, read confinement and a network allowlist (e.g. the package registry). They never run as bare `harnessd`. **The mechanism is Anthropic's sandbox runtime** (`srt`, pinned) with a config `harnessd` generates per worktree: writes only in the worktree, the shared `.git` write-denied, secrets and sibling worktrees read-denied, a network allowlist and an explicit env. It refuses to run on an invalid config (D-69, SP-12).
- **`env.refs` can't widen secrets.** They're intersected with a per-project allowlist in `~/.harness/config.toml`, so a commit can't widen which secrets reach agents.
- **Numeric fields** (`ports`, `limits`) can only lower local limits.
- **In Phase 1,** a teammate's change to any of these shows up as an approval prompt (D-34).

```yaml
setup:
  command: pnpm install            # 0A: run once per new worktree (approved + sandboxed, D-52)
  manifests: [package.json, pnpm-lock.yaml]   # included in the approval hash
test:
  command: pnpm test               # 0B: run by the land step in the integration worktree (approved + sandboxed)
ports:
  per_agent: 10                    # 0A: can only lower the local default (D-52)
env:
  refs:                            # D-36: names only; values resolved locally by harnessd
    - DATABASE_URL
    - STRIPE_TEST_KEY
services:                          # Phase 2 (approval like setup, D-52)
  - postgres
contracts:                         # Phase 1 (D-30): declared contract files and their consumers
  - path: openapi.yaml
  - path: src/types.ts
limits:                            # repo values can only LOWER local limits (D-52)
  max_concurrent_agents: 2         # 0A: fixed at 2 (D-38); Phase 2: scheduler-managed
```

**What's deliberately missing:** an `env.copy: [.env.local]` option. S2 flagged that copying `.env` files into worktrees is a security problem. Secrets are referenced by name and resolved on each machine (§6).

## 5. Ports and resources (D-38)

**0A, ports:**
- Each agent gets a block, for example agent 1 → 3100–3109 and agent 2 → 3110–3119.
  - Blocks stay **outside the OS ephemeral range**, because every Claude Code process binds an ephemeral loopback port for its own sandbox proxy (SP-08).
  - The session's sandbox gets `network.allowLocalBinding: true`; without it the agent can't bind its ports at all (D-68).
- `harnessd` sets `PORT` to the first port of the block, plus `HARNESS_PORT_BASE` and `HARNESS_PORT_COUNT`.
- The adapter's system prompt tells the agent to use them. Nobody should be hoping everyone uses port 3000 nicely.

**0A, concurrency:** `max_concurrent_agents` is fixed at 2.

**Phase 2, the local scheduler:**
- budgets for CPU, memory, number of processes running at once, and GPU;
- queueing heavy commands (installs, Docker builds, full test runs) instead of running them all at once;
- per-agent accounting in the event log.

## 6. Secrets by reference (D-36)

- **Where values live:** the project config lists secret names. The values live only on each person's machine, preferably as OS keychain entries. `~/.harness/secrets.toml` (0600) is the plaintext fallback, a small local store, not a secret manager.
- **How they're injected:** `harnessd` puts only the secrets an agent's task needs into that agent process's environment. That's the repo's `env.refs` ∩ the local allowlist (D-52).
- **The base env is explicit.** The Claude TS SDK's `env` option *replaces* the environment (F-22), so the adapter passes a minimal base (`PATH`, `HOME`, the chosen auth variable per F-67), plus the ports and the referenced secrets.
- **Secret names are restricted (D-87, TH-21).** A secret may never use a name the agent CLI or runtime reads (`ANTHROPIC_*`, `CLAUDE*`, `NODE_*`, `BUN_*`, `SSL_*`, proxy and TLS variables, `PATH`, `PORT`, `HARNESS_*`, `GIT_*` and similar), nor the name of the model key's variable. harnessd refuses such a config, and the adapter refuses such a session.
- **The model key** is read from harnessd's own environment, under the name the local config's provider table gives (`key_env`, D-87). harnessd checks it at startup, never logs it, and never writes it to disk.
- **Never:**
  - written into worktree files;
  - included in messages or events;
  - sent to the coordination server.
- **The vendor's own auth variable is different.** It must reach the vendor process but **not** the agent's shell. The adapter denies it to Bash children with `sandbox.credentials.envVars` and checks that with a probe at session start (D-64, SP-08).
- **Honest limitation:** an agent can read any secret in its own environment and could echo it. So:
  - only give agents the secrets they need, preferably test or dev credentials;
  - use the vendor sandbox's network limits where possible;
  - scan before landing for secret-like strings (proposal, Phase 2).

## 7. Sleep, shutdown and resume (D-40), Phase 1

- **Before sleep or shutdown,** on the OS power notification:
  1. checkpoint-push active tasks (D-29);
  2. stop renewing leases (they expire on their own);
  3. mark agents as `suspended` through presence.
- **On wake:**
  1. reconnect and resume the event stream from the last cursor;
  2. re-check leases, since any that expired are gone and their fencing tokens are now outdated;
  3. resume agent sessions through `adapter.resumeSession` with a catch-up message summarizing what changed (stale-context notices included).
- **Crash recovery:** `harnessd` restarts, reads `sessions/*.json`, and resumes or marks each session for reassignment.
- **Reassignment:** if a device stays offline past a threshold, the task's owner can reassign it to another agent (assignee). The new session starts from the last checkpoint branch (`harness/wip/<agent>/<task-id>`).

## 8. What `harnessd` is not

`harnessd` is not:
- an agent runtime (the vendors provide those);
- a CI engine (GitHub does that);
- a secret manager (beyond the small local keychain/`secrets.toml` lookup above);
- a VM provider (D-07).
