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
The three task texts are in `scripts/pilot/first-test/`, so both Macs run exactly the same tasks. On a fresh coordinator the tasks are numbered T-1, T-2 and T-3 in the order you create them; `harness status` shows the ids. **Freeze** the repo for the duration: nobody pushes or merges anything else (GitHub's strict up-to-date rule and harnessd's one-PR-in-flight check would refuse the merges).
1. **T-1 on Daniyal's agent:** `format.ts`, pure formatters with tests.
   ```
   harness task add "UI formatters" --scope packages/ui/ --file scripts/pilot/first-test/1-format.md --assign daniyal-ui
   ```
   - Daniyal approves the setup command and, when it's done, the publish (`harness approve`).
   - Vihaan approves the PR on GitHub, and once CI is green Daniyal runs `harness integrate T-1`.
   - **This proves A to B:** Vihaan's next task starts from a base his harnessd fetched and verified, with `format.ts` in it.
2. **Create both remaining tasks first, then start them in order.** Creating fixes their ids, which the texts name.
   ```
   harness task add "Board model" --scope packages/ui/ --file scripts/pilot/first-test/2-board.md                  # Vihaan: T-2
   harness task add "Rename the cost formatter" --scope packages/ui/ --file scripts/pilot/first-test/3-change.md   # Daniyal, after: T-3
   ```
   Check both ids with `harness status`. Then:
   - **Vihaan:** `harness task assign T-2 vihaan-ui`. His agent reads `format.ts` and waits for T-3 to land.
   - **Daniyal,** once `harness status` shows that wait: `harness task assign T-3 daniyal-ui`. His agent asks Vihaan's agent how many decimals the board shows, waits for the answer, then renames `formatCost` to `formatUsd(usd, digits)`.
   - **Recovery drill:** while Daniyal's agent is still working on T-3, stop Daniyal's harnessd (Ctrl-C), start it again, see T-3 **stopped** in `harness status`, and run `harness task resume T-3`.
   - **T-3 lands:** Vihaan approves the PR on GitHub, and Daniyal runs `harness integrate T-3`. Vihaan's harnessd fetches the merge and syncs T-2's branch, and his agent is told `format.ts` changed, with the diff. It then writes `board.ts` against `formatUsd`.
   - Vihaan approves T-2's publish, Daniyal approves the PR on GitHub, and Vihaan runs `harness integrate T-2`.

**What success looks like:**
- `harness status` on both Macs shows both devices and both agents.
- The question and the answer appear in both agents' turns: `harness log --kind message` on either Mac.
- Three PRs, opened by harnessd as their humans, green, approved by the other human, and merged by `harness integrate`.
- Vihaan's agent got the `format.ts` notice, and its `board.ts` calls `formatUsd`.
- T-3's agent asked and T-2's agent answered: two waits, one on a question and one on a land, both ended by what they waited for.
- Each Mac's `git -C ~/code/harness-pilot rev-parse refs/harness/prj_harness/base` reaches the merges (Daniyal's on its next fetch, for instance at his next task's start).
- The resumed task kept its edits: one PR, no duplicate session running.
- Spend under $0.25 per Mac (`harness status` shows today's).

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
