#!/usr/bin/env bash
# One-time (and after bumping UPSTREAM): fetch the pinned Node and VS Code, overlay Harness, install deps.
set -euo pipefail
source "$(dirname "$0")/env.sh"

# 1. The Node version VS Code requires, kept local to apps/ide (your own Node setup is untouched).
if [ ! -x "$NODE_HOME/bin/node" ]; then
  echo "==> Downloading Node $NODE_VERSION"
  mkdir -p "$IDE_DIR/.node"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  curl -fsSL "$base/$NODE_DIST.tar.gz" -o "$IDE_DIR/.node/$NODE_DIST.tar.gz"
  expected="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$NODE_DIST.tar.gz" '$2 == f { print $1 }')"
  actual="$(shasum -a 256 "$IDE_DIR/.node/$NODE_DIST.tar.gz" | awk '{ print $1 }')"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then echo "Node checksum mismatch" >&2; exit 1; fi
  tar -xzf "$IDE_DIR/.node/$NODE_DIST.tar.gz" -C "$IDE_DIR/.node"
  rm "$IDE_DIR/.node/$NODE_DIST.tar.gz"
fi
echo "==> Using node $(node --version)"

# 2. Upstream VS Code at the pinned tag (shallow; nothing from it is committed to this repo).
if [ ! -d "$VSCODE_DIR/.git" ]; then
  echo "==> Cloning VS Code $VSCODE_TAG"
  git clone --quiet --depth 1 --branch "$VSCODE_TAG" https://github.com/microsoft/vscode.git "$VSCODE_DIR"
  git -C "$VSCODE_DIR" checkout --quiet -b harness
fi
current="$(git -C "$VSCODE_DIR" describe --tags --exact-match HEAD~0 2>/dev/null || git -C "$VSCODE_DIR" log -1 --format=%D)"
echo "==> VS Code checkout: $current"

# 3. Harness overlay: our files, patches and branding.
"$IDE_DIR/scripts/sync.sh"

# 4. Dependencies (downloads Electron and builds native modules).
echo "==> Installing VS Code dependencies (this takes a while)"
(cd "$VSCODE_DIR" && npm ci --no-audit --no-fund)
echo "==> Setup complete. Next: apps/ide/scripts/dev.sh"
