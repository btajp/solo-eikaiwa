#!/usr/bin/env bash
# desktop/build-sidecar.sh — `cargo tauri build` の前に実行する: 同梱物一式を組み立てる。
#
# 1. サーバを単一バイナリへcompile（bun build --compile）→ desktop/src-tauri/binaries/
#    （Tauri externalBinの命名規則: <name>-<target-triple>。ビルダーがバンドル時にtriple部分を
#    取り除いて Contents/MacOS/solo-server として配置する）
# 2. クライアントをbuild → dist を Resources へコピー
# 3. content/ を Resources へコピー
# 4. whisper-cli 一式（本体 + 4 dylib + backendプラグイン.so 5本）をbrewから収集し、
#    install_name_tool で絶対パス依存（/opt/homebrew/opt/...）を @rpath に書き換えてから
#    Resources へコピーする（配布先にHomebrewが無くても動くようにするため）。
#
# 冪等: 毎回 desktop/src-tauri/{binaries,resources} を作り直す（差分の考慮なし・単純さ優先）。
#
# whisper-cliの同梱レイアウトが「@loader_path/lib」+「実行ファイルと同階層」を前提にしている理由は
# 下の assemble_whisper_bin() のコメントを参照。
set -euo pipefail

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
DESKTOP_DIR="$REPO_DIR/desktop"
SRC_TAURI_DIR="$DESKTOP_DIR/src-tauri"
BIN_DIR="$SRC_TAURI_DIR/binaries"
RES_DIR="$SRC_TAURI_DIR/resources"
TARGET_TRIPLE="$(rustc -vV | awk '/^host:/ { print $2 }')"

log() { echo "== $* =="; }

# compile前にBun/Tauri CLIのexact版と双方のlockfileを検証する。
"$REPO_DIR/scripts/install-bun-deps.sh" all
"$REPO_DIR/scripts/check-toolchain.sh" tauri

# ---- 1. サーババイナリのcompile ----
build_server_binary() {
  log "サーバをcompile中（bun build --compile）"
  mkdir -p "$BIN_DIR"
  local out="$BIN_DIR/solo-server-${TARGET_TRIPLE}"
  (cd "$REPO_DIR/app" && bun build --compile server/index.ts --outfile "$out")
  chmod +x "$out"
  log "サーババイナリ: $out ($(du -h "$out" | cut -f1))"
}

# ---- 2. クライアントbuild → dist コピー ----
copy_client_dist() {
  log "クライアントをbuild中"
  (cd "$REPO_DIR/app/client" && bun run build)
  rm -rf "$RES_DIR/dist"
  mkdir -p "$RES_DIR"
  cp -R "$REPO_DIR/app/client/dist" "$RES_DIR/dist"
  log "dist: $(du -sh "$RES_DIR/dist" | cut -f1)"
}

# ---- 3. content/ コピー ----
copy_content() {
  log "content/ をコピー中"
  rm -rf "$RES_DIR/content"
  cp -R "$REPO_DIR/content" "$RES_DIR/content"
  log "content: $(du -sh "$RES_DIR/content" | cut -f1)"
}

# ---- 4. whisper-cli 一式の収集 + rpath修正 ----
#
# レイアウト（Resources/whisper-bin/ 直下）:
#   whisper-cli                    実行ファイル
#   libggml-blas.so                ggmlバックエンドプラグイン（dlopen対象、実行ファイルと同階層必須）
#   libggml-cpu-apple_{m1,m2_m3,m4}.so
#   libggml-metal.so
#   lib/
#     libwhisper.1.dylib           Mach-O依存（@rpath経由でwhisper-cliからロードされる）
#     libggml.0.dylib
#     libggml-base.0.dylib
#     libomp.dylib
#
# 2つの別々の仕組みが混ざっている点に注意:
#   (a) whisper-cli本体・libwhisper.1.dylib・libggml*.dylibはMach-Oのロードコマンドで依存関係を
#       解決する（otool -L で見える）。brew版はこれを`/opt/homebrew/opt/...`という絶対パスで
#       埋め込んでいるため、配布先にHomebrewが無いと即座にダイナミックリンクエラーになる。
#       install_name_toolで@rpath参照に書き換え、whisper-cliの既存rpath（@loader_path/../lib）を
#       @loader_path/lib に変更してこのフラットなレイアウトに合わせる。
#   (b) ggmlのバックエンド選択（Metal/CPU/BLAS）はMach-Oのロードコマンドに現れない。ggml自身が
#       起動時にdlopen()で.soを探しに行く（ggml-backend-reg.cpp: ggml_backend_load_best）。
#       検索順は [GGML_BACKEND_DIR（brewビルド時に/opt/homebrew/Cellar/...へ焼き込み済み。配布先には
#       存在しないので自動的にスキップされる）] → [実行ファイル自身のディレクトリ] → [cwd]。
#       つまりbackend .soは実行ファイルと同じディレクトリに置く必要がある（lib/では見つからない）。
#       これは`otool -L`では見えない隠れた依存で、strings/upstream source確認で判明した
#       （2026-07-09調査。過去のスパイクの「2.4MB・4dylib」という記述はこのbackend .so 5本
#       （合計約2.4MB）を見落としていた）。
assemble_whisper_bin() {
  log "whisper-cli一式を収集中"
  if ! command -v brew >/dev/null 2>&1; then
    echo "ERROR: brew が見つかりません（whisper-cli/ggml/libompの収集元）" >&2
    exit 1
  fi
  local brew_prefix
  brew_prefix="$(brew --prefix)"
  for formula in whisper-cpp ggml libomp; do
    if [[ ! -d "$brew_prefix/opt/$formula" ]]; then
      echo "ERROR: brew formula '$formula' が見つかりません。'brew install $formula' を実行してください" >&2
      exit 1
    fi
  done

  local dest="$RES_DIR/whisper-bin"
  rm -rf "$dest"
  mkdir -p "$dest/lib"

  cp "$brew_prefix/bin/whisper-cli" "$dest/whisper-cli"
  cp -L "$brew_prefix/opt/whisper-cpp/lib/libwhisper.1.dylib" "$dest/lib/libwhisper.1.dylib"
  cp -L "$brew_prefix/opt/ggml/lib/libggml.0.dylib" "$dest/lib/libggml.0.dylib"
  cp -L "$brew_prefix/opt/ggml/lib/libggml-base.0.dylib" "$dest/lib/libggml-base.0.dylib"
  cp -L "$brew_prefix/opt/libomp/lib/libomp.dylib" "$dest/lib/libomp.dylib"
  local backend_sos=(libggml-blas.so libggml-cpu-apple_m1.so libggml-cpu-apple_m2_m3.so libggml-cpu-apple_m4.so libggml-metal.so)
  for so in "${backend_sos[@]}"; do
    cp "$brew_prefix/opt/ggml/libexec/$so" "$dest/$so"
  done
  chmod +w "$dest/whisper-cli" "$dest/lib"/*.dylib "$dest"/*.so

  local ggml_lib="$brew_prefix/opt/ggml/lib"
  local libomp_lib="$brew_prefix/opt/libomp/lib"

  # (a) 絶対パス依存 → @rpath化
  install_name_tool -change "$ggml_lib/libggml.0.dylib" "@rpath/libggml.0.dylib" "$dest/whisper-cli"
  install_name_tool -change "$ggml_lib/libggml-base.0.dylib" "@rpath/libggml-base.0.dylib" "$dest/whisper-cli"
  install_name_tool -rpath "@loader_path/../lib" "@loader_path/lib" "$dest/whisper-cli"

  install_name_tool -id "@rpath/libwhisper.1.dylib" "$dest/lib/libwhisper.1.dylib"
  install_name_tool -change "$ggml_lib/libggml.0.dylib" "@rpath/libggml.0.dylib" "$dest/lib/libwhisper.1.dylib"
  install_name_tool -change "$ggml_lib/libggml-base.0.dylib" "@rpath/libggml-base.0.dylib" "$dest/lib/libwhisper.1.dylib"

  install_name_tool -id "@rpath/libggml.0.dylib" "$dest/lib/libggml.0.dylib"

  install_name_tool -id "@rpath/libggml-base.0.dylib" "$dest/lib/libggml-base.0.dylib"
  install_name_tool -change "$libomp_lib/libomp.dylib" "@rpath/libomp.dylib" "$dest/lib/libggml-base.0.dylib"

  install_name_tool -id "@rpath/libomp.dylib" "$dest/lib/libomp.dylib"

  # ggmlのCPUバックエンドプラグイン（cpu-apple_m1/m2_m3/m4）は libggml-base.0.dylib とは別に
  # 自分自身でも libomp への依存を持つ（otool -L で確認済み）。これを見落とすと、配布先に
  # Homebrewが無い環境でCPUバックエンドのdlopenが失敗し、whisper_initが
  # `GGML_ASSERT(device) failed` でSIGABRT（exit 134）= STT完全停止になる（2026-07-10 実機確認・
  # sandbox-execで/opt/homebrewへのfile-readを遮断して再現）。blas.so/metal.soはlibomp依存を
  # 持たないが、依存が無いファイルに対する-changeは無害（何も変更せず終了コード0）なので
  # 5本まとめて適用する。
  for so in "${backend_sos[@]}"; do
    install_name_tool -change "$libomp_lib/libomp.dylib" "@rpath/libomp.dylib" "$dest/$so"
  done

  # install_name_toolは署名を壊すので、ad-hoc署名をやり直す（Apple Siliconは署名必須）。
  # 書き換えたbackend .so 5本も対象（漏れると署名不正でdlopen自体が失敗する）。
  codesign --force -s - "$dest/lib/libomp.dylib" "$dest/lib/libggml-base.0.dylib" "$dest/lib/libggml.0.dylib" \
    "$dest/lib/libwhisper.1.dylib" "$dest/whisper-cli" "$dest"/*.so

  # 検証1: Mach-Oロードコマンドに絶対パス依存が残っていないか（otool -L）。
  # backend .so（*.so）も対象に含める — これが今回の欠陥クラス（libomp直リンク漏れ）の
  # 決定的な検出手段。
  if otool -L "$dest/whisper-cli" "$dest/lib"/*.dylib "$dest"/*.so | grep -q "$brew_prefix"; then
    echo "ERROR: install_name_tool後もHomebrewへの絶対パス依存が残っています:" >&2
    otool -L "$dest/whisper-cli" "$dest/lib"/*.dylib "$dest"/*.so | grep "$brew_prefix" >&2
    exit 1
  fi

  # 検証2: 実際に動くか（この階層構成のまま実行できることの smoke test）。
  # 注意: この smoke test はbackendプラグインの可搬性を検証できない。ggmlの
  # ggml_backend_load_best() はビルド機に焼き込まれた GGML_BACKEND_DIR
  # （brewビルドでは/opt/homebrew/Cellar/...）を実行ファイル自身のディレクトリより先に
  # 検索するため、ビルド機上ではこのディレクトリの.soが常に優先ロードされ、同梱した.soが
  # 使われているかはここでは分からない（Homebrewが存在しない配布先でのみ本当の可搬性が
  # 問われる）。可搬性そのものはCIやリリース前にsandbox-exec等で/opt/homebrewへの
  # file-readを遮断した実変換テストで確認すること（README参照）。
  if ! (cd "$dest" && ./whisper-cli --help >/dev/null 2>&1); then
    echo "ERROR: 収集したwhisper-cliが実行できません（$dest で ./whisper-cli --help が失敗）" >&2
    exit 1
  fi

  log "whisper-bin: $(du -sh "$dest" | cut -f1) （whisper-cli本体+4dylib+backendプラグイン5本）"
}

build_server_binary
copy_client_dist
copy_content
assemble_whisper_bin

log "完了"
du -sh "$BIN_DIR" "$RES_DIR"/* 2>/dev/null | sed 's/^/  /'
echo ""
echo "次に: cd desktop/src-tauri && cargo tauri build --bundles app"
