#!/usr/bin/env bash
# Re-applies Harness on top of the pinned VS Code checkout. Safe to run any time (idempotent):
#   1. restore upstream-tracked files, 2. apply patches/, 3. merge branding into product.json,
#   4. copy our new files from src/ (upstream never has these, so merges stay trivial).
set -euo pipefail
source "$(dirname "$0")/env.sh"
[ -d "$VSCODE_DIR/.git" ] || { echo "run scripts/setup.sh first" >&2; exit 1; }

git -C "$VSCODE_DIR" checkout --quiet -- .
shopt -s nullglob
for p in "$IDE_DIR"/patches/*.patch; do
  git -C "$VSCODE_DIR" apply --whitespace=nowarn "$p" || { echo "patch failed: $(basename "$p")" >&2; exit 1; }
done
node "$IDE_DIR/scripts/brand.mjs"
rsync -a "$IDE_DIR/src/" "$VSCODE_DIR/src/"
echo "==> Harness synced into $VSCODE_DIR"
