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
   ~/harness-runtime/current/scripts/pilot/install.sh promote <sha>     # only if an older runtime is current
   export PATH="$HOME/harness-runtime/bin:$PATH"     # add it to ~/.zshrc
   ```
   `install` makes `current` only on a Mac that has none, so a Mac with an older runtime also needs `promote`.
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
9. **Vihaan only: the tunnel key,** once: `~/harness-runtime/current/scripts/pilot/tunnel.sh keygen`. Send its public key (`~/.ssh/harness_tunnel_ed25519.pub`, one line) to the operator with the device key from step 5, and read its fingerprint aloud.

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
3. **The tunnel account for Vihaan.** Save the tunnel public key Vihaan sent (§1 step 9) as a file holding exactly that one line, say `vihaan-tunnel.pub`. Then:
   ```
   ~/harness-runtime/current/scripts/pilot/coordinator.sh tunnel-account harness-tun-vihaan vihaan-tunnel.pub
   ```
   It prints the key's fingerprint (read it aloud with Vihaan first), then what to do, in this order:
   1. **Remote Login first** (System Settings → General → Sharing → Remote Login): on, "Allow access for: Only these users", with every entry removed, Administrators included. Leave "Allow full disk access for remote users" off.
   2. **The `sudo` commands, run by you:**
      - a hidden account with no password login and `/sbin/nologin` as its shell. macOS refuses an account whose shell is `/usr/bin/false`, after its key is accepted;
      - its `authorized_keys` line, `restrict,port-forwarding,permitopen="127.0.0.1:7400",command="/usr/bin/false"`;
      - an sshd `Match User harness-tun-*` block allowing only that one local forward;
      - `ssh-keygen -A` (macOS makes host keys only at the first connection) and an `sshd -t` check;
      - the account added to Remote Login's access group (`dseditgroup … com.apple.access_ssh`), and the group printed. It must list only `harness-tun-vihaan`.
   3. **The host key:** read the fingerprint it prints last aloud to Vihaan.

   `sysadminctl` warns that there's no clear-text password for FileVault. That's expected.
4. **Check:** `coordinator.sh status`.
   - It shows both launchd jobs, the server `(device-key)`, the epoch, the coordinator key, this Mac's SSH host-key fingerprint (read it aloud to Vihaan), Remote Login, and every loopback listener.
   - Agents can reach any loopback port, so quit anything listed there that runs code (a dev server, a browser's remote-debugging port) before agents run.

## 3. Joining (each human)
1. **Vihaan only: the tunnel.** Its key is the one from §1 step 9. `<host>` is Daniyal's Mac's 100.x Tailscale address, as `tailscale status` shows it (the address is what's been tested, not the name). Nothing on Vihaan's Mac may listen on 127.0.0.1:7400: the tunnel needs that port, and otherwise it retries every 10 seconds:
   ```
   ~/harness-runtime/current/scripts/pilot/tunnel.sh known-host <host> SHA256:<the host-key fingerprint Daniyal read aloud>
   ~/harness-runtime/current/scripts/pilot/tunnel.sh install harness-tun-vihaan@<host>
   ~/harness-runtime/current/scripts/pilot/tunnel.sh status
   ```
2. **Both: write `config.toml`,** pinning only what you were told aloud:
   ```
   harness setup --device dev_<you>_<mac> --principal human_<you> --server-key ed25519:<coordinator's> \
     --trust-device dev_<other>=human_<other>:ed25519:<the other device's key> \
     --project prj_harness --repo ~/code/harness-pilot --integration github \
     --remote https://github.com/vihAan02/harness.git --commit-name "<your name>" \
     --commit-email <id>+<login>@users.noreply.github.com --provider openrouter-haiku55 --ports-per-agent 0
   harness doctor
   ```
   - Your noreply address is on github.com → Settings → Emails.
   - `--ports-per-agent 0` gives this Mac's agents no loopback access at all (D-143). The UI tasks need none, and `harness doctor` says which you have.
   - Re-run `setup` with `--force` to change it, for example to add the other device once it exists. It writes the file from the flags alone, so give every one of them again.
   - Every `doctor` line must say `ok` (or `skip` with a reason) before harnessd starts. Each `FAIL` names its fix.
3. **Both: run harnessd and the UI bridge as launchd services.** They start at every login and restart after a crash. harnessd asks `gh` for your GitHub token, and reads your model key from `~/.harness/secrets.toml`, so no secret is in either plist:
   ```
   ~/harness-runtime/current/scripts/pilot/install.sh service install
   harness doctor
   harness ui
   ```
   - `harness ui` checks the running bridge is this Mac's, then opens the board in your browser. `harness ui --print` prints the one-time address instead.
   - Logs are in `~/.harness/logs/harnessd.log` and `ui.log`. `install.sh service status` shows both services, and `install.sh service stop` stops them, with their sessions stopped and the work kept.
   - In a terminal instead, for debugging: `install.sh service uninstall`, then `harnessd`.
4. **Check together:** `harness status` on each Mac shows both devices online. No command lets a human send a message; the agents' own question and answer in §5 are the first messages between the Macs.

## 4. Running a task (each human, for their own agent)
- **Each human's agent was made by `pilot.toml`:** `agent/daniyal-ui`, `agent/vihaan-ui`. Each human writes and assigns their own tasks. Another human's task for your agent waits for your approval (D-34), and a risky message waits for review (D-118).
- **Write and assign one:** `harness task add "<title>" --scope packages/ui/ --file task.md --assign <you>-ui`. harnessd signs the start with your device key.
- **Approve what harnessd asks for:** `harness approve` lists it, and `harness approve <id>` approves it. That's the repo's setup command (`npm ci --ignore-scripts`) once per device, and each publish: harnessd shows the commits before it pushes `harness/prj_harness/<epoch>/<task>` and opens the PR.
- **Review:** the **other** human reviews and approves the PR on GitHub, as with any PR (the CODEOWNERS rule). CI runs the three required checks.
- **Integrate:** `harness integrate <task>`. It shows the PR, its head, the base, the checks and reviews. harnessd merges exactly that head as one squash through GitHub, and every other Mac fetches the merge and syncs.
  - Only the agent's own human can integrate.
  - Nobody else may push or merge on the repo while it runs: GitHub's strict up-to-date rule, and harnessd's "one PR in flight" check.
  - **If `main` moved since the PR was opened** (GitHub says "behind"), the first `harness integrate` brings it up to date instead (D-147): harnessd merges `main` into the task's branch, pushes it and republishes the PR, and merges nothing. CI runs again on the new head, and the reviewer approves the new head. Then `harness integrate` again.
- **Delegation (D-145), optional, per human:** your harnessd can publish and integrate your own agents' routine tasks without your click. Add to your own `~/.harness/config.toml` (re-add it after any `harness setup --force`), then `install.sh service stop` and `start`:
  ```
  [delegation]
  devices = ["dev_<you>_<mac>"]
  projects = ["prj_harness"]
  actions = ["publish", "integrate"]
  until = "<a date at most 31 days away>"     # it lapses at the start of that day (UTC)
  # protected = ["docs/"]                     # more paths that always need your click
  # max_files = 40
  ```
  - **Publish** is approved only when every changed file is inside the task's scope, none is protected (`.github/`, CODEOWNERS, `harness.yaml`, `.claude/`, `AGENTS.md`/`CLAUDE.md`, `package.json` and its lock, plus yours), and the publish gate held nothing. Anything else waits for `harness approve` as before, and the log says why.
  - **Integrate** happens once GitHub shows the PR clean, all three checks green and the other human's approval of its exact head; the land checks everything a click does. A ready PR left behind by `main` is brought up to date first.
  - **Never delegated:** setup and test commands, another human's start on your agent, and GitHub reviews. Reviewing the other human's PRs stays a reading by you, or by an agent you ask, labelled as an agent review on your behalf.
  - **See and stop it:** `harness delegation` shows the policy, whether it's active and its last decisions. `harness delegation off` stops it at once (no restart); `harness delegation on` lifts that. Both Macs see each decision: `harness log --kind delegation`.
- **Watch:**
  - `harness status`: devices, agents, tasks with their claims, overlaps, blocked tasks and open questions;
  - `harness log --kind wait`: waits, which `harness status` doesn't list;
  - `harness ui`: PRs and their checks;
  - `harness log --follow`: everything as it happens.
- **Spend:** one agent per Mac, at most $0.10 a session and $0.25 a day (D-116). Record each paid run's cost.

## 5. The first two-agent test
The three task texts are in `scripts/pilot/first-test/`, so both Macs run exactly the same tasks. They're real, small changes to the UI: one place for its formatters, then a change to one of them while the other agent is about to use it. **Before you start,** the UI must be on `main` (#135, #136 and #137 merged), since these tasks change it, and both Macs run a candidate that includes it. Below, T-1, T-2 and T-3 stand for the ids the coordinator gives: it numbers every task it has ever had, so they may not start at T-1. `harness task add` prints each id, and `harness status` shows them. **Freeze** the repo for the duration: nobody pushes or merges anything else (GitHub's strict up-to-date rule and harnessd's one-PR-in-flight check would refuse the merges).
1. **T-1 on Daniyal's agent:** `format.ts` (`formatCost`, `shortSha`), used where the UI formats a cost or a commit id, with tests.
   ```
   harness task add "UI formatters" --scope packages/ui/ --file scripts/pilot/first-test/1-format.md --assign daniyal-ui
   ```
   - Daniyal approves the setup command and, when it's done, the publish (`harness approve`).
   - Vihaan approves the PR on GitHub, and once CI is green Daniyal runs `harness integrate T-1`.
   - **This proves A to B:** Vihaan's next task starts from a base his harnessd fetched and verified, with `format.ts` in it.
2. **Daniyal creates the rename task first, without starting it,** so it has an id for Vihaan's task to wait on. An agent can't look that id up itself: its `harness_status` lists another agent's task only once it's started.
   ```
   harness task add "Rename the cost formatter" --scope packages/ui/ --file scripts/pilot/first-test/3-rename.md      # Daniyal: prints "Created T-2"
   ```
   **Vihaan** puts that id into his task's text, in place of `RENAME_TASK`, and starts it:
   ```
   sed 's/RENAME_TASK/T-2/g' scripts/pilot/first-test/2-integration.md > /tmp/2-integration.md      # T-2: the id Daniyal's command printed
   harness task add "Integration page costs" --scope packages/ui/ --file /tmp/2-integration.md --assign vihaan-ui      # Vihaan: T-3
   ```
   His agent reads `format.ts` and waits for T-2 to land. Then:
   - **Daniyal,** once `harness log --kind wait` shows that wait (`wait.started` on T-2; `harness status` doesn't list waits): `harness task assign T-2 daniyal-ui`. Both tasks' scope is `packages/ui/`, so each board shows the overlap. His agent asks Vihaan's agent how many decimals the integration page shows, waits for the answer, then renames `formatCost` to `formatUsd(usd, digits)` and updates its callers.
   - **Recovery drill:** while Daniyal's agent is still working on T-2, stop Daniyal's harnessd (Ctrl-C), start it again, see T-2 **stopped** in `harness status`, and run `harness task resume T-2`.
   - **T-2 lands:** Vihaan approves the PR on GitHub, and Daniyal runs `harness integrate T-2`. Vihaan's harnessd fetches the merge and syncs T-3's branch, and his agent is told `format.ts` changed, with the diff. It then makes the integration page's costs call `formatUsd`.
   - Vihaan approves T-3's publish, Daniyal approves the PR on GitHub, and Vihaan runs `harness integrate T-3`.

**What success looks like:**
- `harness status` on both Macs shows both devices and both agents.
- The question and the answer appear in both agents' turns: `harness log --kind message` on either Mac.
- Three PRs, opened by harnessd as their humans, green, approved by the other human, and merged by `harness integrate`.
- Vihaan's agent got the `format.ts` notice, and `view/integration.ts` calls `formatUsd`.
- T-2's agent asked and T-3's agent answered: two waits, one on a question and one on a land, both ended by what they waited for.
- Each Mac's `git -C ~/code/harness-pilot rev-parse refs/harness/prj_harness/base` reaches the merges (Daniyal's on its next fetch, for instance at his next task's start).
- The resumed task kept its edits: one PR, no duplicate session running.
- Spend under $0.25 per Mac (`harness status` shows today's).

## 6. Recovery
| What happened | What to do |
|---|---|
| A Mac slept, or the tunnel dropped | Nothing. launchd restarts the tunnel and harnessd reconnects. `tunnel.sh status` shows the tunnel; `harness doctor` proves who's behind it. With Power Nap on, a sleeping Mac wakes for a minute about every 15 minutes, so its device shows online and offline in turn (`pmset -g log` shows the `DarkWake` lines); keep it awake during a run |
| Daniyal's Mac slept | While it sleeps, nobody can coordinate, and the coordinator's timers (waits, leases) fire late. `caffeinate` doesn't stop a lid-close sleep on battery. During a run, keep it **on power with the lid open**, or have its owner run `sudo pmset -a disablesleep 1` (undo: `0`). `pmset -g log \| grep -E "Sleep\|Wake"` shows when it slept. On each wake, `device.offline` then `device.online` in the same second for a device is that sleep, not a lost connection |
| The tunnel loops, and Vihaan's `tunnel.log` says `Connection closed by <host> port 22` right after `Server accepts key` | The account is refused after its key. Operator: `dscl . -read /Users/harness-tun-vihaan UserShell` must be `/sbin/nologin`, and `dscl . -read /Groups/com.apple.access_ssh GroupMembership` must list it. Vihaan runs `tunnel.sh stop` until it's fixed; macOS's sshd logs nothing about it |
| harnessd or a Mac restarted mid-task | Nothing to start: launchd starts harnessd at login and after a crash. It reconciles from its journal (D-113). A task whose session ended shows as **stopped**: `harness task resume <task>` starts a new session with the work so far, in the slot the task still holds |
| `server_identity_mismatch` | Something other than the coordinator answers on 127.0.0.1:7400. Don't proceed. Check the tunnel (`tunnel.sh status`) and the pinned `server_key` with the operator |
| `coordinator_changed` | The coordinator's database is new. harnessd won't mix its local state with it. Agree with the operator before accepting the new epoch |
| D-116: a provider failure stopped the agents | Fix the account (key, credit) at the provider, then `harness provider reset`. A budget stop clears at the next UTC day |
| A device key was lost or exposed | Operator: `coordinator.sh apply pilot.toml --revoke dev_x`. **The other human also re-runs `harness setup … --force` without the old pin and restarts harnessd (`install.sh service stop`, then `start`):** until then their harnessd still trusts what the old key signs. A device that's still connected is cut off at its next message. Then make a new key under a new device id and apply again. The device key (`~/.harness/device.key`) isn't the tunnel key; revoke that too only if the Mac itself was lost |
| A tunnel key was lost or exposed, or its human leaves | Operator: `sudo rm /etc/ssh/harness_authorized_keys/harness-tun-<name>`, then `sudo pkill -u harness-tun-<name>` (an open tunnel outlives its key). For a new key: Vihaan runs `tunnel.sh keygen` again, and the operator runs only the `authorized_keys` lines `coordinator.sh tunnel-account` prints, since the account exists |
| A device's key changed on purpose | Read the new fingerprint aloud. The operator runs `coordinator.sh apply pilot.toml --rotate dev_x`, and the other human re-pins it with `harness setup … --force` and restarts harnessd |
| Postgres hardening broke something | `PGPORT=<port> scripts/pilot/pg-harden.sh --undo`. harnessd then refuses to start agents again (D-119) until that cluster is hardened or stopped |
| A new candidate | `install.sh install <sha>`, then `install.sh service stop` (sessions stop, the work stays), `install.sh promote <sha>` and `install.sh service install` (it rewrites both plists for the new runtime and starts them). On Daniyal's Mac also `coordinator.sh service restart`, which restarts the server from the new runtime and leaves Postgres running. Then `harness doctor` |
