#!/usr/bin/env bash
# learn-english API サーバの LaunchAgent 常駐を解除する。
set -euo pipefail

LABEL="com.local.learn-english.server"
PLIST_PATH="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}/${LABEL}.plist"
UID_NUM="$(id -u)"

echo "== learn-english daemon uninstall =="

launchctl bootout "gui/${UID_NUM}" "$PLIST_PATH" 2>/dev/null || true
echo "launchctl bootout 完了（未登録だった場合はno-op）"

if [[ -f "$PLIST_PATH" ]]; then
  rm -f "$PLIST_PATH"
  echo "plist を削除しました: $PLIST_PATH"
else
  echo "plist は存在しませんでした: $PLIST_PATH"
fi

echo "== アンインストール完了 =="
