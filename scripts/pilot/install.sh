#!/usr/bin/env bash
# The pilot's pinned runtime (D-110): harnessd, the CLI and the UI bridge run from ~/harness-runtime/<sha>, an exact
# commit of the harness, never from a development checkout. Agents never replace a running daemon. A new SHA is
# installed beside the old one and promoted only while harnessd is stopped (its sessions stopped, their work kept).
#   install.sh install <sha> [<remote>]   clone that exact commit into ~/harness-runtime/<sha>, verify it, npm ci
#   install.sh promote <sha>              point ~/harness-runtime/current at it (refused while harnessd runs)
#   install.sh status                     what's installed, what's current, and whether harnessd runs
# Wrappers in ~/harness-runtime/bin (put it on PATH): `harness` and `harnessd` run the current runtime.
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
      printf '#!/usr/bin/env bash\n# The pilot runtime'"'"'s %s (install.sh): always the promoted one, on Node 24.\nexec "%s" "%s/current/%s" "$@"\n' "$name" "$NODE" "$ROOT" "$target" > "$ROOT/bin/$name"
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
    running && die "harnessd is running from $ROOT: stop it first (its sessions stop, their work stays), then promote"
    ln -sfn "$SHA" "$ROOT/current.tmp" && mv -fh "$ROOT/current.tmp" "$ROOT/current"
    echo "current → $SHA. Start harnessd again, then run harness doctor."
    ;;
  status)
    echo "runtimes in $ROOT:"; for d in "$ROOT"/*; do [ -d "$d/.git" ] && [ ! -L "$d" ] && echo "  $(basename "$d")"; done
    echo "current → $(readlink "$ROOT/current" 2>/dev/null || echo none)"
    if running; then echo "harnessd: running"; else echo "harnessd: not running"; fi
    ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
