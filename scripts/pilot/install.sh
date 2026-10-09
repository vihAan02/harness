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
need_node() {
  local v; v="$(node -v 2>/dev/null || true)"
  [[ "$v" =~ ^v24\. ]] || die "the pilot runs on Node 24 (this is ${v:-no node}); both Macs use the same version"
  echo "$v"
}
running() { pgrep -f "$ROOT/.*/packages/daemon/src/main.ts" >/dev/null 2>&1; }

case "${1:-}" in
  install)
    SHA="${2:-}"; REMOTE="${3:-$REMOTE_DEFAULT}"
    [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "give the full 40-character commit id (the candidate both Macs run)"
    NODE="$(need_node)"
    DIR="$ROOT/$SHA"
    if [ -d "$DIR/.git" ]; then
      [ "$(git -C "$DIR" rev-parse HEAD)" = "$SHA" ] || die "$DIR exists at another commit; remove it by hand"
      [ -z "$(git -C "$DIR" status --porcelain)" ] || die "$DIR has local changes; a runtime is never edited (remove it and install again)"
      echo "$DIR already installed at $SHA"
    else
      mkdir -p "$ROOT"
      git clone -q --no-checkout "$REMOTE" "$DIR"
      git -C "$DIR" -c advice.detachedHead=false checkout -q --detach "$SHA"
      [ "$(git -C "$DIR" rev-parse HEAD)" = "$SHA" ] || die "checked out something other than $SHA"
      (cd "$DIR" && npm ci --no-audit --no-fund >/dev/null)
      echo "installed $SHA at $DIR (node $NODE)"
    fi
    mkdir -p "$ROOT/bin"
    for name in harness harnessd; do
      target=$([ "$name" = harness ] && echo packages/cli/src/main.ts || echo packages/daemon/src/main.ts)
      printf '#!/usr/bin/env bash\n# The pilot runtime'"'"'s %s (install.sh): always the promoted one.\nexec node "%s/current/%s" "$@"\n' "$name" "$ROOT" "$target" > "$ROOT/bin/$name"
      chmod 755 "$ROOT/bin/$name"
    done
    [ -e "$ROOT/current" ] || { ln -s "$SHA" "$ROOT/current"; echo "current → $SHA"; }
    ;;
  promote)
    SHA="${2:-}"
    [ -d "$ROOT/$SHA/.git" ] || die "$SHA isn't installed: install.sh install $SHA"
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
