#!/usr/bin/env bash
# LaunchAgent (com.local.learn-english.server) から呼ばれるラッパー。
# zsh -lc でログインシェルを経由することで、~/.zshenv 等で export された
# $OPENAI_API_KEY_LEARN (app/.env が参照する変数) が解決される。
# シークレットは plist にも本スクリプトにも書かない。
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"

exec /bin/zsh -lc "
set -euo pipefail
cd '${REPO_DIR}/app'

if command -v bun >/dev/null 2>&1; then
  BUN_BIN=\$(command -v bun)
elif [[ -x \"\$HOME/.bun/bin/bun\" ]]; then
  BUN_BIN=\"\$HOME/.bun/bin/bun\"
elif [[ -x /opt/homebrew/bin/bun ]]; then
  BUN_BIN=/opt/homebrew/bin/bun
else
  echo 'ERROR: bun が見つかりません (PATH / ~/.bun/bin / /opt/homebrew/bin を確認)' >&2
  exit 1
fi

exec \"\$BUN_BIN\" server/index.ts
"
