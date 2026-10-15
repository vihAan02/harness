#!/usr/bin/env bash
# The pilot's coordinator on the operator's own Mac (D-142): a dedicated Postgres 18 cluster with no TCP port, and the
# harness server in device-key mode on 127.0.0.1:7400. Everything lives in ~/.harness-coordinator (0700), under the home
# directory that agents and setup sandboxes can't read (D-98, D-142). The other Mac reaches the server through an SSH -L
# tunnel as a tunnel-only account (tunnel.sh; the account is made by the commands `tunnel-account` prints).
#   coordinator.sh init                    the cluster (socket only, peer auth), the harness_pilot database, the server key
#   coordinator.sh apply <pilot.toml> [--rotate <dev>]… [--revoke <dev>]…
#                                          provision humans, devices, the project and agents (npm run admin -- apply)
#   coordinator.sh service install|uninstall|start|stop
#                                          launchd jobs for the cluster and the server, kept up across login and crashes
#   coordinator.sh run                     what the server's launchd job runs: cap the log, wait for Postgres, serve
#   coordinator.sh tunnel-account <name> <pubkey-file>
#                                          print the sudo commands that make a tunnel-only SSH account (run them yourself)
#   coordinator.sh status                  the jobs, the server's auth mode, the epoch, fingerprints, loopback listeners
# The server runs from the pinned runtime (~/harness-runtime/current, install.sh), never from a development checkout.
set -euo pipefail
USER="${USER:-$(id -un)}"

CH="${HARNESS_COORDINATOR_HOME:-$HOME/.harness-coordinator}"
RUNTIME="${HARNESS_COORDINATOR_RUNTIME:-${HARNESS_RUNTIME_ROOT:-$HOME/harness-runtime}/current}"
PGBIN="${HARNESS_PG_BIN:-/opt/homebrew/opt/postgresql@18/bin}"
DATA="$CH/pg/data"
SOCK="$CH/pg/run"
KEY="$CH/server.key"
LOGS="$CH/logs"
DB=harness_pilot
PORT="${HARNESS_PORT:-7400}"
LABEL_PG=com.harness.coordinator.postgres
LABEL_SRV=com.harness.coordinator.server
AGENTS="$HOME/Library/LaunchAgents"
LOG_CAP=$((10 * 1024 * 1024))
die() { printf 'coordinator: %s\n' "$*" >&2; exit 1; }
# The database over the cluster's own socket: no host, no port, no password anywhere.
db_url() { printf 'postgresql://%s@/%s?host=%s' "$USER" "$DB" "$SOCK"; }

# Node 24, found once and named by its absolute path (a broken default `node` must never run the coordinator).
node24() {
  local c
  for c in "${HARNESS_NODE:-}" "$(command -v node 2>/dev/null || true)" /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    [[ "$("$c" -v 2>/dev/null || true)" =~ ^v24\. ]] && { echo "$c"; return; }
  done
  die "no working Node 24 (set HARNESS_NODE to its path)"
}
need_runtime() { [ -f "$RUNTIME/packages/server/src/main.ts" ] || die "no runtime at $RUNTIME (scripts/pilot/install.sh install <sha>, or set HARNESS_COORDINATOR_RUNTIME)"; }
need_pg() { [ -x "$PGBIN/postgres" ] || die "no Postgres 18 at $PGBIN (brew install postgresql@18, or set HARNESS_PG_BIN)"; }
pg_up() { "$PGBIN/pg_isready" -q -h "$SOCK" -d "$DB" 2>/dev/null || "$PGBIN/pg_isready" -q -h "$SOCK" 2>/dev/null; }
# Keep one previous log: a log over the cap is moved aside when the job (re)starts.
cap_log() { local f="$1"; [ -f "$f" ] && [ "$(stat -f %z "$f")" -gt "$LOG_CAP" ] && mv -f "$f" "$f.1"; return 0; }

plist() { # plist <label> <stdout-log> <program and args…>; environment comes from PLIST_ENV (key=value lines)
  local label="$1" log="$2"; shift 2
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n'
  printf '  <key>Label</key><string>%s</string>\n  <key>ProgramArguments</key>\n  <array>\n' "$label"
  local a; for a in "$@"; do printf '    <string>%s</string>\n' "$a"; done
  printf '  </array>\n  <key>EnvironmentVariables</key>\n  <dict>\n'
  local kv; while IFS= read -r kv; do [ -n "$kv" ] && printf '    <key>%s</key><string>%s</string>\n' "${kv%%=*}" "${kv#*=}"; done <<< "${PLIST_ENV:-}"
  printf '  </dict>\n  <key>KeepAlive</key><true/>\n  <key>RunAtLoad</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>\n'
  printf '  <key>StandardOutPath</key><string>%s</string>\n  <key>StandardErrorPath</key><string>%s</string>\n</dict>\n</plist>\n' "$log" "$log"
}

case "${1:-}" in
  init)
    need_pg; need_runtime
    umask 077
    mkdir -p "$CH" "$SOCK" "$LOGS"; chmod 700 "$CH" "$CH/pg" "$SOCK" "$LOGS"
    if [ ! -f "$DATA/PG_VERSION" ]; then
      LC_ALL=en_US.UTF-8 "$PGBIN/initdb" -D "$DATA" -U "$USER" -E UTF8 --locale=en_US.UTF-8 --auth-local=peer --auth-host=reject >/dev/null
      # Socket only, inside this 0700 directory; peer auth; no TCP at all, so nothing on loopback can reach it.
      printf "listen_addresses = ''\nunix_socket_directories = '%s'\nunix_socket_permissions = 0700\n" "$SOCK" >> "$DATA/postgresql.conf"
      printf 'local all %s peer\n' "$USER" > "$DATA/pg_hba.conf"
      echo "created the coordinator's cluster at $DATA (socket only, peer auth)"
    fi
    if ! pg_up; then
      LC_ALL=en_US.UTF-8 "$PGBIN/pg_ctl" -s -D "$DATA" -l "$LOGS/postgres.log" -w start
      started=1
    fi
    "$PGBIN/psql" -h "$SOCK" -d postgres -Atqc "SELECT 1 FROM pg_database WHERE datname = '$DB'" | grep -q 1 \
      || "$PGBIN/createdb" -h "$SOCK" "$DB"
    (cd "$RUNTIME" && HARNESS_SERVER_KEY_FILE="$KEY" "$(node24)" scripts/pilot/admin.ts server-key)
    # The launchd job owns the cluster from here; a cluster this command started is stopped again.
    [ "${started:-}" = 1 ] && LC_ALL=en_US.UTF-8 "$PGBIN/pg_ctl" -s -D "$DATA" -m fast -w stop
    echo "next: coordinator.sh service install, then coordinator.sh apply <pilot.toml>"
    ;;
  apply)
    shift; need_runtime
    pg_up || die "the coordinator's Postgres isn't up (coordinator.sh service start)"
    args=(); for a in "$@"; do case "$a" in -*) args+=("$a") ;; *) [ -f "$a" ] || die "no file $a"; args+=("$(cd "$(dirname "$a")" && pwd)/$(basename "$a")") ;; esac; done
    (cd "$RUNTIME" && HARNESS_DATABASE_URL="$(db_url)" HARNESS_SERVER_KEY_FILE="$KEY" "$(node24)" scripts/pilot/admin.ts apply "${args[@]}")
    ;;
  run)
    need_runtime
    cap_log "$LOGS/server.log"
    for _ in $(seq 1 30); do pg_up && break; sleep 1; done
    pg_up || die "the coordinator's Postgres didn't come up; see $LOGS/postgres.log"
    cd "$RUNTIME"
    HARNESS_AUTH=device-key HARNESS_SERVER_KEY_FILE="$KEY" HARNESS_DATABASE_URL="$(db_url)" HARNESS_PORT="$PORT" \
      exec "$(node24)" packages/server/src/main.ts
    ;;
  service)
    case "${2:-}" in
      install)
        need_pg; need_runtime
        [ -f "$DATA/PG_VERSION" ] && [ -f "$KEY" ] || die "run coordinator.sh init first"
        pg_up && LC_ALL=en_US.UTF-8 "$PGBIN/pg_ctl" -s -D "$DATA" -m fast -w stop
        mkdir -p "$AGENTS"
        cap_log "$LOGS/postgres.log"
        PLIST_ENV="LC_ALL=en_US.UTF-8" plist "$LABEL_PG" "$LOGS/postgres.log" "$PGBIN/postgres" -D "$DATA" > "$AGENTS/$LABEL_PG.plist"
        # The server's job runs this script from the pinned runtime, so `run` caps the log on every start.
        PLIST_ENV="HARNESS_COORDINATOR_HOME=$CH
HARNESS_COORDINATOR_RUNTIME=$RUNTIME
HARNESS_PG_BIN=$PGBIN
HARNESS_NODE=$(node24)
HARNESS_PORT=$PORT" plist "$LABEL_SRV" "$LOGS/server.log" /bin/bash "$RUNTIME/scripts/pilot/coordinator.sh" run > "$AGENTS/$LABEL_SRV.plist"
        chmod 600 "$AGENTS/$LABEL_PG.plist" "$AGENTS/$LABEL_SRV.plist"
        for l in "$LABEL_PG" "$LABEL_SRV"; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true; launchctl bootstrap "gui/$(id -u)" "$AGENTS/$l.plist"; done
        echo "installed $LABEL_PG and $LABEL_SRV (no secret in either). Check: coordinator.sh status"
        ;;
      uninstall) for l in "$LABEL_SRV" "$LABEL_PG"; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true; rm -f "$AGENTS/$l.plist"; done; echo "removed both jobs; the data stays in $CH" ;;
      start) for l in "$LABEL_PG" "$LABEL_SRV"; do launchctl bootstrap "gui/$(id -u)" "$AGENTS/$l.plist"; done ;;
      stop) for l in "$LABEL_SRV" "$LABEL_PG"; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true; done ;;
      *) die "usage: coordinator.sh service install|uninstall|start|stop" ;;
    esac
    ;;
  tunnel-account)
    NAME="${2:-}"; PUB="${3:-}"
    [[ "$NAME" =~ ^harness-tun-[a-z0-9-]{1,24}$ ]] || die "usage: coordinator.sh tunnel-account harness-tun-<name> <pubkey-file>"
    [ -f "$PUB" ] || die "no public key file $PUB (the other human's ~/.ssh/harness_tunnel_ed25519.pub, from tunnel.sh keygen)"
    [ "$(grep -c . "$PUB")" = 1 ] || die "$PUB must hold exactly one key"
    read -r TYPE B64 _ < "$PUB"
    [ "$TYPE" = ssh-ed25519 ] && [[ "$B64" =~ ^[A-Za-z0-9+/]+=*$ ]] || die "$PUB isn't one ssh-ed25519 public key"
    FP="$(ssh-keygen -l -f "$PUB" | awk '{print $2}')"
    cat <<EOF
# Read this fingerprint aloud with its human before running anything: $FP
# First: System Settings > General > Sharing > Remote Login: on, "Allow access for: Only these users", and remove every
# entry, Administrators included ("Allow full disk access for remote users" stays off). That makes the access group.
# Then run these yourself (they need your password). They make $NAME a tunnel-only account: no password, no shell,
# no TTY, one forwarding to 127.0.0.1:$PORT and nothing else. If $NAME already exists (a new tunnel key), run only the
# authorized_keys lines, then: sudo pkill -u $NAME (an open tunnel outlives its key).
# The shell is /sbin/nologin, not /usr/bin/false: macOS's PAM refuses an account whose shell is /usr/bin/false, after
# the key is accepted. sysadminctl warns about no clear-text password for FileVault; that's expected.
sudo sysadminctl -addUser $NAME -fullName "Harness tunnel ($NAME)" -shell /sbin/nologin -home /var/empty -password "\$(openssl rand -base64 33)"
sudo dscl . -create /Users/$NAME IsHidden 1
sudo dscl . -read /Users/$NAME UserShell IsHidden
sudo mkdir -p /etc/ssh/harness_authorized_keys
printf '%s\n' 'restrict,port-forwarding,permitopen="127.0.0.1:$PORT",command="/usr/bin/false" $TYPE $B64 $NAME' | sudo tee /etc/ssh/harness_authorized_keys/$NAME >/dev/null
sudo chown -R root:wheel /etc/ssh/harness_authorized_keys && sudo chmod 755 /etc/ssh/harness_authorized_keys && sudo chmod 644 /etc/ssh/harness_authorized_keys/$NAME
sudo tee /etc/ssh/sshd_config.d/100-harness-tunnel.conf >/dev/null <<'CONF'
# Harness pilot tunnel-only accounts (D-111, D-142): one local forwarding to the coordinator, nothing else.
Match User harness-tun-*
  AuthorizedKeysFile /etc/ssh/harness_authorized_keys/%u
  AuthenticationMethods publickey
  PasswordAuthentication no
  KbdInteractiveAuthentication no
  AllowTcpForwarding local
  PermitOpen 127.0.0.1:$PORT
  PermitListen none
  AllowAgentForwarding no
  AllowStreamLocalForwarding no
  X11Forwarding no
  PermitTTY no
  PermitTunnel no
  GatewayPorts no
  ForceCommand /usr/bin/false
CONF
# macOS makes its SSH host keys only at the first connection, and sshd -t needs them.
sudo ssh-keygen -A
sudo sshd -t && echo "sshd config ok"
# Only the tunnel accounts may use Remote Login (the group System Settings made above).
sudo dseditgroup -o edit -a $NAME -t user com.apple.access_ssh
dscl . -read /Groups/com.apple.access_ssh GroupMembership
# Then read this Mac's host-key fingerprint aloud to $NAME's human (coordinator.sh status prints it too):
ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub
EOF
    ;;
  status)
    for l in "$LABEL_PG" "$LABEL_SRV"; do
      if launchctl print "gui/$(id -u)/$l" >/dev/null 2>&1; then echo "launchd: $l loaded"; else echo "launchd: $l not loaded"; fi
    done
    if pg_up; then echo "postgres: up on $SOCK (socket only)"; else echo "postgres: not answering on $SOCK"; fi
    line="$(grep -h 'harness server listening' "$LOGS/server.log" 2>/dev/null | tail -1 || true)"
    case "$line" in
      *'(device-key)'*) echo "server: $line" ;;
      '') echo "server: no 'listening' line in $LOGS/server.log yet" ;;
      *) echo "server: NOT in device-key mode: $line" ;;
    esac
    if nc -z 127.0.0.1 "$PORT" 2>/dev/null; then echo "127.0.0.1:$PORT answers (harness doctor proves who's behind it)"; else echo "127.0.0.1:$PORT doesn't answer"; fi
    pg_up && echo "epoch: $("$PGBIN/psql" -h "$SOCK" -d "$DB" -Atqc 'SELECT epoch FROM coordinator_epoch' 2>/dev/null || echo '(not migrated yet)')"
    [ -f "$KEY" ] && [ -f "$RUNTIME/scripts/pilot/admin.ts" ] && (cd "$RUNTIME" && HARNESS_SERVER_KEY_FILE="$KEY" "$(node24)" scripts/pilot/admin.ts server-key | tail -2)
    if [ -r /etc/ssh/ssh_host_ed25519_key.pub ]; then echo "this Mac's SSH host key (read it aloud for known_hosts): $(ssh-keygen -l -f /etc/ssh/ssh_host_ed25519_key.pub)"
    else echo "this Mac's SSH host key: none yet (sudo ssh-keygen -A makes it; coordinator.sh tunnel-account prints that step)"; fi
    echo "Remote Login allowed for:$(dscl . -read /Groups/com.apple.access_ssh GroupMembership 2>/dev/null | cut -d: -f2 || echo ' (no access group: everyone with an account)')"
    if nc -z 127.0.0.1 22 2>/dev/null; then echo "Remote Login: on"; else echo "Remote Login: off (System Settings > General > Sharing)"; fi
    command -v tailscale >/dev/null 2>&1 && echo "tailscale: $(tailscale status --self --peers=false 2>/dev/null | head -1 || echo 'not running')"
    echo "loopback listeners (agents can reach every one of them; quit any that runs code before a real run):"
    lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 && ($9 ~ /^(127\.0\.0\.1|\[::1\]|\*|localhost):/) {print "  " $1 " (pid " $2 ") " $9}' | sort -u
    ;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
