#!/usr/bin/env bash
# updater公開鍵の継続性と、鍵ローテーション時の橋渡し署名を検証する。
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
使い方: check-updater-key-policy.sh --repo <repository> --private-key <path> [--allow-pubkey-rotation]
USAGE
}

die() {
  echo "ERROR: $*" >&2
  exit 1
}

REPO_DIR=""
PRIVATE_KEY=""
ALLOW_PUBKEY_ROTATION=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      REPO_DIR="$2"
      shift 2
      ;;
    --private-key)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      PRIVATE_KEY="$2"
      shift 2
      ;;
    --allow-pubkey-rotation)
      ALLOW_PUBKEY_ROTATION=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

[[ -n "$REPO_DIR" && -d "$REPO_DIR" ]] || die "--repo にリポジトリを指定してください"
[[ -n "$PRIVATE_KEY" && -f "$PRIVATE_KEY" ]] || die "--private-key の秘密鍵がありません"

normalize_key() {
  printf %s "$1" | tr -d '[:space:]'
}

same_key() {
  [[ "$(normalize_key "$1")" == "$(normalize_key "$2")" ]]
}

extract_pubkey() {
  python3 -c '
import json
import sys
try:
    print(json.load(sys.stdin)["plugins"]["updater"]["pubkey"])
except (json.JSONDecodeError, KeyError, TypeError):
    sys.exit(1)
'
}

CONF_PATH="$REPO_DIR/desktop/src-tauri/tauri.conf.json"
[[ -f "$CONF_PATH" ]] || die "tauri.conf.json がありません"
CONF_PUBKEY="$(extract_pubkey < "$CONF_PATH")" || die "tauri.conf.json にupdater公開鍵がありません"
SIGNING_PUB_PATH="${PRIVATE_KEY}.pub"
[[ -f "$SIGNING_PUB_PATH" ]] || die "署名秘密鍵に対応する公開鍵ファイルがありません"
SIGNING_PUBKEY="$(<"$SIGNING_PUB_PATH")"

# 最新のリリースタグを確認する。updater導入前のリリースには公開鍵がないため、
# その初回だけは現在の設定鍵と署名鍵の一致だけを必須にする。
PREVIOUS_TAGS="$(git -C "$REPO_DIR" tag --merged origin/main --sort=-version:refname --list 'v[0-9]*')" \
  || die "過去のリリースタグを取得できません"
PREVIOUS_TAG="${PREVIOUS_TAGS%%$'\n'*}"

if [[ -z "$PREVIOUS_TAG" ]]; then
  same_key "$SIGNING_PUBKEY" "$CONF_PUBKEY" \
    || die "署名鍵とtauri.conf.jsonのupdater公開鍵が一致しません"
  printf '%s\n' "$CONF_PUBKEY"
  exit 0
fi

PREVIOUS_CONFIG="$(git -C "$REPO_DIR" show "$PREVIOUS_TAG:desktop/src-tauri/tauri.conf.json")" \
  || die "直前リリース $PREVIOUS_TAG のtauri.conf.jsonを読めません"
if ! PREVIOUS_PUBKEY="$(printf %s "$PREVIOUS_CONFIG" | extract_pubkey)"; then
  echo "INFO: 直前リリース $PREVIOUS_TAG にはupdater公開鍵がありません。初回鍵として扱います。" >&2
  same_key "$SIGNING_PUBKEY" "$CONF_PUBKEY" \
    || die "署名鍵とtauri.conf.jsonのupdater公開鍵が一致しません"
  printf '%s\n' "$CONF_PUBKEY"
  exit 0
fi

if same_key "$CONF_PUBKEY" "$PREVIOUS_PUBKEY"; then
  same_key "$SIGNING_PUBKEY" "$CONF_PUBKEY" \
    || die "署名鍵とtauri.conf.jsonのupdater公開鍵が一致しません"
  printf '%s\n' "$CONF_PUBKEY"
  exit 0
fi

[[ "$ALLOW_PUBKEY_ROTATION" == true ]] || die "直前リリースのupdater公開鍵と異なります。安全な橋渡しリリースなら --allow-pubkey-rotation を明示してください"
same_key "$SIGNING_PUBKEY" "$PREVIOUS_PUBKEY" \
  || die "鍵ローテーションの橋渡しリリースは、直前リリースの署名鍵で署名する必要があります"

echo "INFO: updater公開鍵をローテーションする橋渡しリリースです。生成物は直前リリースの公開鍵で検証します。" >&2
printf '%s\n' "$PREVIOUS_PUBKEY"
