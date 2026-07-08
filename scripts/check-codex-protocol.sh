#!/usr/bin/env bash
# codex app-server プロトコルの破壊的変更検出（手動/リリース前実行・CI非依存）。
# 使い方: ./scripts/check-codex-protocol.sh
#
# 注意: `codex app-server generate-json-schema` はスキーマ定義の JSON キー順が
# プロセスごとに変わる（内容は同一でも順序が非決定的）。素の diff だと毎回
# 差分ありと誤検知するため、比較前に jq -S でキーを正規化(ソート)する。
set -euo pipefail
cd "$(dirname "$0")/.."
command -v jq >/dev/null 2>&1 || { echo "jq が見つかりません。'brew install jq' 等でインストールしてください"; exit 2; }
SNAPSHOT="app/server/providers/codex-protocol.snapshot.json"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
codex app-server generate-json-schema --out "$TMP" >/dev/null
GENERATED=$(find "$TMP" -name '*v2*.json' | head -1)
[ -n "$GENERATED" ] || { echo "生成物にv2スキーマが見つかりません"; exit 2; }
SNAPSHOT_CANON="$TMP/snapshot.canon.json"
GENERATED_CANON="$TMP/generated.canon.json"
jq -S . "$SNAPSHOT" > "$SNAPSHOT_CANON"
jq -S . "$GENERATED" > "$GENERATED_CANON"
if diff -q "$SNAPSHOT_CANON" "$GENERATED_CANON" >/dev/null; then
  echo "OK: プロトコルはスナップショット($(codex --version))と一致"
else
  echo "WARN: プロトコルがスナップショットから変化しています。diff を確認し、アダプタ検証後にスナップショットを更新してください:"
  diff "$SNAPSHOT_CANON" "$GENERATED_CANON" | head -40
  exit 1
fi
