#!/usr/bin/env bash
# solo-eikaiwa API サーバを LaunchAgent として常駐化する。
# 使い方:
#   ./scripts/install-daemon.sh                  # クライアントビルド → plist生成 → 常駐登録
#   ./scripts/install-daemon.sh --plist-only <path>  # plist生成のみ（テスト用、常駐登録はしない）
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
LABEL="com.local.solo-eikaiwa.server"
# 旧名（learn-english）からの移行: 旧デーモンが残っていれば解除する（v0.20.0 リネーム対応・冪等）
OLD_LABEL="com.local.learn-english.server"
if launchctl print "gui/$(id -u)/$OLD_LABEL" >/dev/null 2>&1; then
  echo "-- 旧デーモン ($OLD_LABEL) を解除します"
  launchctl bootout "gui/$(id -u)/$OLD_LABEL" 2>/dev/null || true
fi
rm -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"
DAEMON_SCRIPT="$REPO_DIR/scripts/daemon-server.sh"
LOG_DIR="$REPO_DIR/data/logs"
PLIST_PATH="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}/${LABEL}.plist"

generate_plist() {
  local out="$1"
  mkdir -p "$(dirname -- "$out")"
  cat > "$out" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${DAEMON_SCRIPT}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_DIR}/app</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/server.stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/server.stderr.log</string>
</dict>
</plist>
PLIST
}

# --plist-only: plist生成のみ行うテスト用モード（ビルドや常駐登録はしない）
if [[ "${1:-}" == "--plist-only" ]]; then
  out="${2:?使い方: $0 --plist-only <出力先パス>}"
  generate_plist "$out"
  echo "plist を生成しました: $out"
  exit 0
fi

echo "== solo-eikaiwa daemon install =="

# server/client双方を、Bun版とlockfileを検証してから準備する。
"$REPO_DIR/scripts/install-bun-deps.sh" all

# 1. ポート3111が dev サーバ (bun run dev) で使用中でないか確認してから進める
if lsof_pids="$(lsof -nP -ti :3111 2>/dev/null)" && [[ -n "$lsof_pids" ]]; then
  pid="$(echo "$lsof_pids" | head -1)"
  cmd="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  echo "ERROR: ポート3111は既に使用中です (PID $pid: $cmd)" >&2
  echo "       'cd app && bun run dev' が起動中の場合は、先にそれを停止してから再実行してください。" >&2
  exit 1
fi

# 2. クライアントビルド（失敗したら中断）
echo "-- クライアントビルド"
if ! (cd "$REPO_DIR/app/client" && bun run build); then
  echo "ERROR: クライアントビルドに失敗しました" >&2
  exit 1
fi

# 3. plist生成
mkdir -p "$LOG_DIR"
generate_plist "$PLIST_PATH"
echo "plist を生成しました: $PLIST_PATH"

# 4. 再登録 (bootout → bootstrap → enable)
UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}" "$PLIST_PATH" 2>/dev/null || true
launchctl bootstrap "gui/${UID_NUM}" "$PLIST_PATH"
launchctl enable "gui/${UID_NUM}/${LABEL}"

# 5. ヘルスチェック待ち（最大約10秒）
echo "-- サーバ起動待ち"
health=""
for _ in $(seq 1 20); do
  if health="$(curl -fsS http://127.0.0.1:3111/api/health 2>/dev/null)"; then
    break
  fi
  health=""
  sleep 0.5
done
if [[ -z "$health" ]]; then
  echo "ERROR: サーバが起動しませんでした。ログを確認してください: $LOG_DIR/server.stderr.log" >&2
  exit 1
fi
echo "health: $health"

# 6. 共有Caddyの反映状況を確認（このスクリプト自体はsudoを使わない）
echo ""
echo "-- https://solo-eikaiwa の現況確認"
site_body="$(curl -sk --max-time 3 https://solo-eikaiwa/ 2>/dev/null || true)"
if [[ -z "$site_body" ]]; then
  echo "https://solo-eikaiwa に到達できませんでした（共有Caddyが未起動の可能性があります）"
elif echo "$site_body" | grep -q '/src/main.tsx'; then
  echo "NOTE: https://solo-eikaiwa はまだ旧設定（Viteへのproxy）を返しています。下記コマンドで反映してください。"
elif echo "$site_body" | grep -q '/assets/'; then
  echo "OK: https://solo-eikaiwa は新しい静的配信設定を返しています。"
else
  echo "https://solo-eikaiwa の応答内容から新旧を判定できませんでした。以下のコマンドで反映してから確認してください。"
fi

echo ""
echo "== インストール完了 =="
echo "共有Caddy(com.local.https.caddy)に新しいCaddyfileを反映するには、以下を手動で実行してください:"
echo "  sudo launchctl kickstart -k system/com.local.https.caddy"
