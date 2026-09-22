#!/usr/bin/env bash
# Syncs Harness into the checkout, transpiles (fast, esbuild), and launches the dev build.
# Extra arguments go to the IDE, e.g. `scripts/dev.sh /path/to/a/repo`.
set -euo pipefail
source "$(dirname "$0")/env.sh"
"$IDE_DIR/scripts/sync.sh"
cd "$VSCODE_DIR"
# The icon font is copied into the source tree, then transpile carries it into out/.
[ -f src/vs/base/browser/ui/codicons/codicon/codicon.ttf ] || npm run --silent gulp copy-codicons
npm run --silent transpile-client
exec ./scripts/code.sh "$@"
