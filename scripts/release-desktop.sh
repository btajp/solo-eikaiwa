#!/usr/bin/env bash
# solo-eikaiwa デスクトップアプリのリリース（署名・公証・updaterアーティファクト・GitHub Release）。
# 使い方: ./scripts/release-desktop.sh 0.29.1 [--allow-pubkey-rotation]
# 前提: ~/.config/solo-eikaiwa/release.env（無ければテンプレートを生成して終了する）
#
# やること（順に・失敗したら即中断）:
#   1. バージョン・toolchain・frozen lockfile整合チェック
#   2. 共通release検証（Bun/Rust/content/shellcheck/依存監査）
#   3. build-sidecar.sh（サーバcompile・固定native source・SBOM/NOTICE生成）
#   4. whisper-bin の Mach-O プレ署名 + native manifest/SBOMの最終hash更新
#      - tauri-bundler は Resources 配下を署名対象にしない（bundler 2.9.4 app.rs 実測）ため、
#        ここで署名しないと公証が unsigned binary で必ず落ちる。whisper-cli は JIT 不要なので
#        エンタイトルメント無しの hardened runtime 署名でよい
#   5. cargo tauri build（Developer ID 署名・公証は bundler が env から自動実行。
#      updater アーティファクト(.app.tar.gz/.sig)は overlay で有効化）
#   6. 生成物の存在・署名・公証を検証（公証は env 不備だと警告のみでスキップされるため必ず検証）
#   7. dmg 自体の公証 + staple（Tauri が staple するのは .app のみ）
#   8. latest.json 生成（signature には .sig ファイルの中身を埋め込む）
#   9. SBOM・NOTICE・依存監査・checksum・provenance を生成
#  10. GitHub Release（draft で全アセットを揃えてから publish = 原子的公開）
set -euo pipefail

usage() {
  cat <<USAGE
使い方: $0 <version 例: 0.29.1> [--allow-pubkey-rotation]
USAGE
}

VERSION=""
ALLOW_PUBKEY_ROTATION=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-pubkey-rotation)
      ALLOW_PUBKEY_ROTATION=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "ERROR: 未知のオプションです: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      [[ -z "$VERSION" ]] || {
        echo "ERROR: version は1つだけ指定してください" >&2
        usage >&2
        exit 2
      }
      VERSION="$1"
      shift
      ;;
  esac
done
[[ -n "$VERSION" ]] || { usage >&2; exit 2; }

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
ENV_FILE="${SOLO_EIKAIWA_RELEASE_ENV:-$HOME/.config/solo-eikaiwa/release.env}"
BUNDLE_DIR="$REPO_DIR/desktop/src-tauri/target/release/bundle"

assert_clean_worktree() {
  if ! git -C "$REPO_DIR" diff --quiet -- app/bun.lock app/client/bun.lock \
    || ! git -C "$REPO_DIR" diff --cached --quiet -- app/bun.lock app/client/bun.lock; then
    echo "ERROR: frozen install/build中にlockfileが変更されました" >&2
    exit 1
  fi
  [[ -z "$(git -C "$REPO_DIR" status --porcelain --untracked-files=all)" ]] || {
    echo "ERROR: 作業ツリーに未コミットの変更があります" >&2
    exit 1
  }
}

# 0. release.env（無ければテンプレート生成して人間に返す）
if [[ ! -f "$ENV_FILE" ]]; then
  mkdir -p "$(dirname -- "$ENV_FILE")"
  cat > "$ENV_FILE" <<'TMPL'
# solo-eikaiwa リリース用シークレット（このファイルはリポジトリ外に置く・chmod 600）
# --- Apple 署名（`security find-identity -v -p codesigning` の表示をそのまま） ---
APPLE_SIGNING_IDENTITY="Developer ID Application: YOUR ORG (TEAMID)"
# --- 公証（App Store Connect API キー方式） ---
APPLE_API_KEY="ABC123DEFG"                                    # Key ID（10桁）
APPLE_API_ISSUER="00000000-0000-0000-0000-000000000000"       # Issuer ID（UUID）
APPLE_API_KEY_PATH="$HOME/.appstoreconnect/private_keys/AuthKey_ABC123DEFG.p8"
# --- updater 署名（Tauri minisign 鍵。Apple とは別物） ---
TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/solo-eikaiwa-updater.key"
TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""                          # 鍵にパスワードが無ければ空のまま
TMPL
  chmod 600 "$ENV_FILE"
  echo "release.env のテンプレートを生成しました: $ENV_FILE"
  echo "値を埋めてから再実行してください。"
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"
for v in APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH TAURI_SIGNING_PRIVATE_KEY; do
  [[ -n "${!v:-}" ]] || { echo "ERROR: $ENV_FILE の $v が未設定です" >&2; exit 1; }
done
[[ -f "$APPLE_API_KEY_PATH" ]] || { echo "ERROR: APPLE_API_KEY_PATH が存在しません: $APPLE_API_KEY_PATH" >&2; exit 1; }
[[ -f "$TAURI_SIGNING_PRIVATE_KEY" ]] || { echo "ERROR: TAURI_SIGNING_PRIVATE_KEY が存在しません: $TAURI_SIGNING_PRIVATE_KEY" >&2; exit 1; }
export APPLE_SIGNING_IDENTITY APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH TAURI_SIGNING_PRIVATE_KEY
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
# Apple ID 方式（APPLE_ID/APPLE_PASSWORD/APPLE_TEAM_ID）が API キー方式より先に評価される
# （tauri-cli 実装）ため、環境に混入していたら外して API キー方式に固定する。
unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD 2>/dev/null || true

echo "== solo-eikaiwa desktop release v$VERSION =="

# 1a. Git 前提チェック: push 済みの main からのみリリースできる。
#     gh release create はタグをリモートに新規作成するため、ローカルのビルド元コミットが
#     origin/main の HEAD と一致していないと「タグ・Source アーカイブと配布バイナリの不一致」
#     という壊れたリリースになる（レビュー指摘 2026-07-10）。
BRANCH="$(git -C "$REPO_DIR" branch --show-current)"
[[ "$BRANCH" == "main" ]] || { echo "ERROR: リリースは main ブランチから実行してください（現在: $BRANCH）" >&2; exit 1; }
assert_clean_worktree
git -C "$REPO_DIR" fetch origin main --quiet
git -C "$REPO_DIR" fetch --quiet --tags origin
HEAD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)"
[[ "$HEAD_SHA" == "$(git -C "$REPO_DIR" rev-parse origin/main)" ]] || {
  echo "ERROR: ローカル main が origin/main と一致しません。先に git push してください" >&2; exit 1
}

# 1b. updater鍵の継続性: 通常は設定鍵・署名鍵・直前リリースの鍵を一致させる。
#     鍵ローテーションは旧アプリへ新鍵を届ける橋渡し版だけに限り、明示フラグと
#     直前の署名鍵を要求する。helperの標準出力は今回の生成物を検証する公開鍵。
KEY_POLICY_ARGS=(--repo "$REPO_DIR" --private-key "$TAURI_SIGNING_PRIVATE_KEY")
if [[ "$ALLOW_PUBKEY_ROTATION" == true ]]; then
  KEY_POLICY_ARGS+=(--allow-pubkey-rotation)
fi
UPDATER_SIGNATURE_PUBKEY="$("$REPO_DIR/scripts/check-updater-key-policy.sh" "${KEY_POLICY_ARGS[@]}")"

# 1c. バージョン整合（3ファイル + CHANGELOG + タグ未使用）
json_ver() { python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['version'])" "$1"; }
[[ "$(json_ver "$REPO_DIR/app/package.json")" == "$VERSION" ]] || { echo "ERROR: app/package.json の version が $VERSION ではありません" >&2; exit 1; }
[[ "$(json_ver "$REPO_DIR/desktop/src-tauri/tauri.conf.json")" == "$VERSION" ]] || { echo "ERROR: tauri.conf.json の version が $VERSION ではありません" >&2; exit 1; }
grep -q "^version = \"$VERSION\"" "$REPO_DIR/desktop/src-tauri/Cargo.toml" || { echo "ERROR: desktop/src-tauri/Cargo.toml の version が $VERSION ではありません" >&2; exit 1; }
grep -q "^## \[$VERSION\]" "$REPO_DIR/CHANGELOG.md" || { echo "ERROR: CHANGELOG.md に [$VERSION] 節がありません" >&2; exit 1; }
if git -C "$REPO_DIR" rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "ERROR: タグ v$VERSION は既に存在します" >&2; exit 1
fi

# 2. PRと同じ正本 + release固有のRust/依存監査
"$REPO_DIR/scripts/verify.sh" release
assert_clean_worktree

# 3. sidecar・resources 構築（fixed native input + SBOM/NOTICEを含む）
"$REPO_DIR/desktop/build-sidecar.sh"
assert_clean_worktree

# 4. whisper-bin の Mach-O をプレ署名（理由はヘッダコメント参照）
echo "-- whisper-bin プレ署名"
find "$REPO_DIR/desktop/src-tauri/resources/whisper-bin" -type f | while read -r f; do
  if file "$f" | grep -q "Mach-O"; then
    codesign --force --options runtime --timestamp --sign "$APPLE_SIGNING_IDENTITY" "$f"
  fi
done

# Developer ID署名はMach-Oのcode signatureを更新するため、配布前の実hashをmanifestとSBOMへ反映する。
"$REPO_DIR/scripts/refresh-native-manifest.sh" \
  --output "$REPO_DIR/desktop/src-tauri/resources/whisper-bin"
bun "$REPO_DIR/scripts/desktop-provenance.ts" \
  --repo "$REPO_DIR" \
  --resources "$REPO_DIR/desktop/src-tauri/resources" \
  --output "$REPO_DIR/desktop/src-tauri/resources/provenance"

# 5. ビルド（署名・公証は bundler が env から自動実行）
# CI=trueによりTauriのcreate-dmgへ--skip-jenkinsを渡し、Finder AppleScriptへ依存しない。
# これはアイコン位置の装飾だけを省略し、app、Applicationsリンク、署名、公証には影響しない。
echo "-- cargo tauri build（公証込み・数分かかります）"
(cd "$REPO_DIR/desktop/src-tauri" && CI=true cargo tauri build --config tauri.updater-artifacts.conf.json)
assert_clean_worktree

# 6. 生成物の存在・署名・公証を検証
APP="$BUNDLE_DIR/macos/solo-eikaiwa.app"
DMG="$BUNDLE_DIR/dmg/solo-eikaiwa_${VERSION}_aarch64.dmg"
TARGZ="$BUNDLE_DIR/macos/solo-eikaiwa.app.tar.gz"
SIG="$TARGZ.sig"
for p in "$APP" "$DMG" "$TARGZ" "$SIG"; do
  [[ -e "$p" ]] || { echo "ERROR: 生成物がありません: $p（.sig 欠落なら TAURI_SIGNING_PRIVATE_KEY を確認）" >&2; exit 1; }
done
# updater署名検証用の補助binを追加しても、Tauriが主アプリ（Cargoのdefault-run）を梱包すること。
[[ -x "$APP/Contents/MacOS/app" ]] || {
  echo "ERROR: .app に主アプリ実行ファイルがありません（Cargo.toml の default-run を確認）" >&2
  exit 1
}
echo "-- 署名・公証の検証"
codesign --verify --deep --strict "$APP"
xcrun stapler validate "$APP"
spctl -a -t exec -vv "$APP"
echo "-- updater生成物のminisign署名を検証"
(cd "$REPO_DIR/desktop/src-tauri" && cargo run --locked --quiet --bin verify-updater-signature -- "$TARGZ" "$SIG" "$UPDATER_SIGNATURE_PUBKEY")

# 7. dmg 自体の公証 + staple
echo "-- dmg 公証（数分かかります）"
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"

# 8. latest.json 生成（signature は .sig の中身）
LATEST_JSON="$BUNDLE_DIR/latest.json"
SIG_CONTENT="$(cat "$SIG")" \
ASSET_URL="https://github.com/btajp/solo-eikaiwa/releases/download/v${VERSION}/solo-eikaiwa.app.tar.gz" \
REL_VERSION="$VERSION" PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
python3 - "$LATEST_JSON" <<'PY'
import json, os, sys
json.dump({
    "version": os.environ["REL_VERSION"],
    "pub_date": os.environ["PUB_DATE"],
    "platforms": {
        "darwin-aarch64": {
            "signature": os.environ["SIG_CONTENT"],
            "url": os.environ["ASSET_URL"],
        }
    },
}, open(sys.argv[1], "w"), indent=2)
PY

# 9. 配布 provenance（.app内SBOM/NOTICE、依存監査、artifact checksum）を生成
"$REPO_DIR/scripts/create-release-provenance.sh" \
  --version "$VERSION" \
  --bundle-dir "$BUNDLE_DIR" \
  --app "$APP" \
  --dmg "$DMG" \
  --tarball "$TARGZ" \
  --signature "$SIG" \
  --latest-json "$LATEST_JSON"
PROVENANCE_DIR="$BUNDLE_DIR/provenance"

# 10. GitHub Release（draft で全アセットを揃えてから publish）
assert_clean_worktree
echo "-- GitHub Release 作成"
NOTES_FILE="$(mktemp)"
python3 - "$REPO_DIR/CHANGELOG.md" "$VERSION" > "$NOTES_FILE" <<'PY'
import re, sys
text = open(sys.argv[1]).read()
m = re.search(rf"^## \[{re.escape(sys.argv[2])}\][^\n]*\n(.*?)(?=^## \[|\Z)", text, re.S | re.M)
print(m.group(1).strip() if m else "")
PY
gh release create "v$VERSION" --draft --target "$HEAD_SHA" --title "v$VERSION" --notes-file "$NOTES_FILE" \
  "$DMG" "$TARGZ" "$LATEST_JSON" \
  "$PROVENANCE_DIR/solo-eikaiwa-${VERSION}.spdx.json" \
  "$PROVENANCE_DIR/solo-eikaiwa-${VERSION}.THIRD_PARTY_NOTICES.md" \
  "$PROVENANCE_DIR/solo-eikaiwa-${VERSION}.third-party-licenses.tar.gz" \
  "$PROVENANCE_DIR/solo-eikaiwa-${VERSION}.native-deps.lock.json" \
  "$PROVENANCE_DIR/solo-eikaiwa-${VERSION}.native-dependencies.json" \
  "$PROVENANCE_DIR/solo-eikaiwa-${VERSION}.dependency-audit.txt" \
  "$PROVENANCE_DIR/solo-eikaiwa-${VERSION}.checksums.txt" \
  "$PROVENANCE_DIR/solo-eikaiwa-${VERSION}.provenance.json"
gh release edit "v$VERSION" --draft=false
rm -f "$NOTES_FILE"
git -C "$REPO_DIR" fetch --tags

echo ""
echo "== リリース完了: https://github.com/btajp/solo-eikaiwa/releases/tag/v$VERSION =="
echo "事後スモーク:"
echo "  1. ブラウザで dmg を実ダウンロード → マウント → /Applications へコピー → ダブルクリックで警告なしに起動すること"
echo "  2. 旧バージョンのアプリを起動 → 更新ダイアログ →「更新する」→ 新バージョンで自動再起動すること"
