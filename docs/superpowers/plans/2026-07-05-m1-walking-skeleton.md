# M1 ウォーキングスケルトン Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ブラウザ1画面で「録音 → whisper.cpp 文字起こし → Claude 応答 → TTS 音声再生」の英会話ループを回し、全ターンをセッションログ（JSONL）に保存できる状態にする。

**Architecture:** Bun + TypeScript のローカルサーバ（port 3111）が `/api/stt` `/api/tts` `/api/converse` を提供。STT は ffmpeg で 16kHz WAV に変換して whisper.cpp CLI をローカル実行。TTS は OpenAI TTS API（キャッシュ付き、無キー時は macOS `say` フォールバック）。対話は Claude Agent SDK（Max サブスク経由・APIキー不要）でセッション継続。クライアントは Vite + React の1画面で、録音トグル → 文字起こし表示 → AI応答表示 → 音声自動再生。

**Tech Stack:** Bun ≥1.3 / TypeScript / React + Vite / whisper.cpp (brew, ggml-large-v3-turbo) / ffmpeg / OpenAI TTS API (`gpt-4o-mini-tts`) / `@anthropic-ai/claude-agent-sdk`

## Global Constraints

- 設計スペック: `docs/superpowers/specs/2026-07-05-learn-english-system-design.md`（§4 システム構成、§6.2 M1）
- サーバは localhost:3111 固定・シングルユーザー。外部公開しない
- 対話AIは Claude Agent SDK（Max サブスク経由）。Anthropic API キーは使わない
- TTS は `OPENAI_API_KEY`（`app/.env`）があれば OpenAI、なければ `say` フォールバックで**セッションを止めない**（spec §4.5）
- データはすべてリポジトリ内プレーンファイル。`data/recordings/`・`data/tts-cache/`・`models/` は gitignore（spec §4.1, §6.1）
- セッションログは `data/sessions/YYYY-MM-DD.jsonl` に JSONL 追記（クラッシュ耐性、spec §4.5）
- whisper は英語専用モード（`-l en`）、モデルは `ggml-large-v3-turbo`
- コミットは Conventional Commits（日本語本文可）
- テストは `bun test`（server 側）。外部プロセス・外部APIに依存する処理は関数注入でモック可能に設計する

## File Structure（このプランで作るもの）

```
app/
  package.json               # server 用（bun）
  tsconfig.json
  .env.example               # OPENAI_API_KEY=
  server/
    paths.ts                 # リポジトリ内データパスの解決・mkdir
    session-log.ts           # JSONL 追記・読み出し
    stt.ts                   # webm→wav 変換・whisper 実行・JSON パース
    tts.ts                   # OpenAI TTS + キャッシュ + say フォールバック
    converse.ts              # Claude Agent SDK ターン実行・履歴ログ
    health.ts                # 依存バイナリ・キーの存在チェック
    index.ts                 # Bun.serve ルーティング
    __tests__/
      session-log.test.ts
      stt.test.ts
      tts.test.ts
      converse.test.ts
      health.test.ts
  client/                    # Vite + React（M1 は手動スモークのみ）
    package.json
    vite.config.ts
    index.html
    src/main.tsx
    src/App.tsx
    src/api.ts
    src/audio.ts
scripts/
  setup.sh                   # brew 依存・モデルDL・キー/CLI 検査
  smoke-stt.sh               # say で音声を作って STT を通す実機スモーク
data/.gitignore              # recordings/ tts-cache/ を無視
.gitignore                   # models/ ほか
```

---

### Task 1: サーバ雛形・パス解決・セッションログ

**Files:**
- Create: `.gitignore`, `data/.gitignore`, `app/package.json`, `app/tsconfig.json`, `app/.env.example`
- Create: `app/server/paths.ts`, `app/server/session-log.ts`
- Test: `app/server/__tests__/session-log.test.ts`

**Interfaces:**
- Consumes: なし（最初のタスク）
- Produces:
  - `paths.ts`: `REPO_ROOT: string` / `DATA_DIR: string` / `SESSIONS_DIR: string` / `RECORDINGS_DIR: string` / `TTS_CACHE_DIR: string` / `MODELS_DIR: string` / `ensureDirs(): void` / `sessionLogPath(date: Date): string`
  - `session-log.ts`: `type SessionEvent = { ts: string; type: "session_start" | "session_end" | "user_utterance" | "assistant_reply" | "error"; sessionId: string; text?: string; meta?: Record<string, unknown> }` / `appendEvent(file: string, e: SessionEvent): void` / `readEvents(file: string): SessionEvent[]`

- [ ] **Step 1: 雛形ファイルを作成**

`.gitignore`（リポジトリルート）:

```gitignore
node_modules/
models/
app/.env
dist/
*.log
.superpowers/
```

`data/.gitignore`:

```gitignore
recordings/
tts-cache/
```

`app/package.json`:

```json
{
  "name": "learn-english-app",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun --watch server/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  }
}
```

`app/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["server"]
}
```

`app/.env.example`:

```
OPENAI_API_KEY=
```

Run: `cd app && bun install`
Expected: 依存が入り `bun.lock` が生成される

- [ ] **Step 2: session-log の失敗するテストを書く**

`app/server/__tests__/session-log.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendEvent, readEvents, type SessionEvent } from "../session-log";

describe("session-log", () => {
  test("appendEvent は1行1JSONで追記し readEvents で復元できる", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sess-"));
    const file = path.join(dir, "2026-07-05.jsonl");
    const e1: SessionEvent = { ts: "2026-07-05T09:00:00.000Z", type: "session_start", sessionId: "s1" };
    const e2: SessionEvent = { ts: "2026-07-05T09:00:05.000Z", type: "user_utterance", sessionId: "s1", text: "hello" };
    appendEvent(file, e1);
    appendEvent(file, e2);
    const events = readEvents(file);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("session_start");
    expect(events[1].text).toBe("hello");
  });

  test("readEvents は存在しないファイルで空配列を返す", () => {
    expect(readEvents("/nonexistent/nope.jsonl")).toEqual([]);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/session-log.test.ts`
Expected: FAIL（`session-log` モジュールが存在しない）

- [ ] **Step 4: paths.ts と session-log.ts を実装**

`app/server/paths.ts`:

```ts
import path from "node:path";
import { mkdirSync } from "node:fs";

export const REPO_ROOT = path.resolve(import.meta.dir, "../..");
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
export const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");
export const TTS_CACHE_DIR = path.join(DATA_DIR, "tts-cache");
export const MODELS_DIR = path.join(REPO_ROOT, "models");

export function ensureDirs(): void {
  for (const d of [SESSIONS_DIR, RECORDINGS_DIR, TTS_CACHE_DIR, MODELS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

export function sessionLogPath(date: Date): string {
  const ymd = date.toISOString().slice(0, 10);
  return path.join(SESSIONS_DIR, `${ymd}.jsonl`);
}
```

`app/server/session-log.ts`:

```ts
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type SessionEvent = {
  ts: string;
  type: "session_start" | "session_end" | "user_utterance" | "assistant_reply" | "error";
  sessionId: string;
  text?: string;
  meta?: Record<string, unknown>;
};

export function appendEvent(file: string, e: SessionEvent): void {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(e) + "\n", "utf8");
}

export function readEvents(file: string): SessionEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd app && bun test server/__tests__/session-log.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 6: コミット**

```bash
git add .gitignore data/.gitignore app/
git commit -m "feat: Bunサーバ雛形とセッションログ(JSONL)を追加"
```

---

### Task 2: セットアップスクリプトと STT（whisper.cpp）

**Files:**
- Create: `scripts/setup.sh`, `scripts/smoke-stt.sh`
- Create: `app/server/stt.ts`
- Test: `app/server/__tests__/stt.test.ts`

**Interfaces:**
- Consumes: `paths.ts` の `MODELS_DIR`, `RECORDINGS_DIR`
- Produces:
  - `stt.ts`: `WHISPER_MODEL_PATH: string`（`models/ggml-large-v3-turbo.bin`） / `buildWhisperArgs(modelPath: string, wavPath: string, outBase: string): string[]` / `parseWhisperJson(jsonText: string): string` / `transcribeAudio(inputPath: string, opts?: { spawnFn?: SpawnFn }): Promise<string>`（webm/wav → テキスト） / `type SpawnFn = (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>`

- [ ] **Step 1: setup.sh を作成**

`scripts/setup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== learn-english setup =="

command -v brew >/dev/null || { echo "ERROR: Homebrew が必要です"; exit 1; }

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
  curl -L -o "$MODEL" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
fi
echo "model: $MODEL ($(du -h "$MODEL" | cut -f1))"

command -v claude >/dev/null || { echo "ERROR: claude CLI が必要です"; exit 1; }
echo "claude: $(command -v claude)"

if [ ! -f app/.env ]; then
  cp app/.env.example app/.env
  echo "NOTE: app/.env を作成しました。OPENAI_API_KEY を設定すると高品質TTSになります（未設定なら say フォールバック）"
fi

(cd app && bun install)
(cd app/client 2>/dev/null && bun install) || true

echo "== setup 完了 =="
```

Run: `chmod +x scripts/setup.sh && ./scripts/setup.sh`
Expected: whisper-cpp / ffmpeg が入り、モデルがダウンロードされ、`setup 完了` が出る

- [ ] **Step 2: STT の失敗するテストを書く**

`app/server/__tests__/stt.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { buildWhisperArgs, parseWhisperJson } from "../stt";

describe("stt", () => {
  test("buildWhisperArgs は英語専用・JSON出力の引数列を組み立てる", () => {
    const args = buildWhisperArgs("/m/model.bin", "/tmp/in.wav", "/tmp/out");
    expect(args).toEqual([
      "-m", "/m/model.bin",
      "-f", "/tmp/in.wav",
      "-l", "en",
      "-oj",
      "-of", "/tmp/out",
      "-np",
    ]);
  });

  test("parseWhisperJson は transcription の text を結合して trim する", () => {
    const json = JSON.stringify({
      transcription: [
        { text: " Hello, my name is", offsets: { from: 0, to: 1200 } },
        { text: " Shin.", offsets: { from: 1200, to: 2000 } },
      ],
    });
    expect(parseWhisperJson(json)).toBe("Hello, my name is Shin.");
  });

  test("parseWhisperJson は transcription が無ければ空文字", () => {
    expect(parseWhisperJson("{}")).toBe("");
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/stt.test.ts`
Expected: FAIL（`stt` モジュールが存在しない）

- [ ] **Step 4: stt.ts を実装**

`app/server/stt.ts`:

```ts
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { MODELS_DIR } from "./paths";

export const WHISPER_MODEL_PATH = path.join(MODELS_DIR, "ggml-large-v3-turbo.bin");

export type SpawnFn = (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>;

async function realSpawn(cmd: string[]): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

export function buildWhisperArgs(modelPath: string, wavPath: string, outBase: string): string[] {
  return ["-m", modelPath, "-f", wavPath, "-l", "en", "-oj", "-of", outBase, "-np"];
}

export function parseWhisperJson(jsonText: string): string {
  const data = JSON.parse(jsonText) as { transcription?: Array<{ text: string }> };
  if (!data.transcription) return "";
  return data.transcription.map((s) => s.text).join("").trim();
}

function whisperBin(): string {
  return Bun.which("whisper-cli") ?? Bun.which("whisper-cpp") ?? "whisper-cli";
}

/** 入力音声（webm/wav等）を 16kHz mono WAV に変換して whisper で文字起こしする */
export async function transcribeAudio(
  inputPath: string,
  opts: { spawnFn?: SpawnFn } = {},
): Promise<string> {
  const spawn = opts.spawnFn ?? realSpawn;
  const work = mkdtempSync(path.join(tmpdir(), "stt-"));
  try {
    const wavPath = path.join(work, "in.wav");
    const ff = await spawn([
      "ffmpeg", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath, "-y",
    ]);
    if (ff.exitCode !== 0) throw new Error(`ffmpeg failed: ${ff.stderr.slice(-500)}`);

    const outBase = path.join(work, "out");
    const wh = await spawn([whisperBin(), ...buildWhisperArgs(WHISPER_MODEL_PATH, wavPath, outBase)]);
    if (wh.exitCode !== 0) throw new Error(`whisper failed: ${wh.stderr.slice(-500)}`);

    return parseWhisperJson(readFileSync(`${outBase}.json`, "utf8"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd app && bun test server/__tests__/stt.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 6: 実機スモークスクリプトを作成して実行**

`scripts/smoke-stt.sh`:

```bash
#!/usr/bin/env bash
# say で英語音声を生成し、STT パイプラインを実機で通すスモークテスト
set -euo pipefail
cd "$(dirname "$0")/.."

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say -v Samantha -o "$TMP/hello.aiff" "Hello, this is a smoke test for the speech pipeline."

cd app && bun -e "
import { transcribeAudio } from './server/stt';
const text = await transcribeAudio('$TMP/hello.aiff');
console.log('TRANSCRIPT:', text);
if (!/smoke test/i.test(text)) { console.error('FAIL: 期待した語が含まれない'); process.exit(1); }
console.log('SMOKE OK');
"
```

Run: `chmod +x scripts/smoke-stt.sh && ./scripts/smoke-stt.sh`
Expected: `TRANSCRIPT: Hello, this is a smoke test...` と `SMOKE OK`（初回はモデルロードで数秒）

- [ ] **Step 7: コミット**

```bash
git add scripts/ app/server/stt.ts app/server/__tests__/stt.test.ts
git commit -m "feat: whisper.cppによるSTTパイプラインとセットアップスクリプトを追加"
```

---

### Task 3: TTS（OpenAI + キャッシュ + say フォールバック）

**Files:**
- Create: `app/server/tts.ts`
- Test: `app/server/__tests__/tts.test.ts`

**Interfaces:**
- Consumes: `paths.ts` の `TTS_CACHE_DIR`
- Produces:
  - `tts.ts`: `cacheKeyFor(model: string, voice: string, text: string): string`（sha256 hex） / `synthesize(text: string, opts?: SynthesizeOpts): Promise<{ audio: Uint8Array; mime: string; engine: "openai" | "say" }>` / `type SynthesizeOpts = { voice?: string; apiKey?: string; cacheDir?: string; fetchFn?: typeof fetch; spawnFn?: SpawnFn }`（`SpawnFn` は `stt.ts` から import）
  - デフォルト: model=`gpt-4o-mini-tts`, voice=`alloy`, 出力 mp3。`apiKey` 未指定時は `Bun.env.OPENAI_API_KEY`、それも無ければ `say`→ffmpeg で mp3 生成

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/tts.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheKeyFor, synthesize } from "../tts";

describe("tts", () => {
  test("cacheKeyFor は model/voice/text で決まる64桁hex", () => {
    const k1 = cacheKeyFor("gpt-4o-mini-tts", "alloy", "Hello");
    const k2 = cacheKeyFor("gpt-4o-mini-tts", "alloy", "Hello");
    const k3 = cacheKeyFor("gpt-4o-mini-tts", "nova", "Hello");
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("APIキーがあれば OpenAI を呼び、2回目はキャッシュを使う", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;

    const r1 = await synthesize("Hello there", { apiKey: "sk-test", cacheDir, fetchFn: fakeFetch });
    const r2 = await synthesize("Hello there", { apiKey: "sk-test", cacheDir, fetchFn: fakeFetch });
    expect(calls).toBe(1);
    expect(r1.engine).toBe("openai");
    expect(r1.mime).toBe("audio/mpeg");
    expect(Array.from(r2.audio)).toEqual([1, 2, 3]);
    expect(readdirSync(cacheDir)).toHaveLength(1);
  });

  test("APIキーが無ければ say フォールバックで生成する", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const spawned: string[][] = [];
    const fakeSpawn = async (cmd: string[]) => {
      spawned.push(cmd);
      // say / ffmpeg が生成するはずの出力ファイルを偽造
      // say: ["say","-v","Samantha","-o",<aiff>,<text>] → -o の次
      // ffmpeg: ["ffmpeg","-i",<aiff>,<mp3>,"-y"] → 末尾 "-y" の1つ前
      const oIdx = cmd.indexOf("-o");
      const out = oIdx >= 0 ? cmd[oIdx + 1] : cmd[cmd.length - 2];
      await Bun.write(out, new Uint8Array([9, 9]));
      return { exitCode: 0, stderr: "" };
    };
    const r = await synthesize("Hello", { apiKey: undefined, cacheDir, spawnFn: fakeSpawn });
    expect(r.engine).toBe("say");
    expect(spawned[0][0]).toBe("say");
    expect(spawned[1][0]).toBe("ffmpeg");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/tts.test.ts`
Expected: FAIL（`tts` モジュールが存在しない）

- [ ] **Step 3: tts.ts を実装**

`app/server/tts.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { TTS_CACHE_DIR } from "./paths";
import type { SpawnFn } from "./stt";

const TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "alloy";

export type SynthesizeOpts = {
  voice?: string;
  apiKey?: string;
  cacheDir?: string;
  fetchFn?: typeof fetch;
  spawnFn?: SpawnFn;
};

export function cacheKeyFor(model: string, voice: string, text: string): string {
  return createHash("sha256").update(`${model}|${voice}|${text}`).digest("hex");
}

async function realSpawn(cmd: string[]): Promise<{ exitCode: number; stderr: string }> {
  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  return { exitCode, stderr };
}

async function synthesizeOpenAI(
  text: string, voice: string, apiKey: string, fetchFn: typeof fetch,
): Promise<Uint8Array> {
  const res = await fetchFn("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: TTS_MODEL, voice, input: text, response_format: "mp3" }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS failed: ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function synthesizeSay(text: string, spawn: SpawnFn): Promise<Uint8Array> {
  const work = mkdtempSync(path.join(tmpdir(), "say-"));
  try {
    const aiff = path.join(work, "out.aiff");
    const mp3 = path.join(work, "out.mp3");
    const s = await spawn(["say", "-v", "Samantha", "-o", aiff, text]);
    if (s.exitCode !== 0) throw new Error(`say failed: ${s.stderr}`);
    const f = await spawn(["ffmpeg", "-i", aiff, mp3, "-y"]);
    if (f.exitCode !== 0) throw new Error(`ffmpeg failed: ${f.stderr}`);
    return new Uint8Array(await Bun.file(mp3).arrayBuffer());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function synthesize(
  text: string, opts: SynthesizeOpts = {},
): Promise<{ audio: Uint8Array; mime: string; engine: "openai" | "say" }> {
  const voice = opts.voice ?? DEFAULT_VOICE;
  const apiKey = opts.apiKey ?? Bun.env.OPENAI_API_KEY;
  const cacheDir = opts.cacheDir ?? TTS_CACHE_DIR;
  mkdirSync(cacheDir, { recursive: true });

  if (apiKey) {
    const cachePath = path.join(cacheDir, `${cacheKeyFor(TTS_MODEL, voice, text)}.mp3`);
    if (existsSync(cachePath)) {
      return { audio: new Uint8Array(await Bun.file(cachePath).arrayBuffer()), mime: "audio/mpeg", engine: "openai" };
    }
    const audio = await synthesizeOpenAI(text, voice, apiKey, opts.fetchFn ?? fetch);
    await Bun.write(cachePath, audio);
    return { audio, mime: "audio/mpeg", engine: "openai" };
  }

  const audio = await synthesizeSay(text, opts.spawnFn ?? realSpawn);
  return { audio, mime: "audio/mpeg", engine: "say" };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test server/__tests__/tts.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: コミット**

```bash
git add app/server/tts.ts app/server/__tests__/tts.test.ts
git commit -m "feat: OpenAI TTS(キャッシュ付き)とsayフォールバックを追加"
```

---

### Task 4: 対話（Claude Agent SDK）

**Files:**
- Create: `app/server/converse.ts`
- Test: `app/server/__tests__/converse.test.ts`

**Interfaces:**
- Consumes: `session-log.ts` の `appendEvent`, `SessionEvent` / `paths.ts` の `sessionLogPath`
- Produces:
  - `converse.ts`: `PARTNER_SYSTEM_PROMPT: string` / `type ClaudeRunner = (prompt: string, resumeId?: string) => Promise<{ text: string; sessionId: string }>` / `runClaudeTurn: ClaudeRunner`（Agent SDK 実装） / `converseTurn(args: { userText: string; sessionId?: string; runner?: ClaudeRunner; logFile?: string }): Promise<{ replyText: string; sessionId: string }>`
  - `converseTurn` は user_utterance と assistant_reply を JSONL に追記してから返す

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/converse.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { converseTurn } from "../converse";
import { readEvents } from "../session-log";

describe("converse", () => {
  test("初回ターン: resume無しで runner を呼び、2イベントをログし、sessionId を返す", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "conv-"));
    const logFile = path.join(dir, "log.jsonl");
    const calls: Array<{ prompt: string; resumeId?: string }> = [];
    const fakeRunner = async (prompt: string, resumeId?: string) => {
      calls.push({ prompt, resumeId });
      return { text: "Nice to meet you!", sessionId: "claude-sess-1" };
    };

    const r = await converseTurn({ userText: "Hi, I am Shin.", runner: fakeRunner, logFile });

    expect(r.replyText).toBe("Nice to meet you!");
    expect(r.sessionId).toBe("claude-sess-1");
    expect(calls[0].resumeId).toBeUndefined();
    expect(calls[0].prompt).toContain("Hi, I am Shin.");

    const events = readEvents(logFile);
    expect(events.map((e) => e.type)).toEqual(["user_utterance", "assistant_reply"]);
    expect(events[1].text).toBe("Nice to meet you!");
  });

  test("2ターン目: 前回の sessionId を resume として渡す", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "conv-"));
    const logFile = path.join(dir, "log.jsonl");
    const calls: Array<{ resumeId?: string }> = [];
    const fakeRunner = async (_prompt: string, resumeId?: string) => {
      calls.push({ resumeId });
      return { text: "ok", sessionId: "claude-sess-1" };
    };

    await converseTurn({ userText: "second turn", sessionId: "claude-sess-1", runner: fakeRunner, logFile });
    expect(calls[0].resumeId).toBe("claude-sess-1");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/converse.test.ts`
Expected: FAIL（`converse` モジュールが存在しない）

- [ ] **Step 3: converse.ts を実装**

`app/server/converse.ts`:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { appendEvent } from "./session-log";
import { sessionLogPath } from "./paths";

export const PARTNER_SYSTEM_PROMPT = `You are an English conversation partner for a Japanese IT professional (CEFR A2-B1).
- You are a friendly colleague. Talk about tech work, identity management, security, AI — or whatever the learner brings up.
- Keep every reply SHORT: 2-4 sentences, then ask ONE follow-up question.
- Use plain, high-frequency English (B1 level). No rare idioms.
- Do NOT correct errors explicitly in this mode; just respond naturally (recast briefly only when meaning is unclear).
- Never switch to Japanese.`;

export type ClaudeRunner = (prompt: string, resumeId?: string) => Promise<{ text: string; sessionId: string }>;

export const runClaudeTurn: ClaudeRunner = async (prompt, resumeId) => {
  let sessionId = resumeId ?? "";
  let text = "";
  for await (const msg of query({
    prompt,
    options: {
      systemPrompt: PARTNER_SYSTEM_PROMPT,
      model: "sonnet",
      allowedTools: [],
      maxTurns: 1,
      ...(resumeId ? { resume: resumeId } : {}),
    },
  })) {
    if (msg.type === "system" && msg.subtype === "init") sessionId = msg.session_id;
    if (msg.type === "result" && msg.subtype === "success") text = msg.result;
  }
  if (!text) throw new Error("Claude returned empty result");
  return { text, sessionId };
};

export async function converseTurn(args: {
  userText: string;
  sessionId?: string;
  runner?: ClaudeRunner;
  logFile?: string;
}): Promise<{ replyText: string; sessionId: string }> {
  const runner = args.runner ?? runClaudeTurn;
  const logFile = args.logFile ?? sessionLogPath(new Date());
  const now = () => new Date().toISOString();

  appendEvent(logFile, {
    ts: now(), type: "user_utterance", sessionId: args.sessionId ?? "pending", text: args.userText,
  });

  const { text, sessionId } = await runner(args.userText, args.sessionId);

  appendEvent(logFile, { ts: now(), type: "assistant_reply", sessionId, text });
  return { replyText: text, sessionId };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test server/__tests__/converse.test.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: SDK 実物との突き合わせ（実機1ターン）**

SDK のメッセージ型がインストール版と一致するかを確認する。型が違う場合は
`app/node_modules/@anthropic-ai/claude-agent-sdk/` の型定義（`sdk.d.ts` 等の `SDKMessage`）を読んで `runClaudeTurn` を修正する。

Run:

```bash
cd app && bun -e "
import { runClaudeTurn } from './server/converse';
const r = await runClaudeTurn('Say hello in one short sentence.');
console.log('SESSION:', r.sessionId);
console.log('REPLY:', r.text);
"
```

Expected: `SESSION: <uuid>` と 1文の英語応答が表示される（Max サブスクの `claude` CLI 認証を利用。数秒かかる）

- [ ] **Step 6: コミット**

```bash
git add app/server/converse.ts app/server/__tests__/converse.test.ts
git commit -m "feat: Claude Agent SDKによる会話ターン実行とログ記録を追加"
```

---

### Task 5: ヘルスチェックと HTTP サーバ（ルーティング）

**Files:**
- Create: `app/server/health.ts`, `app/server/index.ts`
- Test: `app/server/__tests__/health.test.ts`

**Interfaces:**
- Consumes: `transcribeAudio`（Task 2） / `synthesize`（Task 3） / `converseTurn`（Task 4） / `ensureDirs`, `RECORDINGS_DIR`, `sessionLogPath`（Task 1） / `appendEvent`（Task 1）
- Produces:
  - `health.ts`: `type WhichFn = (bin: string) => string | null` / `checkHealth(opts?: { whichFn?: WhichFn; env?: Record<string, string | undefined> }): { ok: boolean; whisper: boolean; ffmpeg: boolean; claude: boolean; ttsKey: boolean; modelFile: boolean }`
  - HTTP API（すべて `http://localhost:3111`）:
    - `GET /api/health` → 上記 JSON
    - `POST /api/stt`（body: 音声バイナリ、header `content-type: audio/webm` 等）→ `{ text: string }`。受信音声は `data/recordings/YYYY-MM-DD/<epoch_ms>.webm` に保存
    - `POST /api/tts`（JSON `{ text: string, voice?: string }`）→ `audio/mpeg` バイナリ
    - `POST /api/converse`（JSON `{ userText: string, sessionId?: string }`）→ `{ replyText: string, sessionId: string }`
    - `POST /api/session/start` → `{ ok: true }`（session_start をログ）
    - `POST /api/session/end`（JSON `{ sessionId: string }`）→ `{ ok: true }`（session_end をログ）

- [ ] **Step 1: health の失敗するテストを書く**

`app/server/__tests__/health.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { checkHealth } from "../health";

describe("health", () => {
  test("全依存が揃っていれば ok=true", () => {
    const h = checkHealth({
      whichFn: () => "/opt/homebrew/bin/x",
      env: { OPENAI_API_KEY: "sk-test" },
      modelExists: () => true,
    });
    expect(h).toEqual({ ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: true });
  });

  test("ttsKey が無くても ok は true（say フォールバックがあるため）", () => {
    const h = checkHealth({ whichFn: () => "/bin/x", env: {}, modelExists: () => true });
    expect(h.ttsKey).toBe(false);
    expect(h.ok).toBe(true);
  });

  test("whisper が無いと ok=false", () => {
    const h = checkHealth({
      whichFn: (bin) => (bin.startsWith("whisper") ? null : "/bin/x"),
      env: {},
      modelExists: () => true,
    });
    expect(h.whisper).toBe(false);
    expect(h.ok).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test server/__tests__/health.test.ts`
Expected: FAIL（`health` モジュールが存在しない）

- [ ] **Step 3: health.ts を実装**

`app/server/health.ts`:

```ts
import { existsSync } from "node:fs";
import { WHISPER_MODEL_PATH } from "./stt";

export type WhichFn = (bin: string) => string | null;

export function checkHealth(opts: {
  whichFn?: WhichFn;
  env?: Record<string, string | undefined>;
  modelExists?: () => boolean;
} = {}): { ok: boolean; whisper: boolean; ffmpeg: boolean; claude: boolean; ttsKey: boolean; modelFile: boolean } {
  const which = opts.whichFn ?? ((b: string) => Bun.which(b));
  const env = opts.env ?? Bun.env;
  const modelExists = opts.modelExists ?? (() => existsSync(WHISPER_MODEL_PATH));

  const whisper = Boolean(which("whisper-cli") ?? which("whisper-cpp"));
  const ffmpeg = Boolean(which("ffmpeg"));
  const claude = Boolean(which("claude"));
  const ttsKey = Boolean(env.OPENAI_API_KEY);
  const modelFile = modelExists();

  return { ok: whisper && ffmpeg && claude && modelFile, whisper, ffmpeg, claude, ttsKey, modelFile };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test server/__tests__/health.test.ts`
Expected: PASS（3 tests）

- [ ] **Step 5: index.ts（ルーティング）を実装**

`app/server/index.ts`:

```ts
import path from "node:path";
import { mkdirSync } from "node:fs";
import { ensureDirs, RECORDINGS_DIR, sessionLogPath } from "./paths";
import { appendEvent } from "./session-log";
import { transcribeAudio } from "./stt";
import { synthesize } from "./tts";
import { converseTurn } from "./converse";
import { checkHealth } from "./health";

ensureDirs();
const PORT = 3111;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

async function handleStt(req: Request): Promise<Response> {
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length === 0) return json({ error: "empty audio body" }, 400);
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(RECORDINGS_DIR, day);
  mkdirSync(dir, { recursive: true });
  const ext = (req.headers.get("content-type") ?? "").includes("wav") ? "wav" : "webm";
  const file = path.join(dir, `${Date.now()}.${ext}`);
  await Bun.write(file, bytes);
  const text = await transcribeAudio(file);
  return json({ text });
}

async function handleTts(req: Request): Promise<Response> {
  const body = (await req.json()) as { text?: string; voice?: string };
  if (!body.text?.trim()) return json({ error: "text is required" }, 400);
  const { audio, mime, engine } = await synthesize(body.text, { voice: body.voice });
  return new Response(audio, { headers: { "content-type": mime, "x-tts-engine": engine } });
}

async function handleConverse(req: Request): Promise<Response> {
  const body = (await req.json()) as { userText?: string; sessionId?: string };
  if (!body.userText?.trim()) return json({ error: "userText is required" }, 400);
  const r = await converseTurn({ userText: body.userText, sessionId: body.sessionId });
  return json(r);
}

Bun.serve({
  port: PORT,
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (req.method === "GET" && url.pathname === "/api/health") return json(checkHealth());
      if (req.method === "POST" && url.pathname === "/api/stt") return await handleStt(req);
      if (req.method === "POST" && url.pathname === "/api/tts") return await handleTts(req);
      if (req.method === "POST" && url.pathname === "/api/converse") return await handleConverse(req);
      if (req.method === "POST" && url.pathname === "/api/session/start") {
        appendEvent(sessionLogPath(new Date()), { ts: new Date().toISOString(), type: "session_start", sessionId: "pending" });
        return json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/session/end") {
        const body = (await req.json()) as { sessionId?: string };
        appendEvent(sessionLogPath(new Date()), {
          ts: new Date().toISOString(), type: "session_end", sessionId: body.sessionId ?? "unknown",
        });
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      appendEvent(sessionLogPath(new Date()), {
        ts: new Date().toISOString(), type: "error", sessionId: "server", text: message,
      });
      return json({ error: message }, 500);
    }
  },
});

console.log(`learn-english server: http://localhost:${PORT} (health: /api/health)`);
```

- [ ] **Step 6: サーバを起動して curl でスモーク**

Run（ターミナル1）: `cd app && bun run dev`
Run（ターミナル2）:

```bash
curl -s http://localhost:3111/api/health | head -c 300; echo
curl -s -X POST http://localhost:3111/api/converse \
  -H 'content-type: application/json' \
  -d '{"userText":"Hi! Please say hello in one sentence."}'
curl -s -X POST http://localhost:3111/api/tts \
  -H 'content-type: application/json' \
  -d '{"text":"Hello, nice to meet you."}' -o /tmp/tts-test.mp3 && afplay /tmp/tts-test.mp3
```

Expected: health が JSON を返す（`ok: true`）。converse が `{"replyText":"...","sessionId":"..."}` を返す。mp3 が再生される。`data/sessions/` に JSONL が生えている

- [ ] **Step 7: コミット**

```bash
git add app/server/health.ts app/server/index.ts app/server/__tests__/health.test.ts
git commit -m "feat: ヘルスチェックとHTTP APIルーティングを追加"
```

---

### Task 6: クライアント（1画面 UI）と README

**Files:**
- Create: `app/client/package.json`, `app/client/vite.config.ts`, `app/client/index.html`, `app/client/src/main.tsx`, `app/client/src/App.tsx`, `app/client/src/api.ts`, `app/client/src/audio.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: Task 5 の HTTP API（`/api/health` `/api/stt` `/api/tts` `/api/converse` `/api/session/start` `/api/session/end`）
- Produces: `http://localhost:5173`（Vite dev サーバ、`/api` は 3111 へプロキシ）で動く会話画面

- [ ] **Step 1: クライアント雛形を作成**

`app/client/package.json`:

```json
{
  "name": "learn-english-client",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build"
  },
  "dependencies": {
    "react": "^18.3.0",
    "react-dom": "^18.3.0"
  },
  "devDependencies": {
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

`app/client/vite.config.ts`:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:3111" },
  },
});
```

`app/client/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>learn-english</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`app/client/src/main.tsx`:

```tsx
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
```

Run: `cd app/client && bun install`
Expected: 依存が入る

- [ ] **Step 2: API/録音ヘルパーを実装**

`app/client/src/api.ts`:

```ts
export type Health = {
  ok: boolean; whisper: boolean; ffmpeg: boolean; claude: boolean; ttsKey: boolean; modelFile: boolean;
};

export async function getHealth(): Promise<Health> {
  const res = await fetch("/api/health");
  return res.json();
}

export async function sttUpload(blob: Blob): Promise<string> {
  const res = await fetch("/api/stt", {
    method: "POST",
    headers: { "content-type": blob.type || "audio/webm" },
    body: blob,
  });
  if (!res.ok) throw new Error(`STT failed: ${(await res.json()).error}`);
  return (await res.json()).text as string;
}

export async function converse(userText: string, sessionId?: string): Promise<{ replyText: string; sessionId: string }> {
  const res = await fetch("/api/converse", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userText, sessionId }),
  });
  if (!res.ok) throw new Error(`converse failed: ${(await res.json()).error}`);
  return res.json();
}

export async function ttsFetch(text: string): Promise<Blob> {
  const res = await fetch("/api/tts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`TTS failed: ${(await res.json()).error}`);
  return res.blob();
}

export async function sessionStart(): Promise<void> {
  await fetch("/api/session/start", { method: "POST" });
}

export async function sessionEnd(sessionId: string): Promise<void> {
  await fetch("/api/session/end", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
}
```

`app/client/src/audio.ts`:

```ts
export class Recorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];

  async start(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.start();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const mr = this.mediaRecorder;
      if (!mr) return reject(new Error("not recording"));
      mr.onstop = () => {
        mr.stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(this.chunks, { type: "audio/webm" }));
      };
      mr.stop();
    });
  }
}

export async function playBlob(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  await audio.play();
  await new Promise<void>((resolve) => { audio.onended = () => resolve(); });
  URL.revokeObjectURL(url);
}
```

- [ ] **Step 3: App.tsx（1画面）を実装**

`app/client/src/App.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { converse, getHealth, sessionEnd, sessionStart, sttUpload, ttsFetch, type Health } from "./api";
import { playBlob, Recorder } from "./audio";

type Turn = { role: "you" | "ai"; text: string };
type Status = "idle" | "recording" | "transcribing" | "thinking" | "speaking" | "error";

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const sessionIdRef = useRef<string | undefined>(undefined);
  const recorderRef = useRef(new Recorder());

  useEffect(() => {
    getHealth().then(setHealth).catch(() => setHealth(null));
    sessionStart();
    return () => { if (sessionIdRef.current) sessionEnd(sessionIdRef.current); };
  }, []);

  async function onMainButton() {
    setErrorMsg("");
    if (status === "idle") {
      await recorderRef.current.start();
      setStatus("recording");
      return;
    }
    if (status !== "recording") return;
    try {
      setStatus("transcribing");
      const blob = await recorderRef.current.stop();
      const text = await sttUpload(blob);
      if (!text) { setStatus("idle"); return; }
      setTurns((t) => [...t, { role: "you", text }]);

      setStatus("thinking");
      const { replyText, sessionId } = await converse(text, sessionIdRef.current);
      sessionIdRef.current = sessionId;
      setTurns((t) => [...t, { role: "ai", text: replyText }]);

      setStatus("speaking");
      await playBlob(await ttsFetch(replyText));
      setStatus("idle");
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  const label: Record<Status, string> = {
    idle: "🎙 話す（クリックで録音開始）",
    recording: "⏹ 録音中…（クリックで送信）",
    transcribing: "📝 文字起こし中…",
    thinking: "🤔 考え中…",
    speaking: "🔊 再生中…",
    error: "🎙 もう一度話す",
  };

  return (
    <main style={{ maxWidth: 640, margin: "2rem auto", fontFamily: "system-ui", padding: "0 1rem" }}>
      <h1 style={{ fontSize: "1.2rem" }}>learn-english — M1 walking skeleton</h1>
      {health && !health.ok && (
        <p style={{ color: "crimson" }}>
          依存が不足しています: {JSON.stringify(health)} — `scripts/setup.sh` を実行してください
        </p>
      )}
      {health && health.ok && !health.ttsKey && (
        <p style={{ color: "darkorange" }}>OPENAI_API_KEY 未設定のため TTS は say フォールバックです</p>
      )}
      <div style={{ margin: "1rem 0" }}>
        <button
          onClick={onMainButton}
          disabled={status === "transcribing" || status === "thinking" || status === "speaking"}
          style={{ fontSize: "1.1rem", padding: "0.8rem 1.4rem", cursor: "pointer" }}
        >
          {label[status]}
        </button>
      </div>
      {errorMsg && <p style={{ color: "crimson" }}>{errorMsg}</p>}
      <section>
        {turns.map((t, i) => (
          <p key={i} style={{ whiteSpace: "pre-wrap" }}>
            <strong>{t.role === "you" ? "You" : "AI"}:</strong> {t.text}
          </p>
        ))}
      </section>
    </main>
  );
}
```

- [ ] **Step 4: 手動E2Eスモーク（全ループ実機確認）**

Run（ターミナル1）: `cd app && bun run dev`
Run（ターミナル2）: `cd app/client && bun run dev` → ブラウザで `http://localhost:5173` を開く

確認手順:
1. マイク許可 → ボタンをクリック → 「Hi, my name is Shin. I work on identity management.」と話す → もう一度クリック
2. 自分の発話テキストが表示される（whisper の精度確認）
3. AI の返答（2〜4文＋質問）が表示され、音声が再生される
4. もう1ターン返答して会話が継続する（sessionId 維持の確認）
5. `data/sessions/$(date +%F).jsonl` に session_start / user_utterance / assistant_reply が記録されている
6. `data/recordings/$(date +%F)/` に webm が保存されている

Expected: 上記すべて成立。1ターンの待ち時間が spec §4.3 の想定（3〜8秒）に収まるか体感確認し、大きく超える場合は結果をログに残す（M2 で対処）

- [ ] **Step 5: README を作成**

`README.md`:

```markdown
# learn-english

俺専用の英会話学習システム。設計と根拠は
[docs/superpowers/specs/2026-07-05-learn-english-system-design.md](docs/superpowers/specs/2026-07-05-learn-english-system-design.md) を参照。

## セットアップ（初回のみ）

\`\`\`bash
./scripts/setup.sh          # brew 依存・whisperモデルDL・bun install
# 任意: app/.env に OPENAI_API_KEY を設定（未設定なら say フォールバック）
\`\`\`

## 起動

\`\`\`bash
cd app && bun run dev        # APIサーバ :3111
cd app/client && bun run dev # UI :5173（/api をプロキシ）
\`\`\`

ブラウザで http://localhost:5173 を開き、ボタンをクリックして英語で話す。

## テスト

\`\`\`bash
cd app && bun test           # ユニットテスト
./scripts/smoke-stt.sh       # STT 実機スモーク
\`\`\`

## データ

- `data/sessions/*.jsonl` — セッションログ（コミット対象）
- `data/recordings/` `data/tts-cache/` `models/` — gitignore
```

- [ ] **Step 6: 全テストを流して最終コミット**

Run: `cd app && bun test`
Expected: 全テスト PASS

```bash
git add app/client/ README.md
git commit -m "feat: 会話ループの1画面UI(React+Vite)とREADMEを追加"
```

---

## Self-Review 結果（プラン作成時に実施済み）

- スペック対応: M1 の定義（spec §6.2「1画面で 録音→whisper→Claude応答→TTS再生 のループ＋セッションログ保存」）を Task 1〜6 でカバー。§4.5 のエラー処理（TTS フォールバック・JSONL 追記・再録音可能な UI）を含む。§4.1 のスタック（Bun/React+Vite/whisper.cpp/OpenAI TTS/Agent SDK）に一致
- 型整合: `SpawnFn`（stt.ts 定義 → tts.ts が import）、`SessionEvent`、`ClaudeRunner`、API レスポンス形は各 Task の Interfaces に明記
- 注意点: `@anthropic-ai/claude-agent-sdk` のメッセージ型はバージョンで変わりうるため、Task 4 Step 5 で実機突き合わせを必須にしている。whisper.cpp の JSON スキーマ（`transcription[].text`）が異なる場合は `scripts/smoke-stt.sh` で検出できる
