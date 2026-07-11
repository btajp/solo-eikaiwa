#!/usr/bin/env bash
# 署名済みデスクトップ配布物から、公開用の SBOM・NOTICE・監査・checksum 証跡を作る。
set -euo pipefail

usage() {
  cat <<'USAGE'
使い方:
  scripts/create-release-provenance.sh \
    --version <semver> --bundle-dir <dir> --app <app> --dmg <dmg> \
    --tarball <tar.gz> --signature <sig> --latest-json <latest.json>
USAGE
}

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." >/dev/null 2>&1 && pwd -P)"
VERSION=""
BUNDLE_DIR=""
APP=""
DMG=""
TARBALL=""
SIGNATURE=""
LATEST_JSON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --bundle-dir) BUNDLE_DIR="${2:-}"; shift 2 ;;
    --app) APP="${2:-}"; shift 2 ;;
    --dmg) DMG="${2:-}"; shift 2 ;;
    --tarball) TARBALL="${2:-}"; shift 2 ;;
    --signature) SIGNATURE="${2:-}"; shift 2 ;;
    --latest-json) LATEST_JSON="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "ERROR: 未知の引数です: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "ERROR: version は semver で指定してください" >&2
  exit 2
}
for path in "$BUNDLE_DIR" "$APP" "$DMG" "$TARBALL" "$SIGNATURE" "$LATEST_JSON"; do
  [[ -n "$path" && -e "$path" ]] || { echo "ERROR: 必須の生成物がありません" >&2; exit 1; }
done

APP_PROVENANCE_DIR="$APP/Contents/Resources/provenance"
APP_NATIVE_MANIFEST="$APP/Contents/Resources/whisper-bin/native-dependencies.json"
APP_NATIVE_BINARY="$APP/Contents/Resources/whisper-bin/whisper-cli"
APP_NATIVE_LICENSE="$APP/Contents/Resources/whisper-bin/licenses/whisper.cpp-MIT.txt"
for path in "$APP_PROVENANCE_DIR/sbom.spdx.json" "$APP_PROVENANCE_DIR/THIRD_PARTY_NOTICES.md" "$APP_PROVENANCE_DIR/licenses" "$APP_NATIVE_MANIFEST" "$APP_NATIVE_BINARY" "$APP_NATIVE_LICENSE"; do
  [[ -e "$path" ]] || { echo "ERROR: .app 内の provenance が不足しています" >&2; exit 1; }
done

manifest_binary_sha="$(python3 - "$APP_NATIVE_MANIFEST" <<'PY'
import json
import re
import sys

try:
    manifest = json.load(open(sys.argv[1], encoding="utf-8"))
    matches = [item["sha256"] for item in manifest["artifacts"] if item.get("path") == "whisper-cli"]
except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
    raise SystemExit(f"ERROR: native manifest の形式が不正です: {error}")
if len(matches) != 1 or not re.fullmatch(r"[0-9a-f]{64}", matches[0]):
    raise SystemExit("ERROR: native manifest に whisper-cli SHA-256 がありません")
print(matches[0])
PY
)"
actual_binary_sha="$(shasum -a 256 "$APP_NATIVE_BINARY" | awk '{print $1}')"
[[ "$actual_binary_sha" == "$manifest_binary_sha" ]] || {
  echo "ERROR: .app 内の whisper-cli と native manifest の SHA-256 が一致しません" >&2
  exit 1
}

python3 - "$APP_PROVENANCE_DIR/sbom.spdx.json" <<'PY'
import json
import sys

try:
    packages = json.load(open(sys.argv[1], encoding="utf-8"))["packages"]
except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
    raise SystemExit(f"ERROR: .app 内の SBOM の形式が不正です: {error}")
names = {package.get("name") for package in packages}
required = {"bun", "rust", "whisper.cpp", "solo-eikaiwa-content"}
missing = sorted(required - names)
if missing:
    raise SystemExit("ERROR: .app 内の SBOM に必須componentがありません: " + ", ".join(missing))
PY

OUTPUT_DIR="$BUNDLE_DIR/provenance"
PREFIX="solo-eikaiwa-${VERSION}"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

SBOM="$OUTPUT_DIR/$PREFIX.spdx.json"
NOTICE="$OUTPUT_DIR/$PREFIX.THIRD_PARTY_NOTICES.md"
LICENSE_ARCHIVE="$OUTPUT_DIR/$PREFIX.third-party-licenses.tar.gz"
NATIVE_LOCK="$OUTPUT_DIR/$PREFIX.native-deps.lock.json"
NATIVE_MANIFEST="$OUTPUT_DIR/$PREFIX.native-dependencies.json"
AUDIT="$OUTPUT_DIR/$PREFIX.dependency-audit.txt"
CHECKSUMS="$OUTPUT_DIR/$PREFIX.checksums.txt"
PROVENANCE="$OUTPUT_DIR/$PREFIX.provenance.json"

cp "$APP_PROVENANCE_DIR/sbom.spdx.json" "$SBOM"
cp "$APP_PROVENANCE_DIR/THIRD_PARTY_NOTICES.md" "$NOTICE"
tar -czf "$LICENSE_ARCHIVE" -C "$APP_PROVENANCE_DIR" licenses
cp "$REPO_DIR/desktop/native-deps.lock.json" "$NATIVE_LOCK"
cp "$APP_NATIVE_MANIFEST" "$NATIVE_MANIFEST"

lock_sha256="$(shasum -a 256 "$NATIVE_LOCK" | awk '{print $1}')"
manifest_lock_sha="$(python3 - "$NATIVE_MANIFEST" <<'PY'
import json
import re
import sys

try:
    value = json.load(open(sys.argv[1], encoding="utf-8"))["lockSha256"]
except (OSError, ValueError, KeyError, TypeError, AttributeError) as error:
    raise SystemExit(f"ERROR: native manifest の lock SHA-256 が不正です: {error}")
if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
    raise SystemExit("ERROR: native manifest の lock SHA-256 が不正です")
print(value)
PY
)"
[[ "$lock_sha256" == "$manifest_lock_sha" ]] || {
  echo "ERROR: release native lock と .app 内 native manifest が一致しません" >&2
  exit 1
}

"$REPO_DIR/scripts/audit-dependencies.sh" >"$AUDIT" 2>&1

VERSION="$VERSION" \
APP="$APP" \
DMG="$DMG" \
TARBALL="$TARBALL" \
SIGNATURE="$SIGNATURE" \
LATEST_JSON="$LATEST_JSON" \
SBOM="$SBOM" \
NOTICE="$NOTICE" \
LICENSE_ARCHIVE="$LICENSE_ARCHIVE" \
NATIVE_LOCK="$NATIVE_LOCK" \
NATIVE_MANIFEST="$NATIVE_MANIFEST" \
AUDIT="$AUDIT" \
CHECKSUMS="$CHECKSUMS" \
PROVENANCE="$PROVENANCE" \
HEAD_SHA="$(git -C "$REPO_DIR" rev-parse HEAD)" \
TOOLCHAIN_SHA256="$(shasum -a 256 "$REPO_DIR/toolchain.json" | awk '{print $1}')" \
python3 - <<'PY'
import hashlib
import json
import os
from pathlib import Path

def digest_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()

def digest_tree(path):
    root = Path(path)
    digest = hashlib.sha256()
    total = 0
    for child in sorted(item for item in root.rglob("*") if item.is_file()):
        content = child.read_bytes()
        total += len(content)
        digest.update(child.relative_to(root).as_posix().encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(content).hexdigest().encode())
        digest.update(b"\0")
        digest.update(str(len(content)).encode())
        digest.update(b"\n")
    return {"sha256": digest.hexdigest(), "bytes": total}

assets = [
    ("solo-eikaiwa.app", os.environ["APP"], True),
    ("solo-eikaiwa.dmg", os.environ["DMG"], False),
    ("solo-eikaiwa.app.tar.gz", os.environ["TARBALL"], False),
    ("solo-eikaiwa.app.tar.gz.sig", os.environ["SIGNATURE"], False),
    ("latest.json", os.environ["LATEST_JSON"], False),
    (Path(os.environ["SBOM"]).name, os.environ["SBOM"], False),
    (Path(os.environ["NOTICE"]).name, os.environ["NOTICE"], False),
    (Path(os.environ["LICENSE_ARCHIVE"]).name, os.environ["LICENSE_ARCHIVE"], False),
    (Path(os.environ["NATIVE_LOCK"]).name, os.environ["NATIVE_LOCK"], False),
    (Path(os.environ["NATIVE_MANIFEST"]).name, os.environ["NATIVE_MANIFEST"], False),
    (Path(os.environ["AUDIT"]).name, os.environ["AUDIT"], False),
]
records = []
for name, path, is_tree in assets:
    record = digest_tree(path) if is_tree else {"sha256": digest_file(path), "bytes": Path(path).stat().st_size}
    records.append({"name": name, **record})

Path(os.environ["CHECKSUMS"]).write_text(
    "".join(f"{record['sha256']}  {record['name']}\n" for record in records),
    encoding="utf-8",
)
provenance = {
    "schemaVersion": 1,
    "version": os.environ["VERSION"],
    "commit": os.environ["HEAD_SHA"],
    "toolchainSha256": os.environ["TOOLCHAIN_SHA256"],
    "checksumsSha256": digest_file(os.environ["CHECKSUMS"]),
    "assets": records,
}
Path(os.environ["PROVENANCE"]).write_text(
    json.dumps(provenance, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
PY

for path in "$SBOM" "$NOTICE" "$LICENSE_ARCHIVE" "$NATIVE_LOCK" "$NATIVE_MANIFEST" "$AUDIT" "$CHECKSUMS" "$PROVENANCE"; do
  [[ -s "$path" ]] || { echo "ERROR: release provenance の生成に失敗しました" >&2; exit 1; }
done

echo "OK: release provenance generated"
