#!/usr/bin/env bash
# リリース署名後の whisper-cli の実ファイルhashをnative manifestへ反映する。
set -euo pipefail

usage() {
  cat <<'USAGE'
使い方: scripts/refresh-native-manifest.sh [--lock <path>] [--output <whisper-bin-dir>]

release署名で変わる whisper-cli の SHA-256/bytes を更新し、lockとの対応を検証します。
USAGE
}

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
LOCK_FILE="$REPO_DIR/desktop/native-deps.lock.json"
OUTPUT_DIR="$REPO_DIR/desktop/src-tauri/resources/whisper-bin"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lock) LOCK_FILE="${2:-}"; shift 2 ;;
    --output) OUTPUT_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: 未知の引数です: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for command in shasum stat python3; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "ERROR: $command が必要です" >&2
    exit 1
  }
done

MANIFEST="$OUTPUT_DIR/native-dependencies.json"
BINARY="$OUTPUT_DIR/whisper-cli"
[[ -f "$LOCK_FILE" && -f "$MANIFEST" && -f "$BINARY" ]] || {
  echo "ERROR: native lock、manifest、whisper-cli が揃っていません" >&2
  exit 1
}

LOCK_SHA256="$(shasum -a 256 "$LOCK_FILE" | awk '{print $1}')"
BINARY_SHA256="$(shasum -a 256 "$BINARY" | awk '{print $1}')"
BINARY_BYTES="$(stat -f '%z' "$BINARY")"

LOCK_SHA256="$LOCK_SHA256" \
BINARY_SHA256="$BINARY_SHA256" \
BINARY_BYTES="$BINARY_BYTES" \
MANIFEST="$MANIFEST" \
python3 - <<'PY'
import json
import os
import re
from pathlib import Path

path = Path(os.environ["MANIFEST"])
try:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    artifacts = manifest["artifacts"]
except (OSError, ValueError, KeyError, TypeError) as error:
    raise SystemExit(f"ERROR: native manifest の形式が不正です: {error}")

if manifest.get("schemaVersion") != 1:
    raise SystemExit("ERROR: native manifest の schemaVersion が不正です")
if manifest.get("lockSha256") != os.environ["LOCK_SHA256"]:
    raise SystemExit("ERROR: native manifest と lock file の SHA-256 が一致しません")
matches = [item for item in artifacts if isinstance(item, dict) and item.get("path") == "whisper-cli"]
if len(matches) != 1:
    raise SystemExit("ERROR: native manifest に whisper-cli artifact がありません")
if not re.fullmatch(r"[0-9a-f]{64}", os.environ["BINARY_SHA256"]):
    raise SystemExit("ERROR: whisper-cli SHA-256 が不正です")

matches[0]["sha256"] = os.environ["BINARY_SHA256"]
matches[0]["bytes"] = int(os.environ["BINARY_BYTES"])
path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "OK: native manifest refreshed ($BINARY_SHA256)"
