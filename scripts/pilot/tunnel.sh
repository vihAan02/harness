#!/usr/bin/env bash
# The SSH tunnel from this Mac to the pilot's coordinator (D-111). The coordinator listens on its own loopback only;
# each Mac reaches it as a tunnel-only account (nologin, PermitOpen 127.0.0.1:7400, no shell, no other forwarding).
# harnessd, the CLI and the UI bridge then talk to ws://127.0.0.1:7400 here, and the device-key handshake proves both
# ends. The tunnel only carries the bytes. A launchd agent keeps it up across sleep and login.
#   tunnel.sh keygen                      make this Mac's tunnel key once (~/.ssh/harness_tunnel_ed25519) and print the
#                                         public key, to send to the coordinator's operator (it's public)
#   tunnel.sh install <user>@<host> [port] [ssh-port]
#                                         write ~/Library/LaunchAgents/com.harness.tunnel.plist and start it. The host's
#                                         key must already be in ~/.ssh/known_hosts, checked aloud: no trust on first use
#   tunnel.sh status | stop | start | uninstall
set -euo pipefail

LABEL=com.harness.tunnel
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
KEY="$HOME/.ssh/harness_tunnel_ed25519"
LOG="${HARNESS_HOME:-$HOME/.harness}/logs/tunnel.log"
die() { printf 'tunnel: %s\n' "$*" >&2; exit 1; }

case "${1:-}" in
  keygen)
    [ -f "$KEY" ] && die "$KEY exists; it's this Mac's tunnel key (send $KEY.pub)"
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    ssh-keygen -q -t ed25519 -N '' -C "harness-tunnel-$(scutil --get LocalHostName 2>/dev/null || hostname -s)" -f "$KEY"
    echo "Send this public key to the coordinator's operator, for your tunnel-only account:"
    cat "$KEY.pub"
    echo "Its fingerprint, to read aloud: $(ssh-keygen -l -f "$KEY.pub")"
    ;;
  install)
    TARGET="${2:-}"; PORT="${3:-7400}"; SSHPORT="${4:-22}"
    [[ "$TARGET" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || die "usage: tunnel.sh install <user>@<host> [port] [ssh-port]"
    [[ "$PORT" =~ ^[0-9]+$ && "$SSHPORT" =~ ^[0-9]+$ ]] || die "ports are numbers"
    [ -f "$KEY" ] || die "no tunnel key: tunnel.sh keygen first"
    HOST="${TARGET#*@}"
    ssh-keygen -F "$([ "$SSHPORT" = 22 ] && echo "$HOST" || echo "[$HOST]:$SSHPORT")" >/dev/null \
      || die "$HOST's host key isn't in ~/.ssh/known_hosts. Get its fingerprint from the operator, then add it (ssh-keyscan -p $SSHPORT $HOST, and compare aloud)"
    mkdir -p "$(dirname "$LOG")" "$(dirname "$PLIST")"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/ssh</string>
    <string>-N</string>
    <string>-p</string><string>$SSHPORT</string>
    <string>-L</string><string>127.0.0.1:$PORT:127.0.0.1:7400</string>
    <string>-i</string><string>$KEY</string>
    <string>-o</string><string>IdentitiesOnly=yes</string>
    <string>-o</string><string>BatchMode=yes</string>
    <string>-o</string><string>StrictHostKeyChecking=yes</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=15</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
    <string>-o</string><string>ClearAllForwardings=no</string>
    <string>-o</string><string>ForwardAgent=no</string>
    <string>-o</string><string>ForwardX11=no</string>
    <string>-o</string><string>PermitLocalCommand=no</string>
    <string>$TARGET</string>
  </array>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>StandardOutPath</key><string>$LOG</string>
</dict>
</plist>
PLIST
    chmod 600 "$PLIST"
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "installed $PLIST: 127.0.0.1:$PORT here → $TARGET's 127.0.0.1:7400. No secret is in it. Check: tunnel.sh status"
    ;;
  start) launchctl bootstrap "gui/$(id -u)" "$PLIST" ;;
  stop) launchctl bootout "gui/$(id -u)/$LABEL" ;;
  uninstall) launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$PLIST"; echo "removed $PLIST" ;;
  status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "launchd: $LABEL loaded"; else echo "launchd: $LABEL not loaded"; fi
    if nc -z 127.0.0.1 "${2:-7400}" 2>/dev/null; then echo "127.0.0.1:${2:-7400} answers (harness doctor proves who's behind it)"; else echo "127.0.0.1:${2:-7400} doesn't answer; see $LOG"; fi
    ;;
  *) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
