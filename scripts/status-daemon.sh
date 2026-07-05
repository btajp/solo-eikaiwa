#!/usr/bin/env bash
# learn-english API サーバの LaunchAgent 常駐状態を確認する。
set -euo pipefail

LABEL="com.local.learn-english.server"
UID_NUM="$(id -u)"

echo "== launchctl 状態 =="
launchctl print "gui/${UID_NUM}/${LABEL}" 2>&1 | grep -E "state|pid|last exit" || echo "未登録、または起動していません"

echo ""
echo "== API ヘルスチェック (127.0.0.1:3111) =="
curl -fsS http://127.0.0.1:3111/api/health 2>&1 || echo "到達できません"

echo ""
echo "== 共有Caddy経由 (https://learn-english) =="
curl -sk --resolve learn-english:443:127.0.0.1 https://learn-english/api/health 2>&1 || echo "到達できません"
