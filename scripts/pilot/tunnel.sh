#!/usr/bin/env bash
# The SSH tunnel from this Mac to the pilot's coordinator (D-111). The coordinator listens on its own loopback only;
# each Mac reaches it as a tunnel-only account (nologin, PermitOpen 127.0.0.1:7400, no shell, no other forwarding).
# harnessd, the CLI and the UI bridge then talk to ws://127.0.0.1:7400 here, and the device-key handshake proves both
# ends. The tunnel only carries the bytes. A launchd agent keeps it up across sleep and login.
#   tunnel.sh keygen                      make this Mac's tunnel key once (~/.ssh/harness_tunnel_ed25519) and print the
#                                         public key, to send to the coordinator's operator (it's public)
#   tunnel.sh known-host <host> <SHA256:fingerprint> [ssh-port]
#                                         add the coordinator's SSH host key to the tunnel's own known_hosts, only if it
#                                         matches the fingerprint its operator read aloud: no trust on first use
#   tunnel.sh install <user>@<host> [port] [ssh-port]
#                                         write ~/Library/LaunchAgents/com.harness.tunnel.plist and start it
#   tunnel.sh status | stop | start | uninstall
# The tunnel's ssh reads no ~/.ssh/config (-F /dev/null) and trusts only ~/.harness/tunnel/known_hosts.
set -euo pipefail

LABEL=com.harness.tunnel
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
KEY="$HOME/.ssh/harness_tunnel_ed25519"
HH="${HARNESS_HOME:-$HOME/.harness}"
KNOWN="$HH/tunnel/known_hosts"
LOG="$HH/logs/tunnel.log"
die() { printf 'tunnel: %s\n' "$*" >&2; exit 1; }
hostkey_name() { [ "$2" = 22 ] && echo "$1" || echo "[$1]:$2"; }

case "${1:-}" in
  keygen)
    [ -f "$KEY" ] && die "$KEY exists; it's this Mac's tunnel key (send $KEY.pub)"
    mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
    ssh-keygen -q -t ed25519 -N '' -C "harness-tunnel-$(scutil --get LocalHostName 2>/dev/null || hostname -s)" -f "$KEY"
    echo "Send this public key to the coordinator's operator, for your tunnel-only account:"
    cat "$KEY.pub"
    echo "Its fingerprint, to read aloud: $(ssh-keygen -l -f "$KEY.pub")"
    ;;
  known-host)
    HOST="${2:-}"; FP="${3:-}"; SSHPORT="${4:-22}"
    [[ "$HOST" =~ ^[A-Za-z0-9.-]+$ && "$FP" =~ ^SHA256:[A-Za-z0-9+/]{43}$ && "$SSHPORT" =~ ^[0-9]+$ ]] \
      || die "usage: tunnel.sh known-host <host> <SHA256:fingerprint, as the operator read it aloud> [ssh-port]"
    mkdir -p "$(dirname "$KNOWN")" && chmod 700 "$(dirname "$KNOWN")"
    SCAN="$(ssh-keyscan -T 10 -t ed25519 -p "$SSHPORT" "$HOST" 2>/dev/null | grep -v '^#' || true)"
    [ -n "$SCAN" ] || die "no ed25519 host key from $HOST:$SSHPORT (is Remote Login on? is Tailscale up?)"
    GOT="$(printf '%s\n' "$SCAN" | ssh-keygen -l -f - | awk '{print $2}')"
    [ "$GOT" = "$FP" ] || die "$HOST's host key is $GOT, not the $FP you were told: don't connect; check with the operator"
    printf '%s\n' "$SCAN" >> "$KNOWN" && chmod 600 "$KNOWN"
    echo "added $HOST's host key ($FP) to $KNOWN"
    ;;
  install)
    TARGET="${2:-}"; PORT="${3:-7400}"; SSHPORT="${4:-22}"
    [[ "$TARGET" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || die "usage: tunnel.sh install <user>@<host> [port] [ssh-port]"
    [[ "$PORT" =~ ^[0-9]+$ && "$SSHPORT" =~ ^[0-9]+$ ]] || die "ports are numbers"
    [ -f "$KEY" ] || die "no tunnel key: tunnel.sh keygen first"
    HOST="${TARGET#*@}"
    ssh-keygen -F "$(hostkey_name "$HOST" "$SSHPORT")" -f "$KNOWN" >/dev/null 2>&1 \
      || die "$HOST's host key isn't in $KNOWN. Get its fingerprint from the operator aloud, then: tunnel.sh known-host $HOST SHA256:… $SSHPORT"
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
    <string>-F</string><string>/dev/null</string>
    <string>-N</string>
    <string>-T</string>
    <string>-p</string><string>$SSHPORT</string>
    <string>-L</string><string>127.0.0.1:$PORT:127.0.0.1:7400</string>
    <string>-i</string><string>$KEY</string>
    <string>-o</string><string>IdentitiesOnly=yes</string>
    <string>-o</string><string>BatchMode=yes</string>
    <string>-o</string><string>StrictHostKeyChecking=yes</string>
    <string>-o</string><string>UserKnownHostsFile=$KNOWN</string>
    <string>-o</string><string>GlobalKnownHostsFile=/dev/null</string>
    <string>-o</string><string>UpdateHostKeys=no</string>
    <string>-o</string><string>ControlMaster=no</string>
    <string>-o</string><string>ControlPath=none</string>
    <string>-o</string><string>ExitOnForwardFailure=yes</string>
    <string>-o</string><string>ServerAliveInterval=15</string>
    <string>-o</string><string>ServerAliveCountMax=3</string>
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
