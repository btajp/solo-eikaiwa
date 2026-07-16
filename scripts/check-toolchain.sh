#!/usr/bin/env bash
# toolchain.json にpinしたexact versionと実環境のツールの一致を検査する。
# 使い方: ./scripts/check-toolchain.sh [bun|tauri|audit|all]
# モードごとの検査対象:
#   bun   … Bun のみ
#   tauri … Tauri CLI（cargo tauri）のみ
#   audit … Bun + cargo-audit（verify.sh audit と release-desktop.sh の preflight が使用）
#   all   … Bun + Tauri CLI（cargo-audit と cmake は含まない。リリース前提の一括確認は
#           release-desktop.sh 冒頭の preflight = audit モード + cmake/gh 存在確認で行う）
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

check_cargo_audit() {
  local expected output actual
  expected="$(read_version cargoAudit)"
  if ! command -v cargo >/dev/null 2>&1 || ! output="$(cargo audit --version 2>&1)"; then
    echo "ERROR: cargo-audit version mismatch: expected=$expected actual=missing" >&2
    exit 1
  fi
  actual="${output##* }"
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: cargo-audit version mismatch: expected=$expected actual=${actual:-unknown}" >&2
    exit 1
  fi
  echo "OK: cargo-audit $actual"
}

case "${1:-all}" in
  bun) check_bun ;;
  tauri) check_tauri ;;
  audit)
    check_bun
    check_cargo_audit
    ;;
  all)
    check_bun
    check_tauri
    ;;
  *)
    echo "使い方: $0 [bun|tauri|audit|all]" >&2
    exit 2
    ;;
esac
