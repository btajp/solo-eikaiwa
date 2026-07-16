#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
CHECK_TOOLCHAIN="$REPO_DIR/scripts/check-toolchain.sh"
INSTALL_BUN_DEPS="$REPO_DIR/scripts/install-bun-deps.sh"
AUDIT_DEPS="$REPO_DIR/scripts/audit-dependencies.sh"
CREATED_DESKTOP_PATHS=()

log() { echo "== verify: $* =="; }

verify_core() {
  "$INSTALL_BUN_DEPS" all

  # 検証ビルドは配信用の app/client/dist と分離した dist-verify へ出力する。
  # dist は常駐サーバが直配信しているため、検証ゲートの実行がデプロイにならないようにする
  # （配信 dist を更新するのは AGENTS.md「デプロイ」節の明示手順だけ）。
  log "client build (dist-verify)"
  (cd "$REPO_DIR/app/client" && bun run build:verify)

  log "TypeScript"
  (cd "$REPO_DIR/app" && bun run typecheck)

  log "ShellCheck"
  command -v shellcheck >/dev/null 2>&1 || {
    echo "ERROR: shellcheckが必要です" >&2
    return 1
  }
  # Tauriはbundle中にtarget配下へ外部由来のbundle_dmg.shを生成する。途中失敗後の再検証でも
  # リポジトリ管理下のscriptだけを検査できるよう、build生成物のtargetは探索しない。
  find "$REPO_DIR/scripts" "$REPO_DIR/desktop" \
    -type d -name target -prune -o \
    -type f -name '*.sh' -print0 | xargs -0 shellcheck

  log "Bun tests"
  (cd "$REPO_DIR/app" && bun test)

  log "desktop provenance tests"
  (cd "$REPO_DIR" && bun test scripts/__tests__/desktop-provenance.test.ts)

  log "content coverage"
  (cd "$REPO_DIR" && bun scripts/check-content-coverage.ts)

  log "spoken register"
  (cd "$REPO_DIR" && bun scripts/check-spoken-register.ts)

  # CI の accessibility ジョブと同じ Playwright 検査（axe による a11y 回帰を含む）。
  # CI の core ジョブは専用の accessibility ジョブが同一検査を必須チェックとして実行するため、
  # VERIFY_SKIP_A11Y=1 で重複実行だけを省略する（ローカルと release では常に実行）。
  log "client a11y (Playwright)"
  if [[ "${VERIFY_SKIP_A11Y:-0}" == "1" ]]; then
    echo "-- VERIFY_SKIP_A11Y=1: CIのaccessibilityジョブが同一検査を実行するため省略"
  else
    (cd "$REPO_DIR/app/client" && bunx playwright install chromium)
    (cd "$REPO_DIR/app/client" && bun run test:a11y)
  fi
}

remember_dir() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    mkdir -p "$dir"
    CREATED_DESKTOP_PATHS+=("$dir")
  fi
}

prepare_desktop_fixtures() {
  local src="$REPO_DIR/desktop/src-tauri"
  local target_triple binary
  target_triple="$(rustc -vV | awk '/^host:/ { print $2 }')"

  remember_dir "$src/binaries"
  binary="$src/binaries/solo-server-$target_triple"
  if [[ ! -e "$binary" ]]; then
    printf '#!/bin/sh\nexit 0\n' > "$binary"
    chmod +x "$binary"
    CREATED_DESKTOP_PATHS+=("$binary")
  fi

  remember_dir "$src/resources"
  remember_dir "$src/resources/dist"
  remember_dir "$src/resources/content"
  remember_dir "$src/resources/whisper-bin"
  remember_dir "$src/resources/provenance"
}

cleanup_desktop_fixtures() {
  local i path_to_remove
  for ((i=${#CREATED_DESKTOP_PATHS[@]} - 1; i >= 0; i--)); do
    path_to_remove="${CREATED_DESKTOP_PATHS[$i]}"
    if [[ -d "$path_to_remove" ]]; then
      rmdir "$path_to_remove" 2>/dev/null || true
    else
      rm -f "$path_to_remove"
    fi
  done
  CREATED_DESKTOP_PATHS=()
}

verify_desktop() {
  command -v cargo >/dev/null 2>&1 || { echo "ERROR: cargoが必要です" >&2; return 1; }
  command -v rustc >/dev/null 2>&1 || { echo "ERROR: rustcが必要です" >&2; return 1; }
  prepare_desktop_fixtures

  local test_status=0 clippy_status=0
  log "cargo test --locked"
  (cd "$REPO_DIR/desktop/src-tauri" && cargo test --locked --lib) || test_status=$?

  log "cargo clippy --locked"
  (cd "$REPO_DIR/desktop/src-tauri" && cargo clippy --locked --all-targets -- -D warnings) || clippy_status=$?
  cleanup_desktop_fixtures

  [[ "$test_status" -eq 0 ]] || return "$test_status"
  [[ "$clippy_status" -eq 0 ]] || return "$clippy_status"
}

verify_audit() {
  "$CHECK_TOOLCHAIN" audit
  "$AUDIT_DEPS"
}

case "${1:-pr}" in
  pr) verify_core ;;
  desktop) verify_desktop ;;
  audit) verify_audit ;;
  release)
    "$CHECK_TOOLCHAIN" all
    verify_core
    verify_desktop
    verify_audit
    ;;
  *)
    echo "使い方: $0 [pr|desktop|audit|release]" >&2
    exit 2
    ;;
esac
