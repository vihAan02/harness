# Two-Mac pilot: install, join, run and recover (D-110 to D-119, D-142)

This runbook takes both Macs from nothing to a running pilot, and back again after something goes wrong. Each step says who does it. Nothing here asks you to paste a secret anywhere but your own `~/.harness/secrets.toml`. Only public keys travel, and every fingerprint is compared aloud.

**Topology (D-142):**
- **Daniyal's Mac** runs the coordinator: a socket-only Postgres plus the harness server on `127.0.0.1:7400`, both under `~/.harness-coordinator`. It's also Daniyal's execution device, connecting to `127.0.0.1:7400` directly.
- **Vihaan's Mac** reaches that port through an SSH `-L` tunnel, as the tunnel-only account `harness-tun-vihaan`, over Tailscale. Nothing is exposed to the internet.
- **GitHub** is the only path for code between the Macs. The coordinator holds metadata only.

**Who:**
- **Operator:** Daniyal (the coordinator).
- **Each human:** Daniyal and Vihaan, each on their own Mac.

## 1. Each Mac, once (each human)
1. **Node 24:** `brew install node@24`. The scripts find it themselves, even if your default `node` is another version.
2. **GitHub:** `gh auth login` with the `repo` and `workflow` scopes, then `gh auth setup-git`. `gh api user --jq .login` must print exactly your login (`DaniyalMughal1`, `vihAan02`).
3. **harnessd's own clone,** outside iCloud and never edited by hand:
   ```
   git clone https://github.com/vihAan02/harness.git ~/code/harness-pilot
   ```
4. **The pinned runtime.** From any checkout of this repo, with the candidate's full commit id (both Macs run the same one):
   ```
   scripts/pilot/install.sh install <sha>
   export PATH="$HOME/harness-runtime/bin:$PATH"     # add it to ~/.zshrc
   ```
5. **This device's key:** `harness setup keygen --device dev_<you>_<mac>` (`dev_daniyal_mac`, `dev_vihaan_mbp`). It prints `public_key = "ed25519:…"` and a fingerprint. Send the public key to the operator and read the fingerprint aloud.
6. **Your model key (D-116).** Your own OpenRouter key, with a **$0.25 a day** limit set on the key at openrouter.ai, in `~/.harness/secrets.toml` (0600):
   ```
   OPENROUTER_API_KEY = "sk-or-…"
   ```
   Never in a shell profile, a launchd plist or the repository.
7. **Postgres (D-119).** harnessd refuses to start agents while any loopback Postgres accepts a login without a password. Either harden each cluster once:
   ```
   PGPORT=5432 scripts/pilot/pg-harden.sh
   PGPORT=5433 PGBIN=/opt/homebrew/opt/postgresql@18/bin scripts/pilot/pg-harden.sh
   ```
   and add `export PGPASSFILE="$HOME/.pgpass"` to `~/.zshrc`, or stop those clusters while agents run. `pg-harden.sh --undo` restores a cluster.
8. **Tailscale:** install it and log in. Daniyal shares his Mac with Vihaan (Tailscale admin console → Machines → Share). Vihaan accepts. Keep Tailscale SSH off.

## 2. The coordinator (operator, on Daniyal's Mac)
1. **Create it:**
   ```
   ~/harness-runtime/current/scripts/pilot/coordinator.sh init
   ~/harness-runtime/current/scripts/pilot/coordinator.sh service install
   ```
   `init` prints the coordinator's `server_key = "ed25519:…"` and its fingerprint. Both humans pin it, after reading it aloud.
2. **Provision** (no SQL). Copy `docs/examples/pilot.toml` to `~/.harness-coordinator/pilot.toml` and fill in each device's `public_key`.
   - A device can be added later: apply again, and nothing already there changes.
   - Then:
     ```
     ~/harness-runtime/current/scripts/pilot/coordinator.sh apply ~/.harness-coordinator/pilot.toml
     ```
     It prints every device's fingerprint. Each human confirms theirs aloud. **A mismatch stops everything.**
   - **Never re-create the coordinator's database.** A new database is a new epoch, and every harnessd stops with `coordinator_changed` until its human accepts it.
3. **The tunnel account for Vihaan.** Vihaan runs `scripts/pilot/tunnel.sh keygen` on his Mac and sends the public key. Then:
   ```
   ~/harness-runtime/current/scripts/pilot/coordinator.sh tunnel-account harness-tun-vihaan vihaan-tunnel.pub
   ```
   It prints the key's fingerprint (read it aloud with Vihaan first), then the `sudo` commands to run yourself:
   - a hidden account with no password login and no shell;
   - its `authorized_keys` line, `restrict,port-forwarding,permitopen="127.0.0.1:7400",command="/usr/bin/false"`;
   - an sshd `Match User harness-tun-*` block allowing only that one local forward;
   - an `sshd -t` check.

   Then turn on **Remote Login** (System Settings → General → Sharing), allowing only `harness-tun-vihaan`.
4. **Check:** `coordinator.sh status`.
   - It shows both launchd jobs, the server `(device-key)`, the epoch, the coordinator key, this Mac's SSH host-key fingerprint (read it aloud to Vihaan), Remote Login, and every loopback listener.
   - Agents can reach any loopback port, so quit anything listed there that runs code (a dev server, a browser's remote-debugging port) before agents run.

## 3. Joining (each human)
1. **Vihaan only: the tunnel.** `<host>` is exactly the name `tailscale status` shows for Daniyal's Mac, or its 100.x address:
   ```
   scripts/pilot/tunnel.sh known-host <host> SHA256:<the host-key fingerprint Daniyal read aloud>
   scripts/pilot/tunnel.sh install harness-tun-vihaan@<host>
   scripts/pilot/tunnel.sh status
   ```
2. **Both: write `config.toml`,** pinning only what you were told aloud:
   ```
   harness setup --device dev_<you>_<mac> --principal human_<you> --server-key ed25519:<coordinator's> \
     --trust-device dev_<other>=human_<other>:ed25519:<the other device's key> \
     --project prj_harness --repo ~/code/harness-pilot --integration github \
     --remote https://github.com/vihAan02/harness.git --commit-name "<your name>" \
     --commit-email <id>+<login>@users.noreply.github.com --provider openrouter-haiku55
   harness doctor
   ```
   - Your noreply address is on github.com → Settings → Emails.
   - Re-run `setup` with `--force` to change it, for example to add the other device once it exists.
   - Every `doctor` line must say `ok` (or `skip` with a reason) before harnessd starts. Each `FAIL` names its fix.
3. **Both: start harnessd in a terminal and leave it running.** It asks `gh` for your GitHub token, which works in a terminal session:
   ```
   harnessd
   ```
4. **Check together:** `harness status` on each Mac shows both devices online. Send one message each way before any agent runs.

## 4. Running a task (each human, for their own agent)
- **Each human's agent was made by `pilot.toml`:** `agent/daniyal-ui`, `agent/vihaan-ui`. Each human writes and assigns their own tasks. Another human's task for your agent waits for your approval (D-34), and a risky message waits for review (D-118).
- **Write and assign one:** `harness task add "<title>" --scope packages/ui/ --file task.md --assign <you>-ui`. harnessd signs the start with your device key.
- **Approve what harnessd asks for:** `harness approve` lists it, and `harness approve <id>` approves it. That's the repo's setup command (`npm ci --ignore-scripts`) once per device, and each publish: harnessd shows the commits before it pushes `harness/prj_harness/<epoch>/<task>` and opens the PR.
- **Review:** the **other** human reviews and approves the PR on GitHub, as with any PR (the CODEOWNERS rule). CI runs the three required checks.
- **Integrate:** `harness integrate <task>`. It shows the PR, its head, the base, the checks and reviews. harnessd merges exactly that head as one squash through GitHub, and every other Mac fetches the merge and syncs.
  - Only the agent's own human can integrate.
  - Nobody else may push or merge on the repo while it runs: GitHub's strict up-to-date rule, and harnessd's "one PR in flight" check.
- **Watch:** `harness status` (tasks, agents, waits, PRs) and `harness log --follow`.
- **Spend:** one agent per Mac, at most $0.10 a session and $0.25 a day (D-116). Record each paid run's cost.

## 5. The first two-agent test
**Freeze** the repo for the duration: nobody pushes or merges anything else.
1. **T-0, Daniyal's agent:** create `packages/ui/web/model/format.ts` (pure formatters: a duration, a cost, a short SHA) and `packages/ui/test/format.test.ts`.
   - Vihaan approves the PR on GitHub; Daniyal runs `harness integrate T-0`.
   - **Proves:** Vihaan's next task starts from a base his harnessd fetched and verified, with `format.ts` in it.
2. **T-1 (Daniyal's agent) and T-2 (Vihaan's agent), together:**
   - **T-2:** read `format.ts`; build `packages/ui/web/model/board.ts` (tasks grouped by state, using the formatters) with tests. If it needs a formatter changed, it asks T-1's agent instead of editing `format.ts`. It waits for T-1 with `wait_for`, `timeout_seconds: 3600`.
   - **T-1:** change a formatter's signature that T-2 uses; answer T-2's questions.
   - **Recovery drill:** stop Daniyal's harnessd (Ctrl-C) during T-1, start it again; T-1 shows **stopped**; `harness task resume T-1`.
   - **T-1 lands:** Vihaan's harnessd fetches the merge and syncs T-2's branch. T-2's agent is told `format.ts` changed, with the diff, and adapts. Vihaan approves T-2's publish; Daniyal approves the PR on GitHub; Vihaan runs `harness integrate T-2`.
3. **What every task text says:**
   - tests go in `packages/ui/test/`;
   - files under `web/` import only `./x.ts` paths inside `web/`, and `@harness/*` only as `import type`;
   - no `package.json` or lockfile edits.

**Success:**
- both devices online on both Macs, and the T-1↔T-2 messages in both agents' transcripts;
- three PRs opened by harnessd, green, approved by the other human, merged by `harness integrate`;
- T-2's agent got the `format.ts` notice, and its PR builds on T-1's change;
- each Mac's `git -C ~/code/harness-pilot rev-parse refs/harness/prj_harness/base` reaches the merges;
- T-1 resumed with its edits and no duplicate session or PR;
- spend under $0.25 per Mac.

## 6. Recovery
| What happened | What to do |
|---|---|
| A Mac slept, or the tunnel dropped | Nothing. launchd restarts the tunnel and harnessd reconnects. `tunnel.sh status` shows the tunnel; `harness doctor` proves who's behind it. While Daniyal's Mac sleeps, nobody can coordinate: keep it awake during a run (`caffeinate -dimsu`) |
| harnessd or a Mac restarted mid-task | Start harnessd. It reconciles from its journal (D-113). A task whose session ended shows as **stopped**: `harness task resume <task>` starts a new session with the work so far |
| `server_identity_mismatch` | Something other than the coordinator answers on 127.0.0.1:7400. Don't proceed. Check the tunnel (`tunnel.sh status`) and the pinned `server_key` with the operator |
| `coordinator_changed` | The coordinator's database is new. harnessd won't mix its local state with it. Agree with the operator before accepting the new epoch |
| D-116: a provider failure stopped the agents | Fix the account (key, credit) at the provider, then `harness provider reset`. A budget stop clears at the next UTC day |
| A device key was lost or exposed | Operator: `coordinator.sh apply pilot.toml --revoke dev_x`, and delete that Mac's line in `/etc/ssh/harness_authorized_keys/`. **The other human also re-runs `harness setup … --force` without the old pin and restarts harnessd:** until then their harnessd still trusts what the old key signs. A device that's still connected is cut off at its next message. Then make a new key under a new device id and apply again |
| A device's key changed on purpose | Read the new fingerprint aloud. The operator runs `coordinator.sh apply pilot.toml --rotate dev_x`, and the other human re-pins it with `harness setup … --force` and restarts harnessd |
| Postgres hardening broke something | `PGPORT=<port> scripts/pilot/pg-harden.sh --undo`. harnessd then refuses to start agents again (D-119) until that cluster is hardened or stopped |
| A new candidate | Stop harnessd (its sessions stop and the work stays), `install.sh install <sha>` and `install.sh promote <sha>`. On Daniyal's Mac also `coordinator.sh service install`, which restarts the server from the new runtime. Start harnessd, run `harness doctor` |
