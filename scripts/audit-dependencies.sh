#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
VULNERABILITIES=10
INFRA_FAILURE=20
overall=0

record_status() {
  local status="$1"
  if [[ "$status" -eq "$INFRA_FAILURE" ]]; then
    overall="$INFRA_FAILURE"
  elif [[ "$status" -eq "$VULNERABILITIES" && "$overall" -eq 0 ]]; then
    overall="$VULNERABILITIES"
  fi
}

audit_bun() {
  local source="$1"
  local dir="$2"
  local status tmp
  tmp="$(mktemp -d)"
  set +e
  (cd "$dir" && bun audit --json >"$tmp/out" 2>"$tmp/err")
  status=$?
  set -e
  # stdout（監査結果JSON）とstderr（bunの通知・バナー等）を分離し、公開アセットへは
  # 整形済みstdoutのみが入るようにする（#243）。stderrは診断用に端末側へそのまま流す。
  [[ ! -s "$tmp/out" ]] || cat "$tmp/out"
  [[ ! -s "$tmp/err" ]] || cat "$tmp/err" >&2
  rm -rf "$tmp"
  case "$status" in
    0) echo "AUDIT_OK source=$source" ;;
    1)
      echo "AUDIT_VULNERABILITIES source=$source" >&2
      return "$VULNERABILITIES"
      ;;
    *)
      echo "AUDIT_INFRA_FAILURE source=$source exit=$status" >&2
      return "$INFRA_FAILURE"
      ;;
  esac
}

audit_cargo() {
  local status tmp source
  if ! command -v cargo >/dev/null 2>&1 || ! cargo audit --version >/dev/null 2>&1; then
    echo "AUDIT_INFRA_FAILURE source=cargo-tool reason=missing-cargo-audit" >&2
    return "$INFRA_FAILURE"
  fi

  tmp="$(mktemp -d)"
  set +e
  cargo audit --json --file "$REPO_DIR/desktop/src-tauri/Cargo.lock" >"$tmp/out" 2>"$tmp/err"
  status=$?
  set -e
  case "$status" in
    0)
      rm -rf "$tmp"
      echo "AUDIT_OK source=cargo"
      ;;
    *)
      if python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$tmp/out" >/dev/null 2>&1; then
        cat "$tmp/out"
        [[ ! -s "$tmp/err" ]] || cat "$tmp/err" >&2
        rm -rf "$tmp"
        echo "AUDIT_VULNERABILITIES source=cargo" >&2
        return "$VULNERABILITIES"
      fi
      source=cargo-tool
      if grep -Eiq 'fetch|network|advisory database|database.*(clone|update)' "$tmp/err"; then
        source=cargo-db
      fi
      [[ ! -s "$tmp/out" ]] || cat "$tmp/out"
      [[ ! -s "$tmp/err" ]] || cat "$tmp/err" >&2
      rm -rf "$tmp"
      echo "AUDIT_INFRA_FAILURE source=$source exit=$status" >&2
      return "$INFRA_FAILURE"
      ;;
  esac
}

for check in bun-app bun-client cargo; do
  status=0
  case "$check" in
    bun-app) audit_bun bun-app "$REPO_DIR/app" || status=$? ;;
    bun-client) audit_bun bun-client "$REPO_DIR/app/client" || status=$? ;;
    cargo) audit_cargo || status=$? ;;
  esac
  record_status "$status"
done

exit "$overall"
