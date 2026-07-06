#!/usr/bin/env bash
# say で英語音声を生成し、STT パイプラインを実機で通すスモークテスト
set -euo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say -v Samantha -o "$TMP/hello.aiff" "Hello, this is a smoke test for the speech pipeline."

cd app && bun -e "
import { transcribeAudio } from './server/stt';
const { text } = await transcribeAudio('$TMP/hello.aiff');
console.log('TRANSCRIPT:', text);
if (!/smoke test/i.test(text)) { console.error('FAIL: 期待した語が含まれない'); process.exit(1); }
console.log('SMOKE OK');
"
