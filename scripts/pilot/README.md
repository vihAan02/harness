# Two-Mac pilot: install, join and recover (D-110 to D-119)

This runbook takes a Mac from nothing to a working pilot device, and back again after something goes wrong. Each step says who does it. Nothing here asks for a secret. Fingerprints are compared aloud, and only public keys travel.

**Roles:**
- **Operator:** whoever runs the coordinator host.
- **Human:** each of the two owners, on their own Mac.

## 1. The Mac (human, once)
1. **Node.** Use the version both Macs agreed on, and check it with `node -v`. The pilot needs Node 24.
2. **A clone outside iCloud.** For example `git clone https://github.com/vihAan02/harness.git ~/code/harness-pilot`. Don't put it under `~/Desktop` or `~/Documents` if iCloud syncs them.
3. **GitHub.**
   - `gh auth login` with the `repo` and `workflow` scopes.
   - Then `gh auth setup-git`, so Git uses that login. The remote URL never carries credentials.
4. **Postgres (D-119).** If this Mac runs one, run `scripts/pilot/pg-harden.sh`. It:
   - backs up `pg_hba.conf`;
   - puts every loopback login behind a password, which it keeps in `~/.pgpass` (0600), so `psql`, `npm run check` and the demos still work;
   - creates a restricted `harness_agent` role;
   - checks that a password-less login fails and that the restricted role can't run programs.

   **Also add `export PGPASSFILE="$HOME/.pgpass"` to `~/.zshrc`.** Some tests (T-1, T-1b) point `HOME` at a temp directory, so the password file must be named by an absolute path.

   `scripts/pilot/pg-harden.sh --undo` restores the backup.
5. **The model key (D-116).** Each human uses their own OpenRouter key, with a **$0.25 a day** limit set on the key itself.
   - Put it in `~/.harness/secrets.toml` (0600) as `OPENROUTER_API_KEY = "…"`, or whatever name the provider table's `key_env` uses.
   - Never put it in a shell profile, a launchd plist or the repository.

## 2. The runtime (human)
```
scripts/pilot/install.sh install <candidate sha>
export PATH="$HOME/harness-runtime/bin:$PATH"
```
- Both Macs run the same full commit id, installed at `~/harness-runtime/<sha>` and never edited.
- A new candidate is installed beside the old one. It's promoted with `install.sh promote <sha>` only while harnessd is stopped.

## 3. Joining (both humans and the operator)
1. **Each human:**
   - `harness setup keygen --device dev_<you>_<mac>` makes the device key in `~/.harness/device.key`, and prints its fingerprint.
   - `scripts/pilot/tunnel.sh keygen` makes the tunnel key, and prints a public key for the operator.
2. **Operator:**
   - `HARNESS_SERVER_KEY_FILE=… npm run admin -- server-key` prints the coordinator's key and fingerprint.
   - Add both devices' public keys to `pilot.toml`; `docs/examples/pilot.toml` is the template.
   - `npm run admin -- apply pilot.toml` prints each device's fingerprint.
   - **Read every fingerprint aloud with its human.** A mismatch stops everything.
   - Create the tunnel-only accounts: `nologin`, `PermitOpen 127.0.0.1:7400`, no shell, no other forwarding.
3. **Each human:**
   - Add the coordinator host's SSH key to `~/.ssh/known_hosts`, after comparing its fingerprint aloud.
   - `scripts/pilot/tunnel.sh install harness-tun-<you>@<host>` keeps `127.0.0.1:7400` forwarded through launchd.
   - Then run setup:
     ```
     harness setup --device dev_<you>_<mac> --principal human_<you> --server-key ed25519:<coordinator's> \
       --trust-device dev_<other>=human_<other>:ed25519:<other's device key> \
       --project prj_harness --repo ~/code/harness-pilot --integration github \
       --remote https://github.com/vihAan02/harness.git --commit-name "<you>" --commit-email <id>+<login>@users.noreply.github.com \
       --provider openrouter-haiku55
     harness doctor
     ```
   - Every `doctor` line must say `ok` before harnessd starts. Each `FAIL` line names its fix.

## 4. Running
- **`harnessd`** runs the pinned runtime against `~/.harness/config.toml`.
- **`harness status`** and `harness ui` (the thin UI, D-117) watch it.
- **Spend:** one product agent per Mac, $0.10 a session and $0.25 a day (D-116). Record each paid run's cost in its PR.

## 5. Recovery
| What happened | What to do |
|---|---|
| The Mac slept, or the tunnel dropped | Nothing. launchd restarts the tunnel and harnessd reconnects. `tunnel.sh status` shows the tunnel; `harness doctor` proves who's behind it |
| harnessd or the Mac restarted mid-task | Start harnessd. It reconciles from its journal (D-113). A task whose session ended shows as **stopped**: `harness task resume <task>` starts a new session with the work so far |
| `server_identity_mismatch` | Something other than the coordinator answers on 127.0.0.1:7400. Don't proceed. Check the tunnel (`tunnel.sh status`) and the pinned `server_key` with the operator |
| `coordinator_changed` | The coordinator's database is new. harnessd won't mix its local state with it. Agree with the operator before accepting the new epoch |
| A device key was lost or exposed | Operator: `npm run admin -- apply pilot.toml --revoke dev_x`. Then make a new key, add it under a new device id, and apply again |
| A device's key changed on purpose | Read the new fingerprint aloud, then the operator runs `apply … --rotate dev_x` |
| Postgres hardening broke something | Run `scripts/pilot/pg-harden.sh --undo`. harnessd then refuses to start agents again (D-119) until it's hardened |
| A new candidate | Stop harnessd (its sessions stop and the work stays), run `install.sh install <sha>` and `install.sh promote <sha>`, start harnessd again, then run `harness doctor` |
