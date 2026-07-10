#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
TOOLCHAIN_FILE="$REPO_DIR/toolchain.json"

read_version() {
  local key="$1"
  local value
  value="$(sed -En 's/^[[:space:]]*"'"$key"'"[[:space:]]*:[[:space:]]*"([0-9]+\.[0-9]+\.[0-9]+)"[,]?[[:space:]]*$/\1/p' "$TOOLCHAIN_FILE")"
  if [[ -z "$value" ]]; then
    echo "ERROR: toolchain.json の $key がexact semverではありません" >&2
    exit 1
  fi
  printf '%s' "$value"
}

check_bun() {
  local expected actual
  expected="$(read_version bun)"
  if ! command -v bun >/dev/null 2>&1; then
    echo "ERROR: Bun version mismatch: expected=$expected actual=missing" >&2
    exit 1
  fi
  actual="$(bun --version 2>/dev/null | head -n 1 | tr -d '\r')"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: Bun version mismatch: expected=$expected actual=${actual:-unknown}" >&2
    exit 1
  fi
  echo "OK: Bun $actual"
}

check_tauri() {
  local expected output actual
  expected="$(read_version tauriCli)"
  if ! command -v cargo >/dev/null 2>&1; then
    echo "ERROR: Tauri CLI version mismatch: expected=$expected actual=missing" >&2
    exit 1
  fi
  if ! output="$(cargo tauri --version 2>&1)"; then
    echo "ERROR: Tauri CLI version mismatch: expected=$expected actual=missing" >&2
    exit 1
  fi
  actual="${output#tauri-cli }"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: Tauri CLI version mismatch: expected=$expected actual=${actual:-unknown}" >&2
    exit 1
  fi
  echo "OK: Tauri CLI $actual"
}

case "${1:-all}" in
  bun) check_bun ;;
  tauri) check_tauri ;;
  all)
    check_bun
    check_tauri
    ;;
  *)
    echo "使い方: $0 [bun|tauri|all]" >&2
    exit 2
    ;;
esac
