#!/usr/bin/env bash
# LaunchAgent (com.local.solo-eikaiwa.server) から呼ばれるラッパー。
# ログインシェルはPATH取得だけに限定し、3秒で応答しなければkillしてlaunchdの継承PATHへ戻す。
# サーバ本体をzsh配下で実行しないため、壊れたshell初期化で無応答プロセスにならない。
# APIキーはサポート対象のmacOS Keychainまたはapp/.envからサーバ自身が読み込む。
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
LOGIN_SHELL_BIN="${SOLO_EIKAIWA_LOGIN_SHELL_BIN:-/bin/zsh}"
LOGIN_SHELL_PATH_TIMEOUT_ATTEMPTS="${SOLO_EIKAIWA_LOGIN_SHELL_PATH_TIMEOUT_ATTEMPTS:-30}"
LOGIN_SHELL_PATH_POLL_INTERVAL="${SOLO_EIKAIWA_LOGIN_SHELL_PATH_POLL_INTERVAL:-0.1}"
INHERITED_PATH="${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

# テスト注入値や誤った手動設定でtimeout自体が無効にならないよう既定値へ戻す。
if ! [[ "$LOGIN_SHELL_PATH_TIMEOUT_ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  LOGIN_SHELL_PATH_TIMEOUT_ATTEMPTS=30
fi
if ! [[ "$LOGIN_SHELL_PATH_POLL_INTERVAL" =~ ^(0\.[0-9]+|[1-9][0-9]*(\.[0-9]+)?)$ ]]; then
  LOGIN_SHELL_PATH_POLL_INTERVAL=0.1
fi

capture_login_shell_path() {
  local output_file pid attempt status output rest value
  if [[ ! -x "$LOGIN_SHELL_BIN" ]]; then
    echo "WARN: ログインシェルが見つかりません。継承PATHを使用します" >&2
    return 1
  fi

  output_file="$(mktemp "${TMPDIR:-/tmp}/solo-eikaiwa-path.XXXXXX")"
  chmod 600 "$output_file"
  # $PATHは親bashではなく起動したログインシェル側で展開する。
  # shellcheck disable=SC2016
  "$LOGIN_SHELL_BIN" -lc 'printf "<SOLO_EIKAIWA_PATH>%s</SOLO_EIKAIWA_PATH>" "$PATH"' \
    >"$output_file" 2>/dev/null &
  pid=$!

  for ((attempt = 0; attempt < LOGIN_SHELL_PATH_TIMEOUT_ATTEMPTS; attempt++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      status=0
      wait "$pid" || status=$?
      if [[ "$status" -ne 0 ]]; then
        rm -f "$output_file"
        echo "WARN: ログインシェルのPATH取得に失敗しました。継承PATHを使用します" >&2
        return 1
      fi
      output="$(<"$output_file")"
      rm -f "$output_file"
      rest="${output#*<SOLO_EIKAIWA_PATH>}"
      if [[ "$rest" == "$output" || "$rest" != *"</SOLO_EIKAIWA_PATH>"* ]]; then
        echo "WARN: ログインシェルのPATHを解析できません。継承PATHを使用します" >&2
        return 1
      fi
      value="${rest%%</SOLO_EIKAIWA_PATH>*}"
      if [[ -z "$value" ]]; then
        echo "WARN: ログインシェルのPATHが空です。継承PATHを使用します" >&2
        return 1
      fi
      printf '%s' "$value"
      return 0
    fi
    /bin/sleep "$LOGIN_SHELL_PATH_POLL_INTERVAL"
  done

  echo "WARN: ログインシェルのPATH取得がtimeoutしました。子プロセスを終了して継承PATHを使用します" >&2
  kill -TERM "$pid" 2>/dev/null || true
  for ((attempt = 0; attempt < 10; attempt++)); do
    kill -0 "$pid" 2>/dev/null || break
    /bin/sleep 0.05
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
  fi
  wait "$pid" 2>/dev/null || true
  rm -f "$output_file"
  return 1
}

if login_path="$(capture_login_shell_path)"; then
  PATH="$login_path"
else
  PATH="$INHERITED_PATH"
fi
export PATH

cd "$REPO_DIR/app"
if command -v bun >/dev/null 2>&1; then
  BUN_BIN="$(command -v bun)"
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  BUN_BIN="$HOME/.bun/bin/bun"
elif [[ -x /opt/homebrew/bin/bun ]]; then
  BUN_BIN=/opt/homebrew/bin/bun
else
  echo "ERROR: bun が見つかりません (PATH / ~/.bun/bin / /opt/homebrew/bin を確認)" >&2
  exit 1
fi

exec "$BUN_BIN" server/index.ts
