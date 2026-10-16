#!/usr/bin/env bash
# The pilot's pinned runtime (D-110): harnessd, the CLI and the UI bridge run from ~/harness-runtime/<sha>, an exact
# commit of the harness, never from a development checkout. Agents never replace a running daemon. A new SHA is
# installed beside the old one and promoted only while harnessd is stopped (its sessions stopped, their work kept).
#   install.sh install <sha> [<remote>]   clone that exact commit into ~/harness-runtime/<sha>, verify it, npm ci
#   install.sh promote <sha>              point ~/harness-runtime/current at it (refused while harnessd runs)
#   install.sh status                     what's installed, what's current, and whether harnessd runs
#   install.sh service install|uninstall|start|stop|status
#                                         harnessd and the UI bridge as launchd agents: started at login, restarted if
#                                         they crash, never holding a secret (harnessd reads ~/.harness/secrets.toml)
# Wrappers in ~/harness-runtime/bin (put it on PATH): `harness` and `harnessd` run the current runtime, on Node 24, with
# Node 24 first on the PATH harnessd's agents inherit (a broken or newer default `node` never reaches them).
set -euo pipefail

ROOT="${HARNESS_RUNTIME_ROOT:-$HOME/harness-runtime}"
REMOTE_DEFAULT="https://github.com/vihAan02/harness.git"
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
# Node 24, found by trying each candidate (a broken or newer default `node` is skipped), named by its absolute path.
need_node() {
  local c
  for c in "${HARNESS_NODE:-}" "$(command -v node 2>/dev/null || true)" /opt/homebrew/opt/node@24/bin/node /usr/local/opt/node@24/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    [[ "$("$c" -v 2>/dev/null || true)" =~ ^v24\. ]] && { echo "$c"; return; }
  done
  die "the pilot runs on Node 24 and none works here (brew install node@24, or set HARNESS_NODE); both Macs use the same version"
}
valid_sha() { [[ "$1" =~ ^[0-9a-f]{40}$ ]]; }
running() { pgrep -f "$ROOT/.*/packages/daemon/src/main.ts" >/dev/null 2>&1; }
AGENTS="$HOME/Library/LaunchAgents"
HOME_DIR="${HARNESS_HOME:-$HOME/.harness}"
LABEL_D=com.harness.harnessd
LABEL_UI=com.harness.ui
loaded() { launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; }
# Right after a bootout launchd may still be tearing the job down, and a bootstrap then fails (error 5): try again.
bootstrap() { local _; for _ in 1 2 3 4 5; do launchctl bootstrap "gui/$(id -u)" "$1" 2>/dev/null && return 0; sleep 2; done; launchctl bootstrap "gui/$(id -u)" "$1"; }
# One previous log is kept: a log over 10 MiB is moved aside when its service is (re)installed or started.
cap_log() { [ -f "$1" ] && [ "$(stat -f %z "$1")" -gt $((10 * 1024 * 1024)) ] && mv -f "$1" "$1.1"; return 0; }
# A value for the plist, XML-escaped.
xml() { local s="${1//&/&amp;}"; s="${s//</&lt;}"; printf '%s' "${s//>/&gt;}"; }
# A launchd agent: started at login, restarted after a crash (not after a clean stop), given time to stop its sessions.
agent_plist() { # agent_plist <label> <log> <workdir> <program and args…>
  local label="$1" log="$2" dir="$3" a; shift 3
  printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n'
  printf '  <key>Label</key><string>%s</string>\n  <key>ProgramArguments</key>\n  <array>\n' "$(xml "$label")"
  for a in "$@"; do printf '    <string>%s</string>\n' "$(xml "$a")"; done
  printf '  </array>\n  <key>WorkingDirectory</key><string>%s</string>\n' "$(xml "$dir")"
  printf '  <key>EnvironmentVariables</key>\n  <dict>\n    <key>PATH</key><string>%s</string>\n    <key>HOME</key><string>%s</string>\n    <key>HARNESS_HOME</key><string>%s</string>\n  </dict>\n' \
    "$(xml "$(dirname "$NODE"):$ROOT/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")" "$(xml "$HOME")" "$(xml "$HOME_DIR")"
  printf '  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>30</integer>\n  <key>ExitTimeOut</key><integer>90</integer>\n'
  printf '  <key>ProcessType</key><string>Interactive</string>\n  <key>StandardOutPath</key><string>%s</string>\n  <key>StandardErrorPath</key><string>%s</string>\n</dict>\n</plist>\n' "$(xml "$log")" "$(xml "$log")"
}

case "${1:-}" in
  install)
    SHA="${2:-}"; REMOTE="${3:-$REMOTE_DEFAULT}"
    valid_sha "$SHA" || die "give the full 40-character commit id (the candidate both Macs run)"
    [[ "$REMOTE" =~ ^https://[^/@?#]+/ || -d "$REMOTE" ]] || die "the remote is a plain https URL (no user or token in it) or a local clone"
    NODE="$(need_node)"
    DIR="$ROOT/$SHA"
    if [ -d "$DIR/.git" ]; then
      [ "$(git -C "$DIR" rev-parse HEAD)" = "$SHA" ] || die "$DIR exists at another commit; remove it by hand"
      [ -z "$(git -C "$DIR" status --porcelain)" ] || die "$DIR has local changes; a runtime is never edited (remove it and install again)"
      echo "$DIR already installed at $SHA"
    else
      # Built beside its final place and moved there only once npm ci passed: a failed install never reads as installed.
      TMP="$ROOT/.tmp-$SHA"
      mkdir -p "$ROOT"; rm -rf "$TMP"
      git clone -q --no-checkout "$REMOTE" "$TMP"
      git -C "$TMP" -c advice.detachedHead=false checkout -q --detach "$SHA"
      [ "$(git -C "$TMP" rev-parse HEAD)" = "$SHA" ] || die "checked out something other than $SHA"
      (cd "$TMP" && PATH="$(dirname "$NODE"):$PATH" npm ci --ignore-scripts --no-audit --no-fund >/dev/null) || die "npm ci failed in $TMP"
      mv "$TMP" "$DIR"
      echo "installed $SHA at $DIR ($NODE, $("$NODE" -v))"
    fi
    mkdir -p "$ROOT/bin"
    for name in harness harnessd; do
      target=$([ "$name" = harness ] && echo packages/cli/src/main.ts || echo packages/daemon/src/main.ts)
      printf '#!/usr/bin/env bash\n# The pilot runtime'"'"'s %s (install.sh): always the promoted one, on Node 24, first on the PATH its agents inherit.\nexport PATH="%s:$PATH"\nexec "%s" "%s/current/%s" "$@"\n' "$name" "$(dirname "$NODE")" "$NODE" "$ROOT" "$target" > "$ROOT/bin/$name"
      chmod 755 "$ROOT/bin/$name"
    done
    [ -e "$ROOT/current" ] || { ln -s "$SHA" "$ROOT/current"; echo "current → $SHA"; }
    ;;
  promote)
    SHA="${2:-}"
    valid_sha "$SHA" || die "give the full 40-character commit id"
    [ -d "$ROOT/$SHA/.git" ] || die "$SHA isn't installed: install.sh install $SHA"
    [ "$(git -C "$ROOT/$SHA" rev-parse HEAD)" = "$SHA" ] || die "$ROOT/$SHA isn't at $SHA; remove it and install again"
    [ -z "$(git -C "$ROOT/$SHA" status --porcelain)" ] || die "$ROOT/$SHA has local changes; a runtime is never edited"
    running && die "harnessd is running from $ROOT: stop it first (install.sh service stop, or Ctrl-C in its terminal; its sessions stop, their work stays), then promote"
    ln -sfn "$SHA" "$ROOT/current.tmp" && mv -fh "$ROOT/current.tmp" "$ROOT/current"
    echo "current → $SHA. Start harnessd again (install.sh service start), then run harness doctor."
    ;;
  status)
    echo "runtimes in $ROOT:"; for d in "$ROOT"/*; do [ -d "$d/.git" ] && [ ! -L "$d" ] && echo "  $(basename "$d")"; done
    echo "current → $(readlink "$ROOT/current" 2>/dev/null || echo none)"
    if running; then echo "harnessd: running"; else echo "harnessd: not running"; fi
    for l in "$LABEL_D" "$LABEL_UI"; do if loaded "$l"; then echo "launchd: $l loaded"; else echo "launchd: $l not loaded"; fi; done
    ;;
  service)
    [ -L "$ROOT/current" ] || die "nothing is promoted yet: install.sh install <sha> first"
    LOGS="$HOME_DIR/logs"
    case "${2:-}" in
      install)
        [ -f "$HOME_DIR/config.toml" ] || die "no $HOME_DIR/config.toml: run harness setup and harness doctor first"
        NODE="$(need_node)" # only the plists need it: stop, start and status work without a Node 24
        running && ! loaded "$LABEL_D" && die "harnessd is running outside launchd: stop it (Ctrl-C in its terminal), then install the service"
        mkdir -p "$AGENTS" "$LOGS"; chmod 700 "$LOGS"
        agent_plist "$LABEL_D" "$LOGS/harnessd.log" "$HOME" "$ROOT/bin/harnessd" > "$AGENTS/$LABEL_D.plist"
        agent_plist "$LABEL_UI" "$LOGS/ui.log" "$ROOT/current" "$NODE" "$ROOT/current/packages/ui/src/main.ts" serve > "$AGENTS/$LABEL_UI.plist"
        chmod 600 "$AGENTS/$LABEL_D.plist" "$AGENTS/$LABEL_UI.plist"
        # Reinstalling (a new runtime): the running jobs stop first, sessions stopped and their work kept, before the new ones start.
        for l in "$LABEL_UI" "$LABEL_D"; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true; done
        for _ in $(seq 1 90); do running || break; sleep 1; done
        running && die "harnessd is still stopping; see $LOGS/harnessd.log, then run install.sh service install again"
        cap_log "$LOGS/harnessd.log"; cap_log "$LOGS/ui.log"
        for l in "$LABEL_D" "$LABEL_UI"; do bootstrap "$AGENTS/$l.plist"; done
        echo "harnessd and the UI bridge run under launchd from $ROOT/current, at every login. Logs: $LOGS/{harnessd,ui}.log. Check: harness doctor"
        ;;
      uninstall) for l in "$LABEL_UI" "$LABEL_D"; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true; rm -f "$AGENTS/$l.plist"; done; echo "removed both launchd agents; start harnessd by hand from now on" ;;
      start) cap_log "$LOGS/harnessd.log"; cap_log "$LOGS/ui.log"; for l in "$LABEL_D" "$LABEL_UI"; do loaded "$l" || bootstrap "$AGENTS/$l.plist"; done ;;
      # bootout sends SIGTERM: harnessd stops its sessions (their work stays) and exits; launchd doesn't restart it.
      stop) for l in "$LABEL_UI" "$LABEL_D"; do launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true; done
        for _ in $(seq 1 90); do running || break; sleep 1; done
        running && die "harnessd is still stopping; see $LOGS/harnessd.log" || echo "harnessd and the UI bridge are stopped" ;;
      status) for l in "$LABEL_D" "$LABEL_UI"; do if loaded "$l"; then echo "launchd: $l loaded"; else echo "launchd: $l not loaded"; fi; done
        if running; then echo "harnessd: running"; else echo "harnessd: not running"; fi ;;
      *) die "usage: install.sh service install|uninstall|start|stop|status" ;;
    esac
    ;;
  *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
