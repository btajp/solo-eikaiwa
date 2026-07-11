#!/usr/bin/env bash
# desktop/build-sidecar.sh — `cargo tauri build` の前に同梱物一式を固定入力から組み立てる。
#
# 1. サーバを単一バイナリへ compile → desktop/src-tauri/binaries/
# 2. クライアント dist と content を Resources へコピー
# 3. lock 済み whisper.cpp source から static whisper-cli を build
# 4. Bun/Rust/native/content/artifact の SBOM・NOTICE を Resources へ生成
#
# `binaries/` と `resources/` は毎回作り直す生成物であり、コミットしない。
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
DESKTOP_DIR="$REPO_DIR/desktop"
SRC_TAURI_DIR="$DESKTOP_DIR/src-tauri"
BIN_DIR="$SRC_TAURI_DIR/binaries"
RES_DIR="$SRC_TAURI_DIR/resources"
TARGET_TRIPLE="$(rustc -vV | awk '/^host:/ { print $2 }')"

log() { echo "== $* =="; }

# compile 前に Bun/Tauri CLI の exact 版と双方の lockfile を検証する。
"$REPO_DIR/scripts/install-bun-deps.sh" all
"$REPO_DIR/scripts/check-toolchain.sh" tauri

build_server_binary() {
  log "サーバを compile 中（bun build --compile）"
  mkdir -p "$BIN_DIR"
  local out="$BIN_DIR/solo-server-${TARGET_TRIPLE}"
  (cd "$REPO_DIR/app" && bun build --compile server/index.ts --outfile "$out")
  chmod +x "$out"
  log "サーババイナリ: $(du -h "$out" | cut -f1)"
}

copy_client_dist() {
  log "クライアントを build 中"
  (cd "$REPO_DIR/app/client" && bun run build)
  rm -rf "$RES_DIR/dist"
  mkdir -p "$RES_DIR"
  cp -R "$REPO_DIR/app/client/dist" "$RES_DIR/dist"
  log "dist: $(du -sh "$RES_DIR/dist" | cut -f1)"
}

copy_content() {
  log "content/ をコピー中"
  rm -rf "$RES_DIR/content"
  cp -R "$REPO_DIR/content" "$RES_DIR/content"
  log "content: $(du -sh "$RES_DIR/content" | cut -f1)"
}

build_fixed_whisper() {
  log "固定 source から whisper-cli を build 中"
  "$REPO_DIR/scripts/build-native-whisper.sh" --output "$RES_DIR/whisper-bin"
  log "whisper-bin: $(du -sh "$RES_DIR/whisper-bin" | cut -f1)"
}

generate_provenance() {
  log "SBOM と第三者 NOTICE を生成中"
  bun "$REPO_DIR/scripts/desktop-provenance.ts" \
    --repo "$REPO_DIR" \
    --resources "$RES_DIR" \
    --output "$RES_DIR/provenance"
}

build_server_binary
copy_client_dist
copy_content
build_fixed_whisper
generate_provenance

log "完了"
du -sh "$BIN_DIR" "$RES_DIR"/* 2>/dev/null | sed 's/^/  /'
echo
echo "次に: cd desktop/src-tauri && cargo tauri build --bundles app"
