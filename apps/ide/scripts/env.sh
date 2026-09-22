# Sourced by the other scripts: resolves paths and puts the pinned Node first on PATH.
IDE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$IDE_DIR/../.." && pwd)"
VSCODE_DIR="$IDE_DIR/vscode"
# shellcheck disable=SC1091
source "$IDE_DIR/UPSTREAM"
case "$(uname -m)" in arm64) NODE_ARCH=arm64 ;; x86_64) NODE_ARCH=x64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; esac
case "$(uname -s)" in Darwin) NODE_OS=darwin ;; Linux) NODE_OS=linux ;; *) echo "unsupported OS $(uname -s)" >&2; exit 1 ;; esac
NODE_DIST="node-v$NODE_VERSION-$NODE_OS-$NODE_ARCH"
NODE_HOME="$IDE_DIR/.node/$NODE_DIST"
export PATH="$NODE_HOME/bin:$PATH"
