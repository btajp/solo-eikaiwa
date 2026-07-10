#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
"$REPO_DIR/scripts/check-toolchain.sh" bun

install_frozen() {
  local dir="$1"
  [[ -d "$dir" ]] || { echo "ERROR: 依存ディレクトリがありません: $dir" >&2; exit 1; }
  echo "-- frozen lockfileから依存を準備: ${dir#"$REPO_DIR/"}"
  (cd "$dir" && bun install --frozen-lockfile)
}

case "${1:-all}" in
  app) install_frozen "$REPO_DIR/app" ;;
  client) install_frozen "$REPO_DIR/app/client" ;;
  all)
    install_frozen "$REPO_DIR/app"
    install_frozen "$REPO_DIR/app/client"
    ;;
  *)
    echo "使い方: $0 [app|client|all]" >&2
    exit 2
    ;;
esac
