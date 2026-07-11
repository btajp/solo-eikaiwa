#!/usr/bin/env bash
# 固定した whisper.cpp source から配布用 whisper-cli を組み立てる。
# Homebrew の現行 bottle を収集しないことで、native 入力を lock file に限定する。
set -euo pipefail

usage() {
  cat <<'USAGE'
使い方: scripts/build-native-whisper.sh [--lock <path>] [--output <dir>]

lock file の source archive SHA-256 が一致しない場合は停止します。
USAGE
}

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
LOCK_FILE="$REPO_DIR/desktop/native-deps.lock.json"
OUTPUT_DIR="$REPO_DIR/desktop/src-tauri/resources/whisper-bin"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lock)
      LOCK_FILE="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: 未知の引数です: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

[[ -f "$LOCK_FILE" ]] || { echo "ERROR: native lock file がありません" >&2; exit 1; }

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "ERROR: $1 が必要です。既存の開発環境管理経路で用意してから再実行してください" >&2
    exit 1
  }
}

for command in cmake curl shasum tar otool codesign xcrun python3; do
  require_command "$command"
done

[[ "$(uname -s)" == "Darwin" ]] || {
  echo "ERROR: native whisper build は macOS Apple Silicon 専用です" >&2
  exit 1
}
[[ "$(uname -m)" == "arm64" ]] || {
  echo "ERROR: native whisper build は arm64 host が必要です" >&2
  exit 1
}

LOCK_VALUES=()
while IFS= read -r value; do
  LOCK_VALUES+=("$value")
done < <(python3 - "$LOCK_FILE" <<'PY'
import json
import re
import sys

path = sys.argv[1]
try:
    lock = json.load(open(path, encoding="utf-8"))
    component = lock["components"][0]
    target = lock["target"]
    build = lock["build"]
except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
    raise SystemExit(f"ERROR: native lock file の形式が不正です: {error}")

required = {
    "schemaVersion": lock.get("schemaVersion"),
    "component.name": component.get("name"),
    "component.version": component.get("version"),
    "component.commit": component.get("commit"),
    "component.url": component.get("url"),
    "component.sha256": component.get("sha256"),
    "component.licensePath": component.get("licensePath"),
    "target.os": target.get("os"),
    "target.arch": target.get("arch"),
    "target.triple": target.get("triple"),
    "target.deploymentTarget": target.get("deploymentTarget"),
    "sourceDateEpoch": lock.get("sourceDateEpoch"),
    "build.cmakeMinimumVersion": build.get("cmakeMinimumVersion"),
}
missing = [key for key, value in required.items() if value in (None, "", [])]
if missing:
    raise SystemExit("ERROR: native lock file の必須項目が不足しています: " + ", ".join(missing))
if lock["schemaVersion"] != 1 or component["name"] != "whisper.cpp":
    raise SystemExit("ERROR: 未対応の native lock schema/component です")
if target["os"] != "darwin" or target["arch"] != "arm64" or target["triple"] != "aarch64-apple-darwin":
    raise SystemExit("ERROR: native lock の target は aarch64-apple-darwin である必要があります")
if not re.fullmatch(r"[0-9a-f]{40}", component["commit"]):
    raise SystemExit("ERROR: whisper.cpp commit は40桁のSHA-1である必要があります")
if not re.fullmatch(r"[0-9a-f]{64}", component["sha256"]):
    raise SystemExit("ERROR: source SHA-256 は64桁の16進数である必要があります")
if not component["url"].startswith("https://"):
    raise SystemExit("ERROR: source URL はHTTPSである必要があります")
if component["commit"] not in component["url"]:
    raise SystemExit("ERROR: source URL はlockしたcommitを含む必要があります")
if component["licensePath"].startswith("/") or ".." in component["licensePath"].split("/"):
    raise SystemExit("ERROR: licensePath はsource archive内の相対pathである必要があります")
if not isinstance(lock["sourceDateEpoch"], int) or lock["sourceDateEpoch"] < 0:
    raise SystemExit("ERROR: sourceDateEpoch は0以上の整数である必要があります")
if not isinstance(build.get("cmakeArgs"), list) or not build["cmakeArgs"]:
    raise SystemExit("ERROR: CMake 引数が不足しています")

for value in (
    component["name"], component["version"], component["commit"], component["url"],
    component["sha256"], component["licensePath"], target["triple"], target["deploymentTarget"],
    str(lock["sourceDateEpoch"]), build["cmakeMinimumVersion"],
):
    print(value)
PY
)

COMPONENT_NAME="${LOCK_VALUES[0]}"
COMPONENT_VERSION="${LOCK_VALUES[1]}"
COMPONENT_COMMIT="${LOCK_VALUES[2]}"
SOURCE_URL="${LOCK_VALUES[3]}"
SOURCE_SHA256="${LOCK_VALUES[4]}"
LICENSE_PATH="${LOCK_VALUES[5]}"
TARGET_TRIPLE="${LOCK_VALUES[6]}"
DEPLOYMENT_TARGET="${LOCK_VALUES[7]}"
SOURCE_DATE_EPOCH="${LOCK_VALUES[8]}"
MIN_CMAKE_VERSION="${LOCK_VALUES[9]}"

CMAKE_ARGS=()
while IFS= read -r value; do
  CMAKE_ARGS+=("$value")
done < <(python3 - "$LOCK_FILE" <<'PY'
import json
import sys
for value in json.load(open(sys.argv[1], encoding="utf-8"))["build"]["cmakeArgs"]:
    if not isinstance(value, str) or not value.startswith("-D"):
        raise SystemExit("ERROR: CMake 引数は -D から始まる文字列である必要があります")
    print(value)
PY
)

cmake_version="$(cmake --version | sed -n '1s/.* //p')"
python3 - "$cmake_version" "$MIN_CMAKE_VERSION" <<'PY'
import sys

def version(value):
    return tuple(int(part) for part in value.split(".")[:3])

try:
    actual = version(sys.argv[1])
    minimum = version(sys.argv[2])
except ValueError:
    raise SystemExit("ERROR: CMake version を判定できません")
if actual < minimum:
    raise SystemExit(f"ERROR: CMake {sys.argv[2]} 以上が必要です（検出: {sys.argv[1]}）")
PY

lock_sha256="$(shasum -a 256 "$LOCK_FILE" | awk '{print $1}')"
cache_root="${SOLO_EIKAIWA_NATIVE_CACHE_DIR:-${TMPDIR:-/tmp}/solo-eikaiwa-native-cache}"
archive="$cache_root/${SOURCE_SHA256}.tar.gz"
mkdir -p "$cache_root"

verify_sha256() {
  local file="$1" expected="$2" actual
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  [[ "$actual" == "$expected" ]] || {
    echo "ERROR: native source archive の SHA-256 が lock と一致しません" >&2
    exit 1
  }
}

if [[ -e "$archive" ]]; then
  verify_sha256 "$archive" "$SOURCE_SHA256"
else
  download_tmp="$(mktemp "$cache_root/download.XXXXXX")"
  trap 'rm -f "$download_tmp"' EXIT
  curl --fail --location --retry 3 --proto '=https' --tlsv1.2 --silent --show-error "$SOURCE_URL" --output "$download_tmp"
  verify_sha256 "$download_tmp" "$SOURCE_SHA256"
  mv "$download_tmp" "$archive"
  trap - EXIT
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/solo-native-whisper.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
tar -xzf "$archive" -C "$work_dir"
source_dirs=()
while IFS= read -r value; do
  source_dirs+=("$value")
done < <(find "$work_dir" -mindepth 1 -maxdepth 1 -type d -print | sort)
[[ "${#source_dirs[@]}" -eq 1 ]] || {
  echo "ERROR: native source archive の展開結果が不正です" >&2
  exit 1
}
source_dir="${source_dirs[0]}"
[[ -f "$source_dir/CMakeLists.txt" && -f "$source_dir/$LICENSE_PATH" ]] || {
  echo "ERROR: native source archive に必要なファイルがありません" >&2
  exit 1
}

build_dir="$work_dir/build"
export SOURCE_DATE_EPOCH
# source archiveにはGit metadataを含めない。lockしたCMake引数で上流のGit probeを無効化し、
# hostのcheckout状態ではなくlockのcommit/hashを唯一のsource identityとして扱う。
cmake -S "$source_dir" -B "$build_dir" \
  "${CMAKE_ARGS[@]}" \
  "-DCMAKE_OSX_ARCHITECTURES=arm64" \
  "-DCMAKE_OSX_DEPLOYMENT_TARGET=$DEPLOYMENT_TARGET"
cmake --build "$build_dir" --config Release --target whisper-cli --parallel "${SOLO_EIKAIWA_NATIVE_BUILD_JOBS:-4}"

binary="$build_dir/bin/whisper-cli"
[[ -x "$binary" ]] || { echo "ERROR: whisper-cli が生成されませんでした" >&2; exit 1; }
"$binary" --help >/dev/null 2>&1 || {
  echo "ERROR: 生成した whisper-cli の smoke test に失敗しました" >&2
  exit 1
}

if otool -L "$binary" | sed '1d' | awk '{print $1}' | grep -Ev '^(/System/Library/|/usr/lib/)' >/dev/null; then
  echo "ERROR: whisper-cli に非システムの動的依存が残っています" >&2
  otool -L "$binary" >&2
  exit 1
fi

stage_dir="$work_dir/whisper-bin"
mkdir -p "$stage_dir/licenses"
cp "$binary" "$stage_dir/whisper-cli"
cp "$source_dir/$LICENSE_PATH" "$stage_dir/licenses/whisper.cpp-MIT.txt"
codesign --force -s - "$stage_dir/whisper-cli" >/dev/null

binary_sha256="$(shasum -a 256 "$stage_dir/whisper-cli" | awk '{print $1}')"
binary_bytes="$(stat -f '%z' "$stage_dir/whisper-cli")"
compiler="$(xcrun --find clang)"
compiler_version="$(clang --version | head -n 1)"
sdk_version="$(xcrun --sdk macosx --show-sdk-version)"

LOCK_FILE="$LOCK_FILE" \
LOCK_SHA256="$lock_sha256" \
COMPONENT_NAME="$COMPONENT_NAME" \
COMPONENT_VERSION="$COMPONENT_VERSION" \
COMPONENT_COMMIT="$COMPONENT_COMMIT" \
SOURCE_URL="$SOURCE_URL" \
SOURCE_SHA256="$SOURCE_SHA256" \
SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" \
DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET" \
TARGET_TRIPLE="$TARGET_TRIPLE" \
MIN_CMAKE_VERSION="$MIN_CMAKE_VERSION" \
CMAKE_VERSION="$cmake_version" \
COMPILER="$compiler" \
COMPILER_VERSION="$compiler_version" \
SDK_VERSION="$sdk_version" \
BINARY_SHA256="$binary_sha256" \
BINARY_BYTES="$binary_bytes" \
STAGE_DIR="$stage_dir" \
python3 - <<'PY'
import json
import os
from pathlib import Path

lock = json.load(open(os.environ["LOCK_FILE"], encoding="utf-8"))
manifest = {
    "schemaVersion": 1,
    "lockSha256": os.environ["LOCK_SHA256"],
    "source": {
        "name": os.environ["COMPONENT_NAME"],
        "version": os.environ["COMPONENT_VERSION"],
        "commit": os.environ["COMPONENT_COMMIT"],
        "url": os.environ["SOURCE_URL"],
        "sha256": os.environ["SOURCE_SHA256"],
        "license": lock["components"][0]["license"],
    },
    "build": {
        "sourceDateEpoch": int(os.environ["SOURCE_DATE_EPOCH"]),
        "targetTriple": os.environ["TARGET_TRIPLE"],
        "deploymentTarget": os.environ["DEPLOYMENT_TARGET"],
        "cmakeMinimumVersion": os.environ["MIN_CMAKE_VERSION"],
        "cmakeVersion": os.environ["CMAKE_VERSION"],
        "cmakeArgs": lock["build"]["cmakeArgs"],
        "compiler": os.environ["COMPILER"],
        "compilerVersion": os.environ["COMPILER_VERSION"],
        "sdkVersion": os.environ["SDK_VERSION"],
    },
    "artifacts": [{
        "path": "whisper-cli",
        "sha256": os.environ["BINARY_SHA256"],
        "bytes": int(os.environ["BINARY_BYTES"]),
    }],
}
Path(os.environ["STAGE_DIR"], "native-dependencies.json").write_text(
    json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
cp -R "$stage_dir/." "$OUTPUT_DIR/"

echo "OK: fixed native dependency built: $COMPONENT_NAME v$COMPONENT_VERSION ($binary_sha256)"
