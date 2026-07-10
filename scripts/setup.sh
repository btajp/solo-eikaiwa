#!/usr/bin/env bash
set -euo pipefail
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
cd "$REPO_DIR"

echo "== solo-eikaiwa setup =="

command -v brew >/dev/null || { echo "ERROR: Homebrew が必要です"; exit 1; }
command -v bun >/dev/null || { echo "ERROR: bun が必要です (https://bun.sh)"; exit 1; }
"$REPO_DIR/scripts/install-bun-deps.sh" all

for pkg in whisper-cpp ffmpeg; do
  if ! brew list "$pkg" >/dev/null 2>&1; then
    echo "-- brew install $pkg"
    brew install "$pkg"
  fi
done

WHISPER_BIN="$(command -v whisper-cli || command -v whisper-cpp || true)"
[ -n "$WHISPER_BIN" ] || { echo "ERROR: whisper-cli が見つかりません"; exit 1; }
echo "whisper: $WHISPER_BIN"

mkdir -p models
MODEL=models/ggml-large-v3-turbo.bin
if [ ! -f "$MODEL" ]; then
  echo "-- モデルをダウンロード (~1.6GB)"
  curl -fL --retry 3 -o "$MODEL.tmp" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
  mv "$MODEL.tmp" "$MODEL"
fi
echo "model: $MODEL ($(du -h "$MODEL" | cut -f1))"

command -v claude >/dev/null || { echo "ERROR: claude CLI が必要です"; exit 1; }
echo "claude: $(command -v claude)"

if [ ! -f app/.env ]; then
  cp app/.env.example app/.env
  echo "NOTE: app/.env を作成しました。OPENAI_API_KEY を設定すると高品質TTSになります（未設定なら say フォールバック）"
fi

echo "== setup 完了 =="
