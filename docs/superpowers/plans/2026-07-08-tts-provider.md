# ローカルTTS対応（OpenAI互換 音声エンドポイントの差し替え可能化）実装計画

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TTS の合成先（OpenAI 互換 `/v1/audio/speech`）を、Base URL・モデル・voice の3点で差し替え可能にし、kokoro-fastapi 等のローカル TTS を**APIキーなし**で使えるようにする。何も設定しなければ現行と完全に同一（キーあり→OpenAI、なし→macOS `say`、同梱バンドル最優先）。

**Architecture:** 既存の 3層ルックアップ（同梱バンドル → キャッシュ → HTTP TTS → `say`）はそのまま残し、HTTP TTS 呼び出しの向き先（Base URL / model / voice / APIキー）を「opts（リクエスト・DB 由来）> env（`TTS_*`）> 既定」で解決する `resolveTtsConfig` を `tts.ts` に導入する。永続化は既存 `llm_settings`（単一行）と同じパターンで新テーブル `tts_settings`（単一行 id=1）を追加し、`synthesize` はリクエストごとに DB 設定を受け取る（起動時 apply 不要 = 保存即反映）。HTTP は新モジュール `routes/tts-settings.ts` に `GET/PUT /api/tts-settings` を追加。UI は v0.18.0 の `SettingsScreen`（LLM セクションの下）に「音声（TTS）」ブロックを追加する。

**Tech Stack:** Bun + TypeScript / bun:sqlite（`Database`）/ OpenAI 互換 `/v1/audio/speech`（fetch）/ React 18 + Vite（クライアント）/ named 型 i18n（`app/client/src/i18n.ts`）

## Global Constraints

- **既定完全不変（回帰基準・最優先）**: `TTS_BASE_URL` / `TTS_MODEL` / `TTS_VOICE` 未設定 **かつ** `tts_settings` 行なしのとき、`synthesize` は現行と bit-identical に動く — 同梱バンドル（`content/sentences/audio/`）を最優先、次に `OPENAI_API_KEY` があれば `https://api.openai.com/v1/audio/speech` を `model=gpt-4o-mini-tts` / `voice=alloy` / `response_format=mp3` で叩き、無ければ HTTP 層を飛ばして macOS `say` にフォールバックする。これを `tts.test.ts` でロックする（Task 1）。
- **`cacheKeyFor` の式は凍結**: 同梱バンドルの各ファイルは `sha256("gpt-4o-mini-tts|alloy|<text>")` で命名済み（`content/sentences/audio/` にコミット済み・`scripts/generate-sentence-audio.ts` が生成）。`cacheKeyFor(model, voice, text) = sha256(`${model}|${voice}|${text}`)` の**式・区切り・並び順を変えない**。既定 model/voice のとき現行と同一キーになりバンドル/キャッシュにヒットする。
- **キーなしローカルの分岐**: 現行は「APIキーなし → HTTP 層スキップ → `say`」。ローカル TTS（kokoro-fastapi 等）は鍵不要なので、**「APIキーがある、または baseUrl が既定以外（カスタム）に向いている」**とき HTTP 層を試す、に条件を広げる。既定 baseUrl + 鍵なしのときだけ現行どおり `say` に落ちる。APIキーがあるときだけ `Authorization: Bearer` を付与する（鍵なしローカルはヘッダなしで送る）。
- **secrets 衛生**: TTS の APIキーは `app/.env` の `TTS_API_KEY`（未設定なら `OPENAI_API_KEY` にフォールバック）**のみ**。DB（`tts_settings`）・API レスポンス・UI・console ログにキー値を一切出さない。API はキーの**有無**を `apiKeyConfigured: boolean` でのみ開示する。ルート層は APIキーを一切読まない（`synthesize` が env からのみ解決する）ので、経路上でキーが漏れない。
- **アダプタ非新設**: 既存 `synthesizeOpenAI` を Base URL / APIキー対応に拡張（`synthesizeHttp` へリネーム）するのみ。新しいプロバイダ実装・SDK 追加はしない。フォーマットは mp3 固定（同梱・キャッシュの `.mp3` 命名とクライアント `playBlob` に整合。kokoro-fastapi も mp3 出力対応）。
- **`engine` の戻り値は不変**: `synthesize` の戻り `engine: "openai" | "say"` の union を変えない。HTTP 経路（OpenAI でもローカルでも）は `"openai"` を返す（＝「HTTP TTS 経由」の意味）。`generate-sentence-audio.ts` が `result.engine === "openai"` に依存しているため union 変更は避ける。
- **makeXRoutes / ensureSchema パターン**: `tts_settings` は `llm_settings` と同じ**単一行（id=1・`CHECK (id = 1)`）**。`ensureTtsSettingsSchema(db)` は `CREATE TABLE IF NOT EXISTS` のみ（ALTER・マイグレーション機構は作らない）。DB にキー列を持たせない。
- **保存即反映（apply 不要）**: `synthesize` はリクエストごとに DB 設定を deps 経由で受け取るため、LLM 設定のような「実行中プロセスへの apply」機構は不要。PUT 保存後、次の TTS リクエストから新設定が効く。
- **fail-open**: HTTP TTS が失敗（非200・例外）したら現行どおり `say` にフォールバックしてセッションを継続する（`say` も失敗したときだけ reject）。DB の不正値は route が保存前に検証する。
- **i18n named 型 EN/JA additive**: 追加キーは v0.18.0 の `settings` ブロック（`SettingsStrings`）に additive で足す。既存キーは一字一句変更しない。
- **研究トーン**: UI 文言は情報的・中立。「品質は選んだモデル/音声に依存、既定（OpenAI）が動作確認済みの基準」を維持する。
- **v0.18.0 が先にマージされる前提**: 本計画の Task 6/7 は v0.18.0（`docs/superpowers/plans/2026-07-08-llm-roles-settings.md`）の `SettingsScreen`（Task 8）・`SettingsStrings`（Task 7）が**すでに存在する**前提の差分。実装時にその実形を確認してからアンカーを合わせる。
- **TDD（サーバ）**: サーバ新ロジックは赤 → 緑。テストは `__tests__/`、フェイクは `__tests__/helpers/route-deps.ts` の `satisfies`、HTTP は `getReq`/`putJson` で `makeFetchHandler(deps)` を直接叩く。クライアントは React 単体テスト基盤が無いため typecheck + build で担保する（既存規約どおり）。
- **コミット**: Conventional Commits（日本語）。各タスク末尾で 1 コミット。
- **検証ゲート**: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`。
- **ドキュメントゲート（AGENTS.md）**: ユーザーに見える変更なので同ブランチで README を更新し、CHANGELOG に v0.19.0 を追記する（Task 8）。

## 現状 TTS マップ（実コードで確定）

`app/server/tts.ts`（105行）が単一の合成関数を提供する。呼び出し経路と分岐は次のとおり。

- **定数（ハードコード）**: `TTS_MODEL = "gpt-4o-mini-tts"`、`DEFAULT_VOICE = "alloy"`。Base URL は `synthesizeOpenAI` 内に `https://api.openai.com/v1/audio/speech` 直書き。
- **キャッシュキー**: `cacheKeyFor(model, voice, text) = sha256(`${model}|${voice}|${text}`)`（64桁hex）。**model と voice は既に鍵に含まれる**（baseUrl は含まれない）。
- **`synthesize(text, opts)` の3層ルックアップ**:
  1. **同梱バンドル**（`opts.bundledDir ?? BUNDLED_AUDIO_DIR = content/sentences/audio`）: `cacheKeyFor(TTS_MODEL, voice, text).mp3` が存在すれば **APIキーの有無に関わらず最優先**で返す（`engine: "openai"`）。暗記例文300はここで即・無料・低遅延で鳴る。
  2. **APIキーがあるとき**（`opts.apiKey ?? Bun.env.OPENAI_API_KEY`）だけ、`opts.cacheDir ?? TTS_CACHE_DIR = data/tts-cache` の `cacheKeyFor(...).mp3` を見て、あれば返す。無ければ `synthesizeOpenAI` を叩き結果をキャッシュへ書いて返す（`engine: "openai"`）。HTTP 失敗は warn して次へ。
  3. **APIキーがない、または上で HTTP が失敗**したら `synthesizeSay`（macOS `say` → `ffmpeg` で mp3 化。テキストはファイル経由で `say` に渡し argv インジェクションを防ぐ）で合成する（`engine: "say"`）。両方失敗なら reject。
- **`synthesizeOpenAI(text, voice, apiKey, fetchFn)`**: `POST /v1/audio/speech`、body `{ model: TTS_MODEL, voice, input: text, response_format: "mp3" }`、`Authorization: Bearer <apiKey>`。mime は常に `audio/mpeg`。
- **HTTP 入口**: `app/server/routes/system.ts` の `handleTts` が `POST /api/tts`（body `{ text, voice? }`）で `deps.synthesize(text, { voice })` を呼び、`content-type` と `x-tts-engine` ヘッダで返す。`SystemRoutesDeps.synthesize: typeof synthesize`。クライアントは `app/client/src/api/converse.ts` の `ttsFetch(text)`（body は `{ text }` のみ）→ `app/client/src/api/tts.ts` の `playTtsCached` / `prefetchTts` がタブ内 Blob キャッシュとして使う。
- **同梱バンドルの生成**: `scripts/generate-sentence-audio.ts` が `synthesize(s.en, { cacheDir: BUNDLED_AUDIO_DIR })`（＝既定 model/voice）で `content/sentences/audio/` を冪等生成し、`result.engine === "openai"`（＝OpenAI 由来のキャッシュ）を成功条件にしている。**この生成は既定の OpenAI 設定に固定されねばならない**（TTS_* env に引きずられるとバンドルのキーがずれる → Task 1 でピン留めする）。

### 主要設計判断

1. **キーなしローカルの分岐**: HTTP 層を試す条件を `apiKey が存在` → `apiKey が存在 || baseUrl が既定以外` に広げる。既定 baseUrl（`https://api.openai.com/v1`）+ 鍵なしのときだけ現行どおり `say`。ローカルは baseUrl がカスタムなので鍵なしでも HTTP を試し、`Authorization` は鍵があるときだけ付ける。
2. **キャッシュキーの整合**: `cacheKeyFor` は式を凍結（バンドルが依存）。ハードコードの `TTS_MODEL` を**解決済み model** に差し替えて鍵に反映するだけにする。model も voice も鍵に含まれるので、**voice・モデルを変えれば別キー**になり既存キャッシュ/バンドルと混ざらない（バンドルは既定キーのままミスして下の HTTP 層で「その provider の声」で再合成 = アプリ全体で声が統一される）。残る混在は「**同一 model 文字列かつ同一 voice 文字列だが baseUrl だけ違う**」稀ケースのみ（例: ローカルにわざわざ `gpt-4o-mini-tts`/`alloy` を設定）。これは `data/tts-cache` の runtime キャッシュだけで起こりうる。バンドルのキー式を凍結する制約と YAGNI から **baseUrl は鍵に含めず「混在許容」とし、回避策（provider を変える際は `data/tts-cache` を消すか、model/voice を別ラベルにする）を README に注記する**（設定画面で voice/model を変えれば自然に分離されるため、実運用ではほぼ発生しない）。

## Interfaces（タスク間契約）

- **Task 1（`app/server/tts.ts`）Produces:**
  - `export const DEFAULT_TTS_BASE_URL = "https://api.openai.com/v1"`
  - `export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts"`
  - `export const DEFAULT_TTS_VOICE = "alloy"`
  - `export type TtsSettings = { baseUrl: string | null; model: string | null; voice: string | null }`
  - `export type ResolvedTtsConfig = { baseUrl: string; model: string; voice: string; apiKey?: string }`
  - `SynthesizeOpts` に `model?: string` / `baseUrl?: string` / `env?: Record<string, string | undefined>` を追加。
  - `export function resolveTtsConfig(opts?: SynthesizeOpts, env?: Record<string, string | undefined>): ResolvedTtsConfig`
  - `cacheKeyFor` / `synthesize`（型不変）/ `SpawnFn` 経路は不変。
- **Task 2（`app/server/tts-settings-store.ts`・新規 / `app/server/db.ts`）Consumes:** `TtsSettings`（Task 1）。**Produces:**
  - `export function ensureTtsSettingsSchema(db: Database): void`
  - `export type TtsSettingsStore = { get(): TtsSettings | null; save(s: TtsSettings): TtsSettings }`
  - `export function makeTtsSettingsStore(db: Database): TtsSettingsStore`
  - `db.ts` の `openDb` が `ensureTtsSettingsSchema` を呼ぶ。
- **Task 3（`app/server/routes/tts-settings.ts`・新規 / `app/server/routes/system.ts`）Consumes:** `TtsSettings` / `DEFAULT_TTS_*`（Task 1）。**Produces:**
  - `export type TtsSettingsRoutesDeps = { getTtsSettings: () => TtsSettings | null; saveTtsSettings: (s: TtsSettings) => void; ttsEnv: () => { apiKeyConfigured: boolean } }`
  - `export function makeTtsSettingsRoutes(deps: TtsSettingsRoutesDeps): RouteEntry[]`（`GET/PUT /api/tts-settings`）
  - `SystemRoutesDeps` に `getTtsSettings: () => TtsSettings | null` を追加（`handleTts` が DB 設定を `synthesize` へ渡す）。
  - `__tests__/helpers/route-deps.ts` に `getTtsSettings` / `saveTtsSettings` / `ttsEnv` の既定を追加。
- **Task 4（`app/server/routes.ts` / `app/server/index.ts`）Consumes:** Task 2〜3。`RouteDeps` 交差に `TtsSettingsRoutesDeps` を追加、`makeTtsSettingsRoutes` を配線、`index.ts` でストアと env を注入。
- **Task 5（`app/client/src/api/tts-settings.ts`・新規 / `api/index.ts`）Produces:** `TtsSettingsView` / `TtsSettingsInput` / `fetchTtsSettings` / `saveTtsSettings`。
- **Task 6（`app/client/src/i18n.ts`）Produces:** `settings` ブロックへ TTS キー（EN/JA）を additive 追加。
- **Task 7（`app/client/src/screens/SettingsScreen.tsx`）Consumes:** Task 5・Task 6。音声（TTS）セクションを追加。
- **Task 8:** CHANGELOG（v0.19.0）+ README（TTS プロバイダ節・kokoro-fastapi セットアップ・env 表）。

---

### Task 1: サーバ — TTS 設定解決とエンドポイント差し替え（`tts.ts`）+ バンドル生成のピン留め

**Files:**
- Modify: `app/server/tts.ts`（全面）
- Modify: `scripts/generate-sentence-audio.ts`（バンドル生成を既定にピン留め）
- Test: `app/server/__tests__/tts.test.ts`（既存2箇所に `env: {}` を足し、新 describe を追記）

**Interfaces:**
- Consumes: 既存 `BUNDLED_AUDIO_DIR` / `TTS_CACHE_DIR`（`paths.ts`）, `realSpawn` / `SpawnFn`（`spawn.ts`）
- Produces: `DEFAULT_TTS_BASE_URL` / `DEFAULT_TTS_MODEL` / `DEFAULT_TTS_VOICE` / `TtsSettings` / `ResolvedTtsConfig` / `resolveTtsConfig` / 拡張 `SynthesizeOpts`

- [ ] **Step 1: 既存の `say` フォールバックテストに `env: {}` を足す（ambient TTS_* 非依存にする）**

`app/server/__tests__/tts.test.ts` の2つの `say` 経路テストは「鍵なし → HTTP 層を飛ばして say」を検証する。新分岐は「baseUrl がカスタムなら鍵なしでも HTTP を試す」ため、実行環境に `TTS_BASE_URL` が設定されていると誤って HTTP を試してしまう。決定的にするため両テストの `synthesize(...)` 呼び出しに `env: {}` を追加する。

「APIキーが無ければ say フォールバックで生成する」の呼び出しを差し替え:

```ts
      const r = await synthesize("Hello", { apiKey: undefined, cacheDir, spawnFn: makeFakeSpawn(spawned), env: {} });
```

「say 実行時、先頭が「-」のテキストも argv に直接渡らず…」の呼び出しを差し替え:

```ts
      const r = await synthesize(text, { apiKey: undefined, cacheDir, spawnFn: fakeSpawn, env: {} });
```

- [ ] **Step 2: 失敗する新テストを書く（設定解決・分岐・エンドポイント差し替え）**

`app/server/__tests__/tts.test.ts` の import 行を差し替える（`resolveTtsConfig` と定数を追加）:

```ts
import {
  cacheKeyFor, synthesize, resolveTtsConfig,
  DEFAULT_TTS_BASE_URL, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE,
} from "../tts";
```

ファイル末尾（最後の `});` の後）に次の describe を追記する:

```ts
describe("tts provider config", () => {
  test("resolveTtsConfig: 未指定なら既定（OpenAI/gpt-4o-mini-tts/alloy）に解決し鍵は env フォールバック", () => {
    const cfg = resolveTtsConfig({}, { OPENAI_API_KEY: "sk-openai" });
    expect(cfg).toEqual({
      baseUrl: DEFAULT_TTS_BASE_URL, model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE, apiKey: "sk-openai",
    });
  });

  test("resolveTtsConfig: opts > env > 既定 の優先順位で解決する", () => {
    const cfg = resolveTtsConfig(
      { baseUrl: "http://opts:8880/v1" },
      { TTS_BASE_URL: "http://env:8880/v1", TTS_MODEL: "kokoro", TTS_VOICE: "af_sky", TTS_API_KEY: "sk-tts" },
    );
    expect(cfg).toEqual({ baseUrl: "http://opts:8880/v1", model: "kokoro", voice: "af_sky", apiKey: "sk-tts" });
  });

  test("resolveTtsConfig: TTS_API_KEY は OPENAI_API_KEY より優先する", () => {
    const cfg = resolveTtsConfig({}, { TTS_API_KEY: "sk-tts", OPENAI_API_KEY: "sk-openai" });
    expect(cfg.apiKey).toBe("sk-tts");
  });

  test("既定 + 鍵ありは https://api.openai.com/v1/audio/speech を gpt-4o-mini-tts/alloy/mp3 で叩く（現行不変）", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await synthesize("Speak this", { apiKey: "sk-test", cacheDir, fetchFn: fakeFetch, env: {} });
    expect(r.engine).toBe("openai");
    expect(captured!.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(captured!.headers["Authorization"]).toBe("Bearer sk-test");
    expect(captured!.body).toEqual({ model: "gpt-4o-mini-tts", voice: "alloy", input: "Speak this", response_format: "mp3" });
  });

  test("既定 + 鍵なしは HTTP 層を飛ばして say（fetch 未呼び出し）", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let called = 0;
    const fakeFetch = (async () => { called++; return new Response(new Uint8Array([1]), { status: 200 }); }) as unknown as typeof fetch;
    const spawned: string[][] = [];
    const r = await synthesize("Hello", { cacheDir, fetchFn: fakeFetch, spawnFn: makeFakeSpawn(spawned), env: {} });
    expect(called).toBe(0);
    expect(r.engine).toBe("say");
  });

  test("baseUrl がカスタムなら鍵なしでも HTTP を試す・Authorization は付けない", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, headers: init.headers as Record<string, string> };
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await synthesize("Local voice", {
      cacheDir, fetchFn: fakeFetch, env: { TTS_BASE_URL: "http://localhost:8880/v1", TTS_MODEL: "kokoro", TTS_VOICE: "af_sky" },
    });
    expect(r.engine).toBe("openai");
    expect(captured!.url).toBe("http://localhost:8880/v1/audio/speech");
    expect("Authorization" in captured!.headers).toBe(false);
    expect(Array.from(r.audio)).toEqual([9, 9, 9]);
  });

  test("カスタム model/voice は cacheKeyFor が変わり同梱バンドルにヒットせず HTTP を叩く", async () => {
    // 既定キーで bundled ファイルを置くが、カスタム voice では別キーになりミスする
    const bundledDir = mkdtempSync(path.join(tmpdir(), "tts-bundle-"));
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const defaultKey = cacheKeyFor(DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, "Shared text");
    await Bun.write(path.join(bundledDir, `${defaultKey}.mp3`), new Uint8Array([7]));
    let called = 0;
    const fakeFetch = (async () => { called++; return new Response(new Uint8Array([2, 2]), { status: 200 }); }) as unknown as typeof fetch;
    const r = await synthesize("Shared text", {
      bundledDir, cacheDir, fetchFn: fakeFetch,
      env: { TTS_BASE_URL: "http://localhost:8880/v1", TTS_MODEL: "kokoro", TTS_VOICE: "af_sky" },
    });
    expect(called).toBe(1); // バンドルはミス → HTTP を叩いた
    expect(Array.from(r.audio)).toEqual([2, 2]);
  });

  test("カスタムエンドポイントでも HTTP 失敗時は say にフォールバックする", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const spawned: string[][] = [];
    const r = await synthesize("Hello", {
      cacheDir, fetchFn: fakeFetch, spawnFn: makeFakeSpawn(spawned),
      env: { TTS_BASE_URL: "http://localhost:8880/v1" },
    });
    expect(r.engine).toBe("say");
    expect(Array.from(r.audio)).toEqual([9, 9]);
  });
});
```

- [ ] **Step 3: テストが落ちることを確認**

Run: `cd app && bun test __tests__/tts.test.ts`
Expected: FAIL（`resolveTtsConfig` / `DEFAULT_TTS_*` が未定義、`env`/`baseUrl`/`model` opts 未対応）

- [ ] **Step 4: `tts.ts` を全面差し替えで実装する**

`app/server/tts.ts` を次で置き換える:

```ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { BUNDLED_AUDIO_DIR, TTS_CACHE_DIR } from "./paths";
import { realSpawn, type SpawnFn } from "./spawn";

/** 既定の OpenAI 互換エンドポイント。未設定時はここに向く（＝現行と完全同一）。 */
export const DEFAULT_TTS_BASE_URL = "https://api.openai.com/v1";
/** 既定モデル。同梱バンドルの cacheKey もこの値で生成済み（凍結・変更不可）。 */
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
/** 既定 voice。同梱バンドルの cacheKey もこの値で生成済み。 */
export const DEFAULT_TTS_VOICE = "alloy";

/** DB / UI が保持する上書き設定（各値 null = env / 既定に従う）。APIキーは持たない（.env のみ）。 */
export type TtsSettings = {
  baseUrl: string | null;
  model: string | null;
  voice: string | null;
};

/** 解決済みの実効設定（synthesize が実際に使う値）。 */
export type ResolvedTtsConfig = {
  baseUrl: string;
  model: string;
  voice: string;
  apiKey?: string;
};

export type SynthesizeOpts = {
  voice?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  cacheDir?: string;
  /** リポジトリ同梱の読み取り専用音声（APIキーなしでも参照される） */
  bundledDir?: string;
  fetchFn?: typeof fetch;
  spawnFn?: SpawnFn;
  /** 設定解決に使う env（省略時 Bun.env）。テスト・バンドル生成で注入する。 */
  env?: Record<string, string | undefined>;
};

export function cacheKeyFor(model: string, voice: string, text: string): string {
  return createHash("sha256").update(`${model}|${voice}|${text}`).digest("hex");
}

/**
 * 実効 TTS 設定を解決する。優先順位: opts（リクエスト/DB 由来）> env（TTS_*）> 既定。
 * APIキーは TTS_API_KEY を優先し、無ければ OPENAI_API_KEY にフォールバック（現行の鍵解決を保持）。
 * baseUrl/model/voice が未設定（空文字含む）なら DEFAULT_* に解決し、既定挙動を bit-identical に保つ。
 */
export function resolveTtsConfig(
  opts: SynthesizeOpts = {},
  env: Record<string, string | undefined> = Bun.env,
): ResolvedTtsConfig {
  const pick = (o: string | undefined, e: string | undefined, d: string): string => {
    const ov = o?.trim();
    if (ov) return ov;
    const ev = e?.trim();
    if (ev) return ev;
    return d;
  };
  const rawKey = opts.apiKey ?? env.TTS_API_KEY ?? env.OPENAI_API_KEY;
  return {
    baseUrl: pick(opts.baseUrl, env.TTS_BASE_URL, DEFAULT_TTS_BASE_URL),
    model: pick(opts.model, env.TTS_MODEL, DEFAULT_TTS_MODEL),
    voice: pick(opts.voice, env.TTS_VOICE, DEFAULT_TTS_VOICE),
    apiKey: rawKey?.trim() ? rawKey : undefined,
  };
}

async function synthesizeHttp(
  text: string, cfg: ResolvedTtsConfig, fetchFn: typeof fetch,
): Promise<Uint8Array> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/audio/speech`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // APIキーがあるときだけ Authorization を載せる（kokoro-fastapi 等のローカルは鍵不要）。
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  const res = await fetchFn(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: text, response_format: "mp3" }),
  });
  if (!res.ok) throw new Error(`TTS HTTP failed: ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function synthesizeSay(text: string, spawn: SpawnFn): Promise<Uint8Array> {
  const work = mkdtempSync(path.join(tmpdir(), "say-"));
  try {
    const aiff = path.join(work, "out.aiff");
    const mp3 = path.join(work, "out.mp3");
    const textFile = path.join(work, "text.txt");
    // text は argv に直接渡さない（"-" 始まりの文字列が say のフラグとして
    // 解釈される argv injection を防ぐため、ファイル経由で渡す）
    await Bun.write(textFile, text);
    const s = await spawn(["say", "-v", "Samantha", "-o", aiff, "-f", textFile]);
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
  const cfg = resolveTtsConfig(opts, opts.env ?? Bun.env);
  const cacheDir = opts.cacheDir ?? TTS_CACHE_DIR;
  const key = cacheKeyFor(cfg.model, cfg.voice, text);

  // 同梱音声（暗記例文300など）は最優先で参照する。既定 model/voice のときだけキーが一致してヒットし、
  // 非既定（ローカルTTS等）では別キーになり自然にミスして下の HTTP 層へ進む（＝アプリ全体で声を統一する）。
  // OpenAI TTS で事前生成したものなので engine は "openai" として返す
  const bundledPath = path.join(opts.bundledDir ?? BUNDLED_AUDIO_DIR, `${key}.mp3`);
  try {
    if (existsSync(bundledPath)) {
      return { audio: new Uint8Array(await Bun.file(bundledPath).arrayBuffer()), mime: "audio/mpeg", engine: "openai" };
    }
  } catch (err) {
    // バンドル読み取り失敗はベストエフォート（通常経路に続行）
    console.warn(`tts: bundled audio read failed for ${bundledPath}: ${String(err)}`);
  }

  // HTTP TTS を試す条件: APIキーがある（OpenAI 想定）か、baseUrl が既定以外に向いている
  // （ローカル/自ホストの OpenAI 互換で鍵不要のケース）。既定 baseUrl + 鍵なしのときだけ HTTP を飛ばして say。
  const isCustomEndpoint = cfg.baseUrl !== DEFAULT_TTS_BASE_URL;
  const shouldTryHttp = Boolean(cfg.apiKey) || isCustomEndpoint;

  if (shouldTryHttp) {
    const cachePath = path.join(cacheDir, `${key}.mp3`);
    try {
      mkdirSync(cacheDir, { recursive: true });
      if (existsSync(cachePath)) {
        return { audio: new Uint8Array(await Bun.file(cachePath).arrayBuffer()), mime: "audio/mpeg", engine: "openai" };
      }
    } catch (err) {
      // キャッシュ用ディレクトリの準備失敗もベストエフォート扱い（合成自体は継続）
      console.warn(`tts: cache dir prep failed for ${cacheDir}: ${String(err)}`);
    }
    try {
      const audio = await synthesizeHttp(text, cfg, opts.fetchFn ?? fetch);
      try {
        await Bun.write(cachePath, audio);
      } catch (err) {
        // キャッシュ書き込みの失敗はセッションを落とさない（ベストエフォート）
        console.warn(`tts: cache write failed for ${cachePath}: ${String(err)}`);
      }
      return { audio, mime: "audio/mpeg", engine: "openai" };
    } catch (err) {
      // spec §4.5: TTS API 障害 → macOS say にフォールバックしてセッション継続
      console.warn(`tts: HTTP synthesis failed, falling back to say: ${String(err)}`);
    }
  }

  const audio = await synthesizeSay(text, opts.spawnFn ?? realSpawn);
  return { audio, mime: "audio/mpeg", engine: "say" };
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd app && bun test __tests__/tts.test.ts`
Expected: PASS（既存テスト + 新 describe すべて緑）

- [ ] **Step 6: 同梱バンドル生成を既定（OpenAI）にピン留めする**

`scripts/generate-sentence-audio.ts` の import 行に定数を足す（`import { synthesize } from "../app/server/tts";` を差し替え）:

```ts
import { synthesize, DEFAULT_TTS_BASE_URL, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from "../app/server/tts";
```

`generateOne` 内の `synthesize` 呼び出しを差し替える（`app/.env` に `TTS_*` が設定されていてもバンドルのキーが既定からずれないよう固定する）:

```ts
      // 同梱バンドルは常に既定（OpenAI）で生成する。TTS_* env に引きずられるとキーがずれて
      // アプリ既定のバンドルルックアップがミスするため、baseUrl/model/voice を既定に固定し env を無視する。
      const result = await synthesize(s.en, {
        cacheDir: BUNDLED_AUDIO_DIR,
        baseUrl: DEFAULT_TTS_BASE_URL,
        model: DEFAULT_TTS_MODEL,
        voice: DEFAULT_TTS_VOICE,
        apiKey: Bun.env.OPENAI_API_KEY,
        env: {},
      });
```

- [ ] **Step 7: 型チェック**

Run: `cd app && bun run typecheck`
Expected: エラーなし

- [ ] **Step 8: コミット**

```bash
git add app/server/tts.ts app/server/__tests__/tts.test.ts scripts/generate-sentence-audio.ts
git commit -m "feat: TTSの合成先を設定可能に（Base URL/モデル/voice・鍵なしローカル対応）"
```

---

### Task 2: サーバ — `tts_settings` ストアと openDb 配線

**Files:**
- Create: `app/server/tts-settings-store.ts`
- Modify: `app/server/db.ts`（import 追加・`openDb` に ensure 追加）
- Test: Create `app/server/__tests__/tts-settings-store.test.ts`, Modify `app/server/__tests__/db.test.ts`（テーブル存在アサーション追加）

**Interfaces:**
- Consumes: `TtsSettings`（Task 1）
- Produces: `ensureTtsSettingsSchema` / `TtsSettingsStore` / `makeTtsSettingsStore`

- [ ] **Step 1: 失敗するテストを書く（ストア）**

Create `app/server/__tests__/tts-settings-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureTtsSettingsSchema, makeTtsSettingsStore } from "../tts-settings-store";

function freshStore() {
  const db = new Database(":memory:");
  ensureTtsSettingsSchema(db);
  return makeTtsSettingsStore(db);
}

describe("tts-settings-store", () => {
  test("get: 未設定なら null（＝env/既定に従う）", () => {
    expect(freshStore().get()).toBeNull();
  });

  test("save→get: 保存した値をそのまま返す（単一行 upsert）", () => {
    const store = freshStore();
    const saved = store.save({ baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky" });
    expect(saved).toEqual({ baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky" });
    expect(store.get()).toEqual({ baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky" });
  });

  test("save: 2回目は同じ行を上書きする（id=1 単一行・null で既定へ戻せる）", () => {
    const store = freshStore();
    store.save({ baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky" });
    store.save({ baseUrl: null, model: null, voice: null });
    expect(store.get()).toEqual({ baseUrl: null, model: null, voice: null });
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `cd app && bun test __tests__/tts-settings-store.test.ts`
Expected: FAIL（モジュール未作成）

- [ ] **Step 3: ストアを実装する**

Create `app/server/tts-settings-store.ts`:

```ts
import type { Database } from "bun:sqlite";
import type { TtsSettings } from "./tts";

/** TTS プロバイダ設定の永続化（単一行 id=1）。llm_settings と同型。APIキーは持たない（.env のみ）。 */
export function ensureTtsSettingsSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS tts_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    base_url TEXT,
    model TEXT,
    voice TEXT,
    updated_at TEXT NOT NULL
  )`);
}

export type TtsSettingsStore = {
  /** 保存済み設定。行が無ければ null（＝env/既定に従う）。 */
  get(): TtsSettings | null;
  /** 単一行(id=1)を upsert し、保存した設定をそのまま返す。妥当性は route が保証する。 */
  save(s: TtsSettings): TtsSettings;
};

type Row = { base_url: string | null; model: string | null; voice: string | null };

export function makeTtsSettingsStore(db: Database): TtsSettingsStore {
  return {
    get() {
      const row = db
        .query<Row, []>("SELECT base_url, model, voice FROM tts_settings WHERE id = 1")
        .get();
      if (!row) return null;
      return { baseUrl: row.base_url, model: row.model, voice: row.voice };
    },
    save(s) {
      db.run(
        `INSERT INTO tts_settings (id, base_url, model, voice, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           base_url = excluded.base_url,
           model = excluded.model,
           voice = excluded.voice,
           updated_at = excluded.updated_at`,
        [s.baseUrl, s.model, s.voice, new Date().toISOString()],
      );
      return s;
    },
  };
}
```

- [ ] **Step 4: ストアテストが通ることを確認**

Run: `cd app && bun test __tests__/tts-settings-store.test.ts`
Expected: PASS

- [ ] **Step 5: openDb に配線する（失敗するアサーションを先に書く）**

`app/server/__tests__/db.test.ts` に、`openDb(":memory:")` で `tts_settings` テーブルが作られることを確認する test を追記する（既存の import/describe に合わせて追加。テーブル存在は sqlite_master で確認）:

```ts
test("openDb: tts_settings テーブルを作成する", () => {
  const db = openDb(":memory:");
  const row = db
    .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get("tts_settings");
  expect(row?.name).toBe("tts_settings");
});
```

Run: `cd app && bun test __tests__/db.test.ts`
Expected: FAIL（openDb がまだ ensure を呼ばない）

- [ ] **Step 6: openDb を配線する**

`app/server/db.ts` の import 群（`import { ensureLlmSettingsSchema } from "./llm-settings-store";` の直後）に追加:

```ts
import { ensureTtsSettingsSchema } from "./tts-settings-store";
```

`app/server/db.ts` の `openDb` 内、`ensureLlmSettingsSchema(db);` の直後に追加:

```ts
  ensureTtsSettingsSchema(db);
```

- [ ] **Step 7: db テストが通ることを確認**

Run: `cd app && bun test __tests__/db.test.ts __tests__/tts-settings-store.test.ts`
Expected: PASS

- [ ] **Step 8: 型チェック**

Run: `cd app && bun run typecheck`
Expected: エラーなし

- [ ] **Step 9: コミット**

```bash
git add app/server/tts-settings-store.ts app/server/db.ts app/server/__tests__/tts-settings-store.test.ts app/server/__tests__/db.test.ts
git commit -m "feat: TTS設定ストア（tts_settings 単一行）とopenDb配線"
```

---

### Task 3: サーバ — TTS 設定ルート（GET/PUT）+ handleTts の DB 設定注入

**Files:**
- Create: `app/server/routes/tts-settings.ts`
- Modify: `app/server/routes/system.ts`（`SystemRoutesDeps` に `getTtsSettings` 追加・`handleTts` で DB 設定を渡す）
- Modify: `app/server/__tests__/helpers/route-deps.ts`（`getTtsSettings` / `saveTtsSettings` / `ttsEnv` 既定を追加）
- Test: Create `app/server/__tests__/routes-tts-settings.test.ts`

**Interfaces:**
- Consumes: `TtsSettings` / `DEFAULT_TTS_*`（Task 1）
- Produces: `TtsSettingsRoutesDeps` / `makeTtsSettingsRoutes`, `SystemRoutesDeps.getTtsSettings`

- [ ] **Step 1: フェイク deps に新フィールド既定を足す**

`app/server/__tests__/helpers/route-deps.ts` の `makeTestDeps` 内、`llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),` の直後に追加:

```ts
    getTtsSettings: () => null,
    saveTtsSettings: (_s) => {},
    ttsEnv: () => ({ apiKeyConfigured: false }),
```

- [ ] **Step 2: 失敗するテストを書く（ルート）**

Create `app/server/__tests__/routes-tts-settings.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq, putJson } from "./helpers/http";
import type { TtsSettings } from "../tts";

describe("tts-settings API", () => {
  test("GET: 未設定なら null 値 + 既定 + apiKeyConfigured を返す", async () => {
    const { deps } = makeTestDeps({ getTtsSettings: () => null, ttsEnv: () => ({ apiKeyConfigured: false }) });
    const res = await makeFetchHandler(deps)(getReq("/api/tts-settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      baseUrl: null, model: null, voice: null,
      apiKeyConfigured: false,
      defaults: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", voice: "alloy" },
    });
  });

  test("GET: 保存済み設定を反映する", async () => {
    const { deps } = makeTestDeps({
      getTtsSettings: () => ({ baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky" }),
      ttsEnv: () => ({ apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/tts-settings"));
    const body = await res.json();
    expect(body.baseUrl).toBe("http://localhost:8880/v1");
    expect(body.model).toBe("kokoro");
    expect(body.voice).toBe("af_sky");
    expect(body.apiKeyConfigured).toBe(true);
  });

  test("PUT: 正常値を保存し、保存後のビューを返す", async () => {
    const saved: TtsSettings[] = [];
    let current: TtsSettings | null = null;
    const { deps } = makeTestDeps({
      getTtsSettings: () => current,
      saveTtsSettings: (s) => { saved.push(s); current = s; },
      ttsEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/tts-settings", {
      baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky",
    }));
    expect(res.status).toBe(200);
    expect(saved).toEqual([{ baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky" }]);
    expect((await res.json()).baseUrl).toBe("http://localhost:8880/v1");
  });

  test("PUT: 空文字/未指定は null（既定へ戻す）として保存する", async () => {
    const saved: TtsSettings[] = [];
    const { deps } = makeTestDeps({ saveTtsSettings: (s) => saved.push(s), getTtsSettings: () => null });
    const res = await makeFetchHandler(deps)(putJson("/api/tts-settings", { baseUrl: "", model: "", voice: "" }));
    expect(res.status).toBe(200);
    expect(saved).toEqual([{ baseUrl: null, model: null, voice: null }]);
  });

  test("PUT 400: baseUrl が http(s) でない・保存しない", async () => {
    const saved: TtsSettings[] = [];
    const { deps } = makeTestDeps({ saveTtsSettings: (s) => saved.push(s), getTtsSettings: () => null });
    const h = makeFetchHandler(deps);
    expect((await h(putJson("/api/tts-settings", { baseUrl: "not-a-url" }))).status).toBe(400);
    expect((await h(putJson("/api/tts-settings", { baseUrl: "ftp://x/y" }))).status).toBe(400);
    expect(saved).toHaveLength(0);
  });
});
```

- [ ] **Step 3: テストが落ちることを確認**

Run: `cd app && bun test __tests__/routes-tts-settings.test.ts`
Expected: FAIL（`/api/tts-settings` が 404・deps 未配線）

- [ ] **Step 4: ルートを実装する**

Create `app/server/routes/tts-settings.ts`:

```ts
import { json, parseJsonBody, exact, type RouteEntry } from "./http";
import { DEFAULT_TTS_BASE_URL, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, type TtsSettings } from "../tts";

export type TtsSettingsRoutesDeps = {
  getTtsSettings: () => TtsSettings | null;
  saveTtsSettings: (s: TtsSettings) => void;
  /** env 由来。APIキー値は返さず有無のみ。 */
  ttsEnv: () => { apiKeyConfigured: boolean };
};

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** undefined/null/空文字 → null（未指定=既定へ）、trim後1文字以上でmax以下の文字列 → trim値、それ以外 → undefined（不正） */
function asOptionalStr(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** GET/PUT 共通ビュー。APIキー値は決して含めない（有無の boolean のみ）。 */
function viewOf(deps: TtsSettingsRoutesDeps) {
  const s = deps.getTtsSettings();
  return {
    baseUrl: s?.baseUrl ?? null,
    model: s?.model ?? null,
    voice: s?.voice ?? null,
    apiKeyConfigured: deps.ttsEnv().apiKeyConfigured,
    defaults: { baseUrl: DEFAULT_TTS_BASE_URL, model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE },
  };
}

type Body = { baseUrl?: unknown; model?: unknown; voice?: unknown };

async function handlePut(req: Request, deps: TtsSettingsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<Body>(req);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  const baseUrl = asOptionalStr(b.baseUrl, 500);
  if (baseUrl === undefined) return json({ error: "baseUrl must be a string of at most 500 characters" }, 400);
  if (baseUrl !== null && !isHttpUrl(baseUrl)) return json({ error: "baseUrl must be a valid http(s) URL" }, 400);

  const model = asOptionalStr(b.model, 200);
  if (model === undefined) return json({ error: "model must be a string of at most 200 characters" }, 400);

  const voice = asOptionalStr(b.voice, 100);
  if (voice === undefined) return json({ error: "voice must be a string of at most 100 characters" }, 400);

  deps.saveTtsSettings({ baseUrl, model, voice });
  return json(viewOf(deps));
}

export function makeTtsSettingsRoutes(deps: TtsSettingsRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/tts-settings", () => json(viewOf(deps))),
    exact("PUT", "/api/tts-settings", (req) => handlePut(req, deps)),
  ];
}
```

- [ ] **Step 5: `system.ts` の `handleTts` で DB 設定を `synthesize` に渡す**

`app/server/routes/system.ts` の import 行に `TtsSettings` 型を足す（`import { synthesize } from "../tts";` を差し替え）:

```ts
import { synthesize } from "../tts";
import type { TtsSettings } from "../tts";
```

`SystemRoutesDeps` に `getTtsSettings` を追加（`synthesize: typeof synthesize;` の直後）:

```ts
  /** TTS の実効設定（DB 由来）。合成のたびに読む。省略時は現行既定（env/OpenAI/say）。 */
  getTtsSettings: () => TtsSettings | null;
```

`handleTts` 内の `synthesize` 呼び出しを差し替える（`const { audio, mime, engine } = await deps.synthesize(body.text, { voice: body.voice });` を差し替え）:

```ts
  const tts = deps.getTtsSettings();
  const { audio, mime, engine } = await deps.synthesize(body.text, {
    voice: body.voice ?? tts?.voice ?? undefined,
    model: tts?.model ?? undefined,
    baseUrl: tts?.baseUrl ?? undefined,
  });
```

- [ ] **Step 6: テストが通ることを確認**

Run: `cd app && bun test __tests__/routes-tts-settings.test.ts __tests__/routes-system.test.ts`
Expected: PASS（既存の `/api/tts` テストは `getTtsSettings: () => null` 既定で現行どおり）

- [ ] **Step 7: 型チェック**

Run: `cd app && bun run typecheck`
Expected: エラーなし（`routes.ts` の `RouteDeps` に `TtsSettingsRoutesDeps` を足すのは Task 4。ここでは `makeTtsSettingsRoutes` は未配線だが export のみで型エラーにはならない）

- [ ] **Step 8: コミット**

```bash
git add app/server/routes/tts-settings.ts app/server/routes/system.ts app/server/__tests__/helpers/route-deps.ts app/server/__tests__/routes-tts-settings.test.ts
git commit -m "feat: TTS設定API（GET/PUT /api/tts-settings）とhandleTtsへのDB設定注入"
```

---

### Task 4: サーバ — routes.ts 合成 + index.ts 配線

**Files:**
- Modify: `app/server/routes.ts`（import・`RouteDeps` 交差・`makeFetchHandler` 配列）
- Modify: `app/server/index.ts`（ストア生成・deps 配線）

**Interfaces:**
- Consumes: Task 2（`makeTtsSettingsStore`）, Task 3（`makeTtsSettingsRoutes` / `TtsSettingsRoutesDeps`）
- Produces: なし（合成ルート = typecheck + 既存テストで担保）

- [ ] **Step 1: routes.ts に配線する**

`app/server/routes.ts` の import 群（`import { makeLlmSettingsRoutes, type LlmSettingsRoutesDeps } from "./routes/llm-settings";` の直後）に追加:

```ts
import { makeTtsSettingsRoutes, type TtsSettingsRoutesDeps } from "./routes/tts-settings";
```

`RouteDeps` 交差の末尾 `& LlmSettingsRoutesDeps;` を差し替え:

```ts
  AssessmentRoutesDeps & ListeningRoutesDeps & FeedbackRoutesDeps & LlmSettingsRoutesDeps &
  TtsSettingsRoutesDeps;
```

`makeFetchHandler` 内 `...makeLlmSettingsRoutes(deps),` の直後に追加:

```ts
    ...makeTtsSettingsRoutes(deps),
```

- [ ] **Step 2: index.ts に配線する**

`app/server/index.ts` の import 群（`import { makeLlmSettingsStore } from "./llm-settings-store";` の直後）に追加:

```ts
import { makeTtsSettingsStore } from "./tts-settings-store";
```

`const llmSettingsStore = makeLlmSettingsStore(db);` の直後に追加:

```ts
const ttsSettingsStore = makeTtsSettingsStore(db);
```

`realDeps` 内、`llmEnv: () => ({ … }),` ブロックの直後（`};` の直前）に追加:

```ts
  getTtsSettings: () => ttsSettingsStore.get(),
  saveTtsSettings: (s) => ttsSettingsStore.save(s),
  // env 由来。TTS の APIキーは有無のみ開示（TTS_API_KEY 優先・無ければ OPENAI_API_KEY）。値は絶対に返さない。
  ttsEnv: () => ({ apiKeyConfigured: Boolean((Bun.env.TTS_API_KEY ?? Bun.env.OPENAI_API_KEY)?.trim()) }),
```

- [ ] **Step 3: 全ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: すべて成功（`RouteDeps` に TTS 3フィールドが加わり、フェイク deps は Task 3 で既定済み）

- [ ] **Step 4: コミット**

```bash
git add app/server/routes.ts app/server/index.ts
git commit -m "feat: TTS設定ルートとストアをサーバ本体に配線"
```

---

### Task 5: クライアント — TTS 設定 API（`api/tts-settings.ts`）

**Files:**
- Create: `app/client/src/api/tts-settings.ts`
- Modify: `app/client/src/api/index.ts`（バレル export 追加）

**Interfaces:**
- Produces: `TtsSettingsView` / `TtsSettingsInput` / `fetchTtsSettings` / `saveTtsSettings`

- [ ] **Step 1: API クライアントを実装する**

Create `app/client/src/api/tts-settings.ts`:

```ts
import { extractErrorMessage } from "./http";

/** GET/PUT 応答。APIキー値は含まれない（有無のみ apiKeyConfigured）。 */
export type TtsSettingsView = {
  baseUrl: string | null;
  model: string | null;
  voice: string | null;
  apiKeyConfigured: boolean;
  defaults: { baseUrl: string; model: string; voice: string };
};

export type TtsSettingsInput = {
  baseUrl?: string | null;
  model?: string | null;
  voice?: string | null;
};

export async function fetchTtsSettings(): Promise<TtsSettingsView> {
  const res = await fetch("/api/tts-settings");
  if (!res.ok) throw new Error(`tts-settings failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function saveTtsSettings(input: TtsSettingsInput): Promise<TtsSettingsView> {
  const res = await fetch("/api/tts-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`tts-settings save failed: ${await extractErrorMessage(res)}`);
  return res.json();
}
```

- [ ] **Step 2: バレルに追加する**

`app/client/src/api/index.ts` の `export * from "./llm-settings";` の直後に追加:

```ts
export * from "./tts-settings";
```

- [ ] **Step 3: ビルド（型チェック）**

Run: `cd app/client && bun run build`
Expected: 成功

- [ ] **Step 4: コミット**

```bash
git add app/client/src/api/tts-settings.ts app/client/src/api/index.ts
git commit -m "feat: TTS設定APIクライアント（fetch/saveTtsSettings）"
```

---

### Task 6: クライアント — i18n（`settings` に TTS ブロック追記）

**Files:**
- Modify: `app/client/src/i18n.ts`

**Interfaces:**
- Consumes: v0.18.0 Task 7 の `SettingsStrings`（`settings` ブロック）が存在する前提
- Produces: `settings.ttsSection` 他の TTS キー（EN/JA）

> **実装前の確認**: v0.18.0（`2026-07-08-llm-roles-settings.md` Task 7）で `SettingsStrings` 型と `STR.en.settings` / `STR.ja.settings` が追加済みのはず。実形を開いて `displaySection` の位置を確認してからアンカーを合わせる。

- [ ] **Step 1: 型に TTS キーを追加する**

`app/client/src/i18n.ts` の `SettingsStrings` 型定義内、`displaySection: string;` の直後に追加:

```ts
    ttsSection: string;
    ttsDesc: string;
    ttsBaseUrlLabel: string; ttsBaseUrlPlaceholder: string;
    ttsModelLabel: string; ttsModelPlaceholder: string;
    ttsVoiceLabel: string; ttsVoicePlaceholder: string;
    ttsReset: string;
    ttsResetDesc: string;
    ttsApiKeyConfigured: string; ttsApiKeyOptional: string;
```

- [ ] **Step 2: EN 文言を追加する**

`STR.en.settings` ブロック内、`displaySection: "Display",` の直後に追加:

```ts
      ttsSection: "Voice (TTS)",
      ttsDesc: "Point speech synthesis at an OpenAI-compatible endpoint. Leave blank to use the default (OpenAI when a key is set, otherwise macOS say). A local server such as kokoro-fastapi needs no API key.",
      ttsBaseUrlLabel: "Base URL",
      ttsBaseUrlPlaceholder: "https://api.openai.com/v1",
      ttsModelLabel: "Model",
      ttsModelPlaceholder: "gpt-4o-mini-tts",
      ttsVoiceLabel: "Voice",
      ttsVoicePlaceholder: "alloy",
      ttsReset: "Reset to default",
      ttsResetDesc: "Clear the overrides and fall back to the environment / default endpoint.",
      ttsApiKeyConfigured: "TTS API key detected (app/.env).",
      ttsApiKeyOptional: "No TTS API key — fine for a local endpoint; OpenAI needs one.",
```

- [ ] **Step 3: JA 文言を追加する**

`STR.ja.settings` ブロック内、`displaySection: "表示",` の直後に追加:

```ts
      ttsSection: "音声（TTS）",
      ttsDesc: "音声合成の向き先を OpenAI 互換エンドポイントに変更できます。空欄なら既定（キー設定時は OpenAI・無ければ macOS say）。kokoro-fastapi 等のローカルサーバは API キー不要です。",
      ttsBaseUrlLabel: "ベース URL",
      ttsBaseUrlPlaceholder: "https://api.openai.com/v1",
      ttsModelLabel: "モデル",
      ttsModelPlaceholder: "gpt-4o-mini-tts",
      ttsVoiceLabel: "voice",
      ttsVoicePlaceholder: "alloy",
      ttsReset: "既定に戻す",
      ttsResetDesc: "上書きを消して、環境変数／既定エンドポイントに戻します。",
      ttsApiKeyConfigured: "TTS API キーを検出（app/.env）。",
      ttsApiKeyOptional: "TTS API キーなし — ローカルなら問題なし・OpenAI には必要。",
```

- [ ] **Step 4: ビルド（型チェック）**

Run: `cd app/client && bun run build`
Expected: 成功（`SettingsStrings` の EN/JA が両方満たされる）

- [ ] **Step 5: コミット**

```bash
git add app/client/src/i18n.ts
git commit -m "feat: 設定画面の音声（TTS）i18n（EN/JA）"
```

---

### Task 7: クライアント — `SettingsScreen` に音声（TTS）セクションを追加

**Files:**
- Modify: `app/client/src/screens/SettingsScreen.tsx`

**Interfaces:**
- Consumes: Task 5（`fetchTtsSettings` / `saveTtsSettings` / `TtsSettingsView`）, Task 6（`settings.tts*`）
- Produces: なし（build で担保）

> **実装前の確認**: v0.18.0 Task 8 の `SettingsScreen` を開き、`import { … } from "../api";` 行・`saving`/`result` state・`s.llm.save`/`s.llm.saving`/`s.llm.saveFailed`/`s.llm.applied` の存在・言語モデル `</section>` と表示 `<section>` の境界を確認する。以下のアンカーはその実形に合わせる。

- [ ] **Step 1: import に TTS API を足す**

`SettingsScreen.tsx` の `from "../api"` の import に `fetchTtsSettings, saveTtsSettings` と `type TtsSettingsView` を追加する。差し替え後（v0.18.0 の import 集合 + TTS）:

```tsx
import {
  fetchLlmSettings, saveLlmSettings, saveLlmRoleSettings, LLM_ROLES,
  fetchTtsSettings, saveTtsSettings,
  type LlmProvider, type LlmRole, type LlmRoleProvider, type LlmRoleView, type LlmSettingsView,
  type TtsSettingsView,
} from "../api";
```

- [ ] **Step 2: TTS の編集状態と読み込みを足す**

`SettingsScreen` 関数本体の LLM 用 state 群（`const [roles, setRoles] = useState<…>({ … });` の直後）に追加:

```tsx
  // 音声（TTS）の編集状態
  const [ttsView, setTtsView] = useState<TtsSettingsView | null>(null);
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");
```

`hydrate` 関数（LLM 用）の**直後**に TTS 用の hydrate を追加:

```tsx
  function hydrateTts(v: TtsSettingsView) {
    setTtsView(v);
    setTtsBaseUrl(v.baseUrl ?? "");
    setTtsModel(v.model ?? "");
    setTtsVoice(v.voice ?? "");
  }
```

既存の `useEffect`（`fetchLlmSettings().then(hydrate)…`）の中、その行の直後に追加:

```tsx
    fetchTtsSettings().then(hydrateTts).catch(() => {});
```

- [ ] **Step 3: 保存・リセットのハンドラを足す**

`onResetAll`（LLM 用）の直後に追加:

```tsx
  async function onSaveTts() {
    setSaving(true); setResult(null);
    try {
      hydrateTts(await saveTtsSettings({
        baseUrl: ttsBaseUrl.trim() || null,
        model: ttsModel.trim() || null,
        voice: ttsVoice.trim() || null,
      }));
      setResult(s.llm.applied);
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  async function onResetTts() {
    setSaving(true); setResult(null);
    try {
      hydrateTts(await saveTtsSettings({ baseUrl: null, model: null, voice: null }));
      setResult(s.llm.applied);
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }
```

- [ ] **Step 4: 音声（TTS）セクションを描画する**

言語モデルの `</section>`（LLM セクションの閉じタグ）の**直後**、表示 `<section className="support-panel stack">` の**直前**に追加:

```tsx
      {/* 音声（TTS） */}
      <section className="support-panel stack">
        <div className="stat-title">{s.settings.ttsSection}</div>
        <div className="text-sm text-muted">{s.settings.ttsDesc}</div>
        <div className="llm-fields stack">
          <label className="llm-field">
            <span className="text-sm text-muted">{s.settings.ttsBaseUrlLabel}</span>
            <input className="llm-input" value={ttsBaseUrl} placeholder={s.settings.ttsBaseUrlPlaceholder} onChange={(e) => setTtsBaseUrl(e.target.value)} />
          </label>
          <label className="llm-field">
            <span className="text-sm text-muted">{s.settings.ttsModelLabel}</span>
            <input className="llm-input" value={ttsModel} placeholder={s.settings.ttsModelPlaceholder} onChange={(e) => setTtsModel(e.target.value)} />
          </label>
          <label className="llm-field">
            <span className="text-sm text-muted">{s.settings.ttsVoiceLabel}</span>
            <input className="llm-input" value={ttsVoice} placeholder={s.settings.ttsVoicePlaceholder} onChange={(e) => setTtsVoice(e.target.value)} />
          </label>
          <div className="text-sm text-muted">{ttsView?.apiKeyConfigured ? s.settings.ttsApiKeyConfigured : s.settings.ttsApiKeyOptional}</div>
        </div>
        <Button variant="secondary" onClick={onSaveTts} disabled={saving}>{saving ? s.llm.saving : s.llm.save}</Button>
        <div className="text-sm text-muted">{s.settings.ttsResetDesc}</div>
        <Button variant="secondary" onClick={onResetTts} disabled={saving}>{s.settings.ttsReset}</Button>
      </section>
```

- [ ] **Step 5: ビルド（型チェック）**

Run: `cd app/client && bun run build`
Expected: 成功

補足: `llm-fields` / `llm-field` / `llm-input` / `support-panel` / `stat-title` / `text-sm` / `text-muted` は v0.18.0 の `SettingsScreen` が使う既存クラス。`result` 表示（`{result && …}`）は言語モデルセクション内に既にあるため、TTS の保存結果もそこに出る。

- [ ] **Step 6: コミット**

```bash
git add app/client/src/screens/SettingsScreen.tsx
git commit -m "feat: 設定画面に音声（TTS）セクション（Base URL/モデル/voice/既定に戻す）"
```

---

### Task 8: ドキュメント（CHANGELOG v0.19.0 + README）

**Files:**
- Modify: `CHANGELOG.md`（先頭に v0.19.0 追記）
- Modify: `README.md`（仕組み図・前提条件・env 表 + kokoro-fastapi セットアップ節）

**Interfaces:** なし（AGENTS.md のドキュメントゲート）

> **前提**: v0.18.0 がマージ済みのため CHANGELOG 先頭は `## [0.18.0] - 2026-07-08`。その**直前**に v0.19.0 を挿入する。

- [ ] **Step 1: CHANGELOG に v0.19.0 を追記する**

`CHANGELOG.md` の `# Changelog` 説明段落の直後、`## [0.18.0] - 2026-07-08` の直前に挿入:

```markdown
## [0.19.0] - 2026-07-08

### Added

- **ローカル TTS 対応（音声エンドポイントの差し替え）**: 音声合成の向き先を OpenAI 互換の任意エンドポイントに変更できるように。「⚙️ 設定 → 音声（TTS）」で **Base URL・モデル・voice** を指定でき、kokoro-fastapi 等のローカル TTS サーバに **API キーなし**で向けられる（Base URL が既定以外を指すときは鍵なしでも HTTP を試す）。設定は SQLite の新テーブル `tts_settings`（単一行）に保存し、次のリクエストから即反映。`app/.env` の `TTS_BASE_URL` / `TTS_MODEL` / `TTS_VOICE` / `TTS_API_KEY` でも指定できる（DB がこれらを上書き）。**何も設定しなければ現行と完全に同一**（同梱の暗記例文300音声を最優先、OpenAI キーがあれば OpenAI TTS、無ければ macOS `say`）。**APIキーは UI・DB・API 応答・ログに一切載せず `app/.env` の `TTS_API_KEY`（無指定時は `OPENAI_API_KEY`）のみ**

### Changed

- 音声合成が失敗したときの `say` フォールバックは維持（現行不変）。カスタムエンドポイントでも同様にフォールバックする
```

- [ ] **Step 2: README 仕組み図・プライバシー節を更新する**

`README.md:67` の図の行を差し替える:

```markdown
ブラウザ録音 → whisper.cpp（ローカルSTT） → Claude（会話相手・コーチ） → OpenAI 互換 TTS（既定は OpenAI・ローカル TTS に差し替え可／なければ macOS say）
```

`README.md:70`（プライバシーの箇条書き「音声はマシンから出ません…」）を差し替える:

```markdown
- **音声はマシンから出ません**。外部に送られるのは発話のテキスト（Claude へ）と AI 応答のテキスト（TTS 用・OpenAI 利用時のみ外部送信。TTS を**ローカルサーバ**に向ければ音声テキストも外部に出ません）だけ
```

- [ ] **Step 3: README 前提条件・env に TTS を追記する**

`README.md:83`（前提条件の「任意: OpenAI API キー…」）を差し替える:

```markdown
- 任意: 高品質TTS。OpenAI API キー（`OPENAI_API_KEY`）を使うか、ローカル TTS（kokoro-fastapi 等・後述）に向ける。どちらも無ければ macOS `say` で動作
```

`README.md:95` の env サンプル（`OPENAI_API_KEY=$YOUR_OPENAI_KEY_ENV_VAR`）の直後に追記:

```markdown

TTS を OpenAI 以外（ローカル等）に向けるときは `app/.env` に次を追加できます（すべて任意・未設定なら既定の OpenAI/say）:

```
TTS_BASE_URL=http://localhost:8880/v1   # OpenAI 互換の音声エンドポイント
TTS_MODEL=kokoro                        # サーバが受け付けるモデル名
TTS_VOICE=af_sky                        # サーバが受け付ける voice
# TTS_API_KEY=...                       # 鍵が要るエンドポイントのみ（未指定なら OPENAI_API_KEY にフォールバック）
```

同じ項目は「⚙️ 設定 → 音声（TTS）」からも変更でき、DB 設定が env を上書きします。
```

- [ ] **Step 4: README に「音声（TTS）プロバイダの切替」節を追加する**

`README.md` の LLM プロバイダ節の末尾（「ローカル LLM のおすすめ構成」サブ節の後・`## 自分用にカスタマイズする` の直前）に新節を追加:

```markdown
## 音声（TTS）プロバイダの切替

読み上げ音声（AI 応答・例文・モデルトーク）の合成先は OpenAI 互換の `/v1/audio/speech` を叩く。既定は OpenAI（`https://api.openai.com/v1`・`gpt-4o-mini-tts`・`alloy`）で、`OPENAI_API_KEY` があれば OpenAI、無ければ macOS `say` にフォールバックする（現行どおり）。ここを **Base URL・モデル・voice** の3点で差し替えられる。

- 設定場所: サイドバー「記録・測定」の **⚙️ 設定 → 音声（TTS）**、または `app/.env` の `TTS_BASE_URL` / `TTS_MODEL` / `TTS_VOICE` / `TTS_API_KEY`（DB 設定が env を上書き）。
- **APIキーは UI・DB に保存されない**（`app/.env` の `TTS_API_KEY`・無指定なら `OPENAI_API_KEY` のみ）。Base URL が既定以外を指すときは**鍵なしでも**エンドポイントを試す（ローカルサーバ向け）。合成に失敗したら `say` にフォールバックする。
- 暗記例文300の**同梱音声**は既定（OpenAI）のキーで事前生成されているため、TTS を差し替えると同梱にヒットせずローカル TTS の声で都度合成される（アプリ全体で声が揃う）。既定に戻せば同梱音声に戻る。
- キャッシュ（`data/tts-cache`）はモデル名と voice でキー分けされる。**同じモデル名かつ同じ voice のまま Base URL だけ別プロバイダに変える**と旧キャッシュと混ざりうるので、その場合は `data/tts-cache` を消すか voice/モデル名を変える。

### ローカル TTS の例: kokoro-fastapi（Apple Silicon Mac）

[kokoro-fastapi](https://github.com/remsky/Kokoro-FastAPI) は Kokoro-82M を OpenAI 互換 API で提供する軽量サーバ。Docker が最も手軽（**実装時に最新の起動方法を公式 README で確認すること**）:

```bash
# CPU（Docker Desktop for Mac は Linux コンテナに Apple GPU を渡せないため CPU 実行になる）
docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest
# 起動確認: ブラウザで http://localhost:8880/web を開く
```

Apple Silicon の MPS 加速で速くしたい場合は、Docker ではなくリポジトリの手順に沿って `uv` でネイティブ実行する（詳細は公式 README・**実装時に確認**）。Kokoro-82M は小型モデルで、Apple Silicon の CPU でも短文なら概ねリアルタイム（RTF < 1・1文あたり数百 ms〜1〜2 秒程度）。

設定は「⚙️ 設定 → 音声（TTS）」で **Base URL `http://localhost:8880/v1`・モデル `kokoro`・voice `af_sky`**（54種の voice から選択・日英中対応）を保存すれば完了。kokoro-fastapi は鍵不要なので「TTS API キーなし」表示のままで正常。
```

- [ ] **Step 5: ドキュメント差分の目視確認**

Run: `git diff --stat CHANGELOG.md README.md`
Expected: 両ファイルに差分がある

- [ ] **Step 6: 最終ゲート**

Run: `cd app && bun test && bun run typecheck && cd client && bun run build`
Expected: すべて成功

- [ ] **Step 7: コミット**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: v0.19.0（ローカルTTS対応）のCHANGELOG/README"
```

---

## Self-Review

**1. Spec coverage（設計骨子6点との対応）:**
- ① 現行 TTS の実コード確定 → 「現状 TTS マップ」節（3層ルックアップ・OpenAI 呼び出し形状・cacheKeyFor）で明記。✓
- ② API 層の向き先を設定可能・既定完全同一・鍵なしローカル → Task 1（`resolveTtsConfig`・`shouldTryHttp = apiKey || isCustomEndpoint`・`Authorization` は鍵ありのみ）。既定不変を tts.test.ts でロック。✓
- ③ 設定 UI（v0.18.0 SettingsScreen の LLM 下に「音声（TTS）」・Base URL/モデル/voice/既定に戻す・i18n EN/JA）→ Task 6（i18n）+ Task 7（画面差分）。v0.18.0 の実形に合わせるアンカーと確認注記あり。✓
- ④ キャッシュキー整合 → 「主要設計判断 2」＋ Task 1（model を鍵へ反映・式凍結・baseUrl のみ差の混在許容とその回避を README 注記）。✓
- ⑤ セットアップ文書（kokoro-fastapi の Docker・uv(MPS) 両論・Apple Silicon 速度・設定画面での向け方）→ Task 8 Step 4（「実装時に最新確認」注記付き）。✓
- ⑥ 規約（既定不変テストロック・secrets 衛生・makeXRoutes/ensureSchema の tts_settings 単一行・TDD・CHANGELOG v0.19.0 + README）→ Global Constraints + 各タスク。✓

**2. Placeholder scan:** 各コード step に完全なコードを記載。「add error handling」等の曖昧表現なし。TODO/TBD なし。✓

**3. Type consistency:**
- `TtsSettings = { baseUrl: string|null; model: string|null; voice: string|null }` を Task 1 で定義 → Task 2 ストア / Task 3 ルート・deps / Task 7 で一貫使用。✓
- `resolveTtsConfig(opts, env)` の戻り `ResolvedTtsConfig`・`synthesize` の戻り `engine: "openai"|"say"` は不変。✓
- `SynthesizeOpts` に足す `model?`/`baseUrl?`/`env?` は Task 3 `handleTts` と Task 1 バンドル script が消費。✓
- `getTtsSettings` は `SystemRoutesDeps`（handleTts 用）と `TtsSettingsRoutesDeps`（GET/PUT 用）の両方に同一シグネチャ `() => TtsSettings | null` で宣言 → 交差型 `RouteDeps` で同一メンバに畳まれ矛盾しない（Task 3/4）。フェイク deps は Task 3 で1回だけ既定を追加。✓
- API クライアント `TtsSettingsView` はサーバ `viewOf` の形（`baseUrl/model/voice/apiKeyConfigured/defaults`）と一致。✓

**残リスク・前提（実装者への申し送り）:**
- v0.18.0 未マージのまま着手する場合、Task 6/7 のアンカー（`SettingsStrings`・`SettingsScreen`・`s.llm.save` 等）が存在しない。**v0.18.0 マージ後**に着手するか、無い場合は SettingsScreen 自体の新設が別途必要になる（本計画のスコープ外）。
- `engine: "openai"` はローカル TTS 経由でも返る（union 凍結の判断）。`x-tts-engine` を UI/監視で厳密に provider 判別に使う要件が将来出たら別途拡張。
- 混在許容（同一 model+voice で baseUrl のみ差）の runtime キャッシュ衝突は README 注記のみで、コードでは防がない（YAGNI・設定画面で voice/model を変えれば自然分離）。
- kokoro-fastapi の Docker イメージ名・uv 手順は 2026-07 時点の調査ベース。README に「実装時に公式 README で最新確認」を明記済み。

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-08-tts-provider.md`.** 実行方式は subagent-driven（タスクごとに fresh subagent + レビュー）を推奨。
