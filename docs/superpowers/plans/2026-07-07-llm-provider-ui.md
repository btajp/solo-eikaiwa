# LLM プロバイダ切替 サイドバー設定UI 実装計画

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM プロバイダ（Claude / OpenAI互換 / Codex / 環境変数に従う）をサイドバーの設定UIから選び、DB に永続化して実行中プロセスへ**再起動なしで**即時適用できるようにする。既定（DB未設定 + env未設定）は現行の Claude と完全に同一の挙動を保つ。

**Architecture:** 既存の `selectRunner` / `makeOpenAICompatRunner` / `makeCodexRunner` をそのまま再利用し、新しいアダプタは作らない。`converse.ts` の `defaultRunner` を「モジュール内 mutable な `currentRunner` に委譲する安定参照のラッパ」に変え、6つの呼び出し側（coach / placement / assessment / converse / content-gen）は無変更のまま runner 差し替えが反映される。DB 設定 → env 形状への写像は `llm-provider.ts` の純関数 `settingsToEnv` が担い、`applyLlmSettings` が `selectRunner` 経由で `currentRunner` を差し替える。永続化は単一行テーブル `llm_settings`（ensureSchema パターン）。**APIキーは DB・API・UI・ログに一切載せない — `app/.env`（`OPENAI_COMPAT_API_KEY`）のみ**。HTTP は `makeXRoutes` 規約で `GET/PUT /api/llm-settings`。UI はサイドバーの `SupportPanel` 直下に小パネルを追加する。

**Tech Stack:** Bun + TypeScript / bun:sqlite（`Database`）/ Claude Agent SDK（既存 `makeClaudeRunner`）/ React 18 + Vite（クライアント）/ named 型 i18n（`app/client/src/i18n.ts`）

## Global Constraints

- **既定不変（回帰基準）**: DB に行が無く env も未設定なら、runner は現行と完全同一（`selectRunner` が `claudeRunner` を同一参照で返す）。`converse.ts` のモジュールロード時の初期化は pure-env のまま（fail-fast 維持）。
- **secrets 衛生**: APIキーを DB・レスポンス JSON・UI・console ログに出さない。APIキーは `app/.env` の `OPENAI_COMPAT_API_KEY` のみ。API はキーの**有無**を `apiKeyConfigured: boolean` でのみ開示する。
- **fail-open な起動時適用**: DB 設定の起動時適用は `try/catch` で握り、失敗時は `console.warn` して env/claude にフォールバックする（UI 由来の不正値で LaunchAgent の crash-loop を絶対に起こさない）。
- **アダプタ非新設**: 既存の `selectRunner` / `makeOpenAICompatRunner` / `makeCodexRunner` を再利用する。プロバイダ実装を新規追加しない。
- **研究トーン**: UI 文言は情報的・中立（目標の押し付け・優劣の断定をしない）。「品質は選んだモデルに依存、既定 Claude が動作確認済みの基準」を ⓘ で一言添える。
- **i18n**: 追加文字列は named 型で EN/JA 両方を定義する。**既存の JA/EN キーは一切変更しない**（`llm` ブロックを additive で追加するのみ）。
- **HTTP additive**: 新規エンドポイント1系統（GET/PUT）と `RouteDeps` フィールド追加のみ。既存フィールド不変。
- **コミット**: Conventional Commits（日本語）。
- **ゲート**: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`

## Interfaces（タスク間契約）

- **Task 1（`app/server/llm-provider.ts`）が Produces:**
  - `export type LlmProvider = "env" | "claude" | "openai-compat" | "codex"`
  - `export type LlmSettings = { provider: LlmProvider; baseUrl: string | null; model: string | null; codexModel: string | null }`
  - `export function settingsToEnv(s: LlmSettings, env?: Record<string, string | undefined>): Record<string, string | undefined>`
- **Task 2（`app/server/converse.ts`）が Consumes:** `settingsToEnv` / `LlmSettings`（Task 1）。**Produces:**
  - `export const defaultRunner: ClaudeRunner`（安定参照ラッパ・型は不変）
  - `export function getCurrentRunner(): ClaudeRunner`
  - `export function applyLlmSettings(settings: LlmSettings, env?: Record<string, string | undefined>): void`
- **Task 3（`app/server/llm-settings-store.ts`）が Consumes:** `LlmSettings`（Task 1）。**Produces:**
  - `export function ensureLlmSettingsSchema(db: Database): void`
  - `export type LlmSettingsStore = { get(): LlmSettings | null; save(s: LlmSettings): LlmSettings }`
  - `export function makeLlmSettingsStore(db: Database): LlmSettingsStore`
- **Task 4（`app/server/routes/llm-settings.ts`）が Consumes:** `LlmSettings` / `LlmProvider`（Task 1）。**Produces:**
  - `export type LlmSettingsRoutesDeps = { getLlmSettings: () => LlmSettings | null; saveLlmSettings: (s: LlmSettings) => void; applyLlmSettings: (s: LlmSettings) => void; llmEnv: () => { provider: string; apiKeyConfigured: boolean } }`
  - `export function makeLlmSettingsRoutes(deps: LlmSettingsRoutesDeps): RouteEntry[]`
  - HTTP: `GET /api/llm-settings` → `{ provider, baseUrl, model, codexModel, apiKeyConfigured, envProvider }` / `PUT /api/llm-settings` body `{ provider, baseUrl?, model?, codexModel? }` → 同形 + `{ applied: boolean, error: string | null }`（検証失敗は 400）
  - `app/server/__tests__/helpers/http.ts` に `export function putJson(path, body): Request` を追加
- **Task 5（`app/server/index.ts`）が Consumes:** Task 2〜4 の全 export。配線 + 起動時 fail-open 適用。
- **Task 6（`app/client/src/api/llm-settings.ts`）が Produces:** `type LlmProvider` / `type LlmSettingsView` / `type LlmSettingsInput` / `fetchLlmSettings()` / `saveLlmSettings(input)`
- **Task 7（`app/client/src/i18n.ts`）が Produces:** `STR[lang].llm` ブロック（EN/JA）
- **Task 8（`app/client/src/App.tsx`）が Consumes:** Task 6・Task 7。`LlmPanel` を `SupportPanel` 直下に描画。
- **Task 9:** README / CHANGELOG（v0.17.0）

---

### Task 1: サーバ — `settingsToEnv`（DB設定 → env 写像）と共有型

**Files:**
- Modify: `app/server/llm-provider.ts`
- Test: `app/server/__tests__/llm-provider.test.ts`（既存に describe を追加）

**Interfaces:**
- Consumes: 既存 `selectRunner`（同ファイル）
- Produces: `LlmProvider` / `LlmSettings` / `settingsToEnv`（上記契約どおり）

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/llm-provider.test.ts` の末尾（`describe("selectRunner", ...)` の後）に追記する。ファイル冒頭の import を次に差し替える:

```ts
import { describe, expect, test } from "bun:test";
import { selectRunner, settingsToEnv } from "../llm-provider";
import type { ClaudeRunner } from "../converse";
import type { LlmSettings } from "../llm-provider";
```

ファイル末尾に追加:

```ts
describe("settingsToEnv", () => {
  const openaiSettings: LlmSettings = {
    provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null,
  };

  test("provider=env: 渡した env をそのまま返す（DB値で上書きしない＝pure-env再現）", () => {
    const env = { LLM_PROVIDER: "codex", FOO: "bar" };
    const out = settingsToEnv({ provider: "env", baseUrl: null, model: null, codexModel: null }, env);
    expect(out).toBe(env);
  });

  test("provider=openai-compat: BASE_URL/MODEL を DB 由来で設定し、APIキーは env 由来のみ保持する", () => {
    const env = { OPENAI_COMPAT_API_KEY: "sk-from-env", OTHER: "x" };
    const out = settingsToEnv(openaiSettings, env);
    expect(out.LLM_PROVIDER).toBe("openai-compat");
    expect(out.OPENAI_COMPAT_BASE_URL).toBe("http://localhost:11434/v1");
    expect(out.OPENAI_COMPAT_MODEL).toBe("llama3");
    // APIキーは settings に存在しない。必ず env（.env）から来る
    expect(out.OPENAI_COMPAT_API_KEY).toBe("sk-from-env");
    expect(out.OTHER).toBe("x");
  });

  test("provider=claude: LLM_PROVIDER=claude を立てる", () => {
    const out = settingsToEnv({ provider: "claude", baseUrl: null, model: null, codexModel: null }, {});
    expect(out.LLM_PROVIDER).toBe("claude");
  });

  test("provider=codex: CODEX_MODEL を DB 由来で設定する", () => {
    const out = settingsToEnv({ provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" }, {});
    expect(out.LLM_PROVIDER).toBe("codex");
    expect(out.CODEX_MODEL).toBe("o4-mini");
  });

  test("settingsToEnv → selectRunner: openai-compat 設定で claudeRunner とは別 runner を返す", () => {
    const sentinel: ClaudeRunner = async () => ({ text: "s", sessionId: "s" });
    const r = selectRunner({
      claudeRunner: sentinel,
      defaultSystemPrompt: "SYS",
      env: settingsToEnv(openaiSettings, {}),
    });
    expect(r).not.toBe(sentinel);
    expect(typeof r).toBe("function");
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd app && bun test llm-provider`
Expected: FAIL（`settingsToEnv` が export されていない → import エラー）

- [ ] **Step 3: 実装する**

`app/server/llm-provider.ts` の `import` 群の直後（`export type SelectRunnerArgs` の前）に、共有型を追加:

```ts
/** サイドバー設定UIで選べる LLM プロバイダ。"env" は「環境変数に従う」リセット用センチネル。 */
export type LlmProvider = "env" | "claude" | "openai-compat" | "codex";

/** DB(llm_settings 単一行)に永続化する LLM 設定。APIキーは含めない（.env のみ）。 */
export type LlmSettings = {
  provider: LlmProvider;
  baseUrl: string | null;
  model: string | null;
  codexModel: string | null;
};
```

同ファイルの末尾（`selectRunner` の後）に写像関数を追加:

```ts
/**
 * DB 由来の LlmSettings を selectRunner が読む env 形状へ写像する純関数。
 * - provider="env" は「環境変数に従う」ので、渡した env をそのまま返す（DB 値で一切上書きしない＝起動時の pure-env 挙動を完全再現）。
 * - それ以外は env を土台に LLM_PROVIDER / OPENAI_COMPAT_BASE_URL / OPENAI_COMPAT_MODEL / CODEX_MODEL を DB 値で上書きする。
 *   OPENAI_COMPAT_API_KEY は上書きせず env（.env）由来のまま — APIキーは DB に持たせない衛生を1箇所で担保する。
 */
export function settingsToEnv(
  s: LlmSettings,
  env: Record<string, string | undefined> = Bun.env,
): Record<string, string | undefined> {
  if (s.provider === "env") return env;
  return {
    ...env,
    LLM_PROVIDER: s.provider,
    OPENAI_COMPAT_BASE_URL: s.baseUrl ?? undefined,
    OPENAI_COMPAT_MODEL: s.model ?? undefined,
    CODEX_MODEL: s.codexModel ?? undefined,
  };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd app && bun test llm-provider`
Expected: PASS（既存 `selectRunner` テスト + 新 `settingsToEnv` テスト）

- [ ] **Step 5: コミット**

```bash
git add app/server/llm-provider.ts app/server/__tests__/llm-provider.test.ts
git commit -m "feat: DB設定→env写像 settingsToEnv とLLM設定共有型を追加"
```

---

### Task 2: サーバ — `converse.ts` のランタイム切替（安定参照ラッパ + `applyLlmSettings`）

**Files:**
- Modify: `app/server/converse.ts:1-2,68-77`
- Test: `app/server/__tests__/converse-runtime.test.ts`（新規）

**Interfaces:**
- Consumes: `settingsToEnv` / `LlmSettings`（Task 1）、既存 `makeClaudeRunner` / `selectRunner` / `PARTNER_SYSTEM_PROMPT`
- Produces: `defaultRunner`（安定参照ラッパ・型不変）/ `getCurrentRunner()` / `applyLlmSettings()`（上記契約どおり）

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/converse-runtime.test.ts` を新規作成:

```ts
import { afterAll, describe, expect, test } from "bun:test";
import { applyLlmSettings, getCurrentRunner } from "../converse";
import type { LlmSettings } from "../llm-provider";

// ambient な Bun.env.LLM_PROVIDER の影響を排除するため、空 env を明示注入して決定的にする
const emptyEnv: Record<string, string | undefined> = {};
const CLAUDE: LlmSettings = { provider: "claude", baseUrl: null, model: null, codexModel: null };

describe("applyLlmSettings ランタイム切替", () => {
  // グローバル currentRunner をこのファイル内で差し替えるため、後始末で claude 基準へ戻す
  afterAll(() => applyLlmSettings(CLAUDE, emptyEnv));

  test("openai-compat 適用で claude と別参照になり、env リセットで claude 同一参照へ戻る", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner();

    applyLlmSettings(
      { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null },
      emptyEnv,
    );
    const swapped = getCurrentRunner();
    expect(swapped).not.toBe(claudeRef);
    expect(typeof swapped).toBe("function");

    applyLlmSettings({ provider: "env", baseUrl: null, model: null, codexModel: null }, emptyEnv);
    // 空 env → LLM_PROVIDER 未設定 → selectRunner は同一の claudeRunner を返す
    expect(getCurrentRunner()).toBe(claudeRef);
  });

  test("codex 適用も claude と別参照になる", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner();
    applyLlmSettings({ provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" }, emptyEnv);
    expect(getCurrentRunner()).not.toBe(claudeRef);
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd app && bun test converse-runtime`
Expected: FAIL（`applyLlmSettings` / `getCurrentRunner` が未 export → import エラー）

- [ ] **Step 3: 実装する**

`app/server/converse.ts` の1行目〜2行目の import を差し替える。変更前:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { selectRunner } from "./llm-provider";
```

変更後:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import { selectRunner, settingsToEnv, type LlmSettings } from "./llm-provider";
```

同ファイルの `defaultRunner` 定義（現状 68〜77 行）を差し替える。変更前:

```ts
/**
 * 全ドメイン共有の LLM ランナー（唯一の makeClaudeRunner(query) 生成点）。
 * プロンプト配置規約: 各ドメインの system プロンプトはそのドメインモジュール
 * （coach.ts / placement.ts / assessment.ts / content-gen.ts / converse.ts）に置き、
 * ここでは実行器だけを共有する。
 */
export const defaultRunner: ClaudeRunner = selectRunner({
  claudeRunner: makeClaudeRunner(query),
  defaultSystemPrompt: PARTNER_SYSTEM_PROMPT,
});
```

変更後:

```ts
/**
 * 全ドメイン共有の LLM ランナー（唯一の makeClaudeRunner(query) 生成点）。
 * プロンプト配置規約: 各ドメインの system プロンプトはそのドメインモジュール
 * （coach.ts / placement.ts / assessment.ts / content-gen.ts / converse.ts）に置き、
 * ここでは実行器だけを共有する。
 *
 * ランタイム切替: defaultRunner は「現在の currentRunner に委譲する安定参照のラッパ」。
 * 6つの呼び出し側（coach / placement / assessment / converse / scripts/generate-content）は
 * `runner: ClaudeRunner = defaultRunner` のまま無変更で、applyLlmSettings による
 * currentRunner の差し替えが即座に反映される（再起動不要）。
 * claudeRunner は一度だけ生成して使い回すので、claude/env に戻すと同一参照へ戻る。
 */
const claudeRunner = makeClaudeRunner(query);
let currentRunner: ClaudeRunner = selectRunner({
  claudeRunner,
  defaultSystemPrompt: PARTNER_SYSTEM_PROMPT,
});
export const defaultRunner: ClaudeRunner = (prompt, resumeId, opts) =>
  currentRunner(prompt, resumeId, opts);

/** 現在アクティブな runner を返す（診断・テスト用のシーム）。 */
export function getCurrentRunner(): ClaudeRunner {
  return currentRunner;
}

/**
 * DB 由来の LLM 設定を実行中プロセスへ即時適用する（再起動不要）。
 * 既存 selectRunner を再利用し、新しいアダプタは作らない。settingsToEnv が DB 設定を env 形状へ写像し、
 * APIキーは env（.env）由来のみ。検証済み入力に対しては throw しない（openai-compat の必須値は route が保証）。
 * 不正な provider 等では selectRunner が throw しうるため、起動時適用側（index.ts）で fail-open ガードする。
 */
export function applyLlmSettings(
  settings: LlmSettings,
  env: Record<string, string | undefined> = Bun.env,
): void {
  currentRunner = selectRunner({
    claudeRunner,
    defaultSystemPrompt: PARTNER_SYSTEM_PROMPT,
    env: settingsToEnv(settings, env),
  });
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd app && bun test converse-runtime converse`
Expected: PASS（新 swap テスト + 既存 `converse.test.ts` が回帰なし）

- [ ] **Step 5: 型チェック（6つの呼び出し側が無変更で通ることの確認）**

Run: `cd app && bun run typecheck`
Expected: エラーなし（`defaultRunner` の型は `ClaudeRunner` のまま。`coach.ts` / `placement.ts` / `assessment.ts` / `scripts/generate-content.ts` は無変更で通る）

- [ ] **Step 6: コミット**

```bash
git add app/server/converse.ts app/server/__tests__/converse-runtime.test.ts
git commit -m "feat: defaultRunnerを安定参照ラッパ化しapplyLlmSettingsで実行時切替可能に"
```

---

### Task 3: サーバ — `llm_settings` 単一行ストア + `openDb` 配線

**Files:**
- Create: `app/server/llm-settings-store.ts`
- Modify: `app/server/db.ts:11,66`（import 追加 + `openDb` で `ensureLlmSettingsSchema` 呼び出し）
- Test: `app/server/__tests__/llm-settings-store.test.ts`（新規）

**Interfaces:**
- Consumes: `LlmSettings`（Task 1）、既存 `Database`（bun:sqlite）
- Produces: `ensureLlmSettingsSchema` / `LlmSettingsStore` / `makeLlmSettingsStore`（上記契約どおり）

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/llm-settings-store.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureLlmSettingsSchema, makeLlmSettingsStore } from "../llm-settings-store";

function fresh() {
  const db = new Database(":memory:");
  ensureLlmSettingsSchema(db);
  return { db, store: makeLlmSettingsStore(db) };
}

describe("llm-settings-store", () => {
  test("初期状態は null（未設定＝環境変数に従う）", () => {
    expect(fresh().store.get()).toBeNull();
  });

  test("save → get で往復する（openai-compat）", () => {
    const { store } = fresh();
    const input = { provider: "openai-compat" as const, baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null };
    expect(store.save(input)).toEqual(input);
    expect(store.get()).toEqual(input);
  });

  test("再 save は単一行を上書きする（行が増えない）", () => {
    const { db, store } = fresh();
    store.save({ provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" });
    store.save({ provider: "env", baseUrl: null, model: null, codexModel: null });
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM llm_settings").get();
    expect(count?.n).toBe(1);
    expect(store.get()).toEqual({ provider: "env", baseUrl: null, model: null, codexModel: null });
  });
});
```

- [ ] **Step 2: テストが落ちることを確認する**

Run: `cd app && bun test llm-settings-store`
Expected: FAIL（`../llm-settings-store` が存在しない）

- [ ] **Step 3: ストアを実装する**

`app/server/llm-settings-store.ts` を新規作成:

```ts
import type { Database } from "bun:sqlite";
import type { LlmSettings } from "./llm-provider";

/** LLM プロバイダ設定の永続化（単一行 id=1）。APIキーは持たない（.env のみ）。 */
export function ensureLlmSettingsSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS llm_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    provider TEXT NOT NULL,
    base_url TEXT,
    model TEXT,
    codex_model TEXT,
    updated_at TEXT NOT NULL
  )`);
}

export type LlmSettingsStore = {
  /** 保存済み設定。行が無ければ null（＝環境変数に従う）。 */
  get(): LlmSettings | null;
  /** 単一行(id=1)を upsert し、保存した設定をそのまま返す。provider の妥当性は route が保証する。 */
  save(s: LlmSettings): LlmSettings;
};

type Row = { provider: string; base_url: string | null; model: string | null; codex_model: string | null };

export function makeLlmSettingsStore(db: Database): LlmSettingsStore {
  return {
    get() {
      const row = db
        .query<Row, []>("SELECT provider, base_url, model, codex_model FROM llm_settings WHERE id = 1")
        .get();
      if (!row) return null;
      return {
        provider: row.provider as LlmSettings["provider"],
        baseUrl: row.base_url,
        model: row.model,
        codexModel: row.codex_model,
      };
    },
    save(s) {
      db.run(
        `INSERT INTO llm_settings (id, provider, base_url, model, codex_model, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           base_url = excluded.base_url,
           model = excluded.model,
           codex_model = excluded.codex_model,
           updated_at = excluded.updated_at`,
        [s.provider, s.baseUrl, s.model, s.codexModel, new Date().toISOString()],
      );
      return s;
    },
  };
}
```

- [ ] **Step 4: `openDb` に配線する**

`app/server/db.ts` の import 群（11行目 `import { ensureFeedbackSchema } from "./feedback-store";` の直後）に追加:

```ts
import { ensureLlmSettingsSchema } from "./llm-settings-store";
```

同ファイルの `openDb` 内、`ensureFeedbackSchema(db);`（66行目付近）の直後に追加:

```ts
  ensureLlmSettingsSchema(db);
```

- [ ] **Step 5: テストが通ることを確認する**

Run: `cd app && bun test llm-settings-store`
Expected: PASS（3件）

- [ ] **Step 6: 既存 DB テストの回帰確認 + 型チェック**

Run: `cd app && bun test db && bun run typecheck`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add app/server/llm-settings-store.ts app/server/db.ts app/server/__tests__/llm-settings-store.test.ts
git commit -m "feat: llm_settings単一行ストアを追加しopenDbに配線"
```

---

### Task 4: サーバ — `GET/PUT /api/llm-settings` ルート + 配線 + テストフェイク

**Files:**
- Create: `app/server/routes/llm-settings.ts`
- Modify: `app/server/routes.ts:17,29,48`（import・`RouteDeps` 交差・spread）
- Modify: `app/server/__tests__/helpers/http.ts`（`putJson` 追加）
- Modify: `app/server/__tests__/helpers/route-deps.ts`（`makeTestDeps` に4フィールド追加）
- Test: `app/server/__tests__/routes-llm-settings.test.ts`（新規）

**Interfaces:**
- Consumes: `LlmSettings` / `LlmProvider`（Task 1）、既存 `RouteEntry` / `json` / `parseJsonBody` / `exact`（`routes/http.ts`）
- Produces: `LlmSettingsRoutesDeps` / `makeLlmSettingsRoutes` / `putJson`（上記契約どおり）

- [ ] **Step 1: PUT 用テストヘルパを追加する**

`app/server/__tests__/helpers/http.ts` の末尾に追加:

```ts
export function putJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
```

- [ ] **Step 2: 失敗するテストを書く**

`app/server/__tests__/routes-llm-settings.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq, putJson } from "./helpers/http";
import type { LlmSettings } from "../llm-provider";

describe("llm-settings API", () => {
  test("GET: 未設定なら provider:env と env 情報を返す（APIキーは boolean のみ）", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: "env", baseUrl: null, model: null, codexModel: null,
      apiKeyConfigured: false, envProvider: "claude",
    });
  });

  test("GET: 保存済み openai-compat 設定を返す（apiKeyConfigured=true）", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null }),
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    expect(await res.json()).toEqual({
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null,
      apiKeyConfigured: true, envProvider: "claude",
    });
  });

  test("PUT openai-compat: 検証通過で save & apply され applied:true を返す", async () => {
    const saved: LlmSettings[] = [];
    const applied: LlmSettings[] = [];
    let current: LlmSettings | null = null;
    const { deps } = makeTestDeps({
      getLlmSettings: () => current,
      saveLlmSettings: (s) => { saved.push(s); current = s; },
      applyLlmSettings: (s) => { applied.push(s); },
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings", {
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", applied: true, error: null,
    });
    expect(saved[0]).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
    expect(applied[0]).toEqual(saved[0]);
  });

  test("PUT codex: 任意 model を保存する（baseUrl/model は null）", async () => {
    const saved: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    await makeFetchHandler(deps)(putJson("/api/llm-settings", { provider: "codex", codexModel: "o4-mini" }));
    expect(saved[0]).toEqual({ provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" });
  });

  test("PUT env: リセットとして provider:env を保存する", async () => {
    const saved: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    await makeFetchHandler(deps)(putJson("/api/llm-settings", { provider: "env" }));
    expect(saved[0]).toEqual({ provider: "env", baseUrl: null, model: null, codexModel: null });
  });

  test("PUT 400: 不正 provider・openai-compat の baseUrl 欠落/不正URL・model 欠落（保存しない）", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    const h = makeFetchHandler(deps);
    expect((await h(putJson("/api/llm-settings", { provider: "gemini" }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings", { provider: "openai-compat", model: "m" }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings", { provider: "openai-compat", baseUrl: "not a url", model: "m" }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings", { provider: "openai-compat", baseUrl: "http://x/v1" }))).status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test("PUT: apply が throw しても保存は成功扱いで applied:false + error を返す（crash化させない）", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "claude", baseUrl: null, model: null, codexModel: null }),
      saveLlmSettings: () => {},
      applyLlmSettings: () => { throw new Error("boom apply"); },
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings", { provider: "claude" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: false, error: "boom apply" });
  });
});
```

- [ ] **Step 3: テストが落ちることを確認する**

Run: `cd app && bun test routes-llm-settings`
Expected: FAIL（`makeTestDeps` に `getLlmSettings` 等が無く、ルート未実装）

- [ ] **Step 4: ルートを実装する**

`app/server/routes/llm-settings.ts` を新規作成:

```ts
import { json, parseJsonBody, exact, type RouteEntry } from "./http";
import type { LlmSettings, LlmProvider } from "../llm-provider";

export type LlmSettingsRoutesDeps = {
  getLlmSettings: () => LlmSettings | null;
  saveLlmSettings: (s: LlmSettings) => void;
  applyLlmSettings: (s: LlmSettings) => void;
  /** env 由来の情報。値そのものは返さず、APIキーは presence(boolean) のみ。 */
  llmEnv: () => { provider: string; apiKeyConfigured: boolean };
};

const PROVIDERS = ["env", "claude", "openai-compat", "codex"] as const;

function isProvider(v: unknown): v is LlmProvider {
  return typeof v === "string" && (PROVIDERS as readonly string[]).includes(v);
}

function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** undefined/null/空文字 → null（未指定）、trim後1文字以上でmax以下の文字列 → trim値、それ以外 → undefined（不正） */
function asOptionalStr(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

type Body = { provider?: unknown; baseUrl?: unknown; model?: unknown; codexModel?: unknown };

/** GET と PUT 応答の共通ビュー。APIキー値は決して含めない（有無の boolean のみ）。 */
function viewOf(deps: LlmSettingsRoutesDeps, applied?: boolean, error?: string | null) {
  const stored = deps.getLlmSettings();
  const env = deps.llmEnv();
  const s: LlmSettings = stored ?? { provider: "env", baseUrl: null, model: null, codexModel: null };
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    codexModel: s.codexModel,
    apiKeyConfigured: env.apiKeyConfigured,
    envProvider: env.provider,
    ...(applied === undefined ? {} : { applied }),
    ...(error === undefined ? {} : { error }),
  };
}

async function handlePut(req: Request, deps: LlmSettingsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<Body>(req);
  if (!parsed.ok) return parsed.response;
  const b = parsed.body;

  if (!isProvider(b.provider)) {
    return json({ error: `provider must be one of ${PROVIDERS.join(", ")}` }, 400);
  }

  let settings: LlmSettings;
  if (b.provider === "openai-compat") {
    const baseUrl = asOptionalStr(b.baseUrl, 500);
    if (!baseUrl || !isHttpUrl(baseUrl)) {
      return json({ error: "baseUrl must be a valid http(s) URL for openai-compat" }, 400);
    }
    const model = asOptionalStr(b.model, 200);
    if (!model) return json({ error: "model is required for openai-compat" }, 400);
    settings = { provider: "openai-compat", baseUrl, model, codexModel: null };
  } else if (b.provider === "codex") {
    const codexModel = asOptionalStr(b.codexModel, 200);
    if (codexModel === undefined) {
      return json({ error: "codexModel must be a string of at most 200 characters" }, 400);
    }
    settings = { provider: "codex", baseUrl: null, model: null, codexModel };
  } else {
    // "claude" / "env": 付随フィールドは持たない
    settings = { provider: b.provider, baseUrl: null, model: null, codexModel: null };
  }

  deps.saveLlmSettings(settings);
  // fail-open: 検証済み入力は基本 throw しないが、万一失敗しても「保存は成功」として中立に
  // applied:false + error を返す（保存成功を 5xx に化けさせない＝crash風の体験を避ける）。
  let applied = true;
  let error: string | null = null;
  try {
    deps.applyLlmSettings(settings);
  } catch (err) {
    applied = false;
    error = err instanceof Error ? err.message : String(err);
  }
  return json(viewOf(deps, applied, error));
}

export function makeLlmSettingsRoutes(deps: LlmSettingsRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/llm-settings", () => json(viewOf(deps))),
    exact("PUT", "/api/llm-settings", (req) => handlePut(req, deps)),
  ];
}
```

- [ ] **Step 5: `routes.ts` へ配線する**

`app/server/routes.ts` の import 群末尾（17行目 `import { makeFeedbackRoutes, ... }` の直後）に追加:

```ts
import { makeLlmSettingsRoutes, type LlmSettingsRoutesDeps } from "./routes/llm-settings";
```

`RouteDeps` 交差型（29行目 `AssessmentRoutesDeps & ListeningRoutesDeps & FeedbackRoutesDeps;`）を差し替える:

```ts
  AssessmentRoutesDeps & ListeningRoutesDeps & FeedbackRoutesDeps & LlmSettingsRoutesDeps;
```

`routes` 配列（48行目 `...makeFeedbackRoutes(deps),` の直後）に追加:

```ts
    ...makeLlmSettingsRoutes(deps),
```

- [ ] **Step 6: `makeTestDeps` にフェイクを追加する**

`app/server/__tests__/helpers/route-deps.ts` の `deps` オブジェクト内、`feedbackStore: makeFakeFeedbackStore(),`（191行目付近）の直後に追加:

```ts
    getLlmSettings: () => null,
    saveLlmSettings: (_s) => {},
    applyLlmSettings: (_s) => {},
    llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
```

- [ ] **Step 7: テストが通ることを確認する**

Run: `cd app && bun test routes-llm-settings`
Expected: PASS（7件）

- [ ] **Step 8: 全ルートテストの回帰確認 + 型チェック**

Run: `cd app && bun test && bun run typecheck`
Expected: 全 PASS・型エラーなし

- [ ] **Step 9: コミット**

```bash
git add app/server/routes/llm-settings.ts app/server/routes.ts app/server/__tests__/helpers/http.ts app/server/__tests__/helpers/route-deps.ts app/server/__tests__/routes-llm-settings.test.ts
git commit -m "feat: GET/PUT /api/llm-settings を追加（検証・fail-open適用・キーは有無のみ開示）"
```

---

### Task 5: サーバ — `index.ts` 配線と起動時 fail-open 適用

**Files:**
- Modify: `app/server/index.ts:4,22,38,101`（import・store 生成・deps 4項・起動時適用）

**Interfaces:**
- Consumes: `makeLlmSettingsStore`（Task 3）、`applyLlmSettings`（Task 2）、`LlmSettingsRoutesDeps` の4フィールド（Task 4）
- Produces: 実 `RouteDeps` の配線（テストなし＝合成ルート。typecheck + 手動スモークで確認）

- [ ] **Step 1: import を追加する**

`app/server/index.ts` の4行目 `import { converseTurn } from "./converse";` を差し替える:

```ts
import { converseTurn, applyLlmSettings } from "./converse";
```

`import { makeFeedbackStore } from "./feedback-store";`（22行目）の直後に追加:

```ts
import { makeLlmSettingsStore } from "./llm-settings-store";
```

- [ ] **Step 2: ストアを生成する**

`const feedbackStore = makeFeedbackStore(db);`（38行目）の直後に追加:

```ts
const llmSettingsStore = makeLlmSettingsStore(db);
```

- [ ] **Step 3: `realDeps` に4フィールドを追加する**

`realDeps` オブジェクト内、`feedbackStore,`（101行目付近）の直後に追加:

```ts
  getLlmSettings: () => llmSettingsStore.get(),
  saveLlmSettings: (s) => llmSettingsStore.save(s),
  applyLlmSettings: (s) => applyLlmSettings(s),
  // env 由来情報。APIキーは有無のみ（値は絶対に返さない）。
  llmEnv: () => ({
    provider: (Bun.env.LLM_PROVIDER ?? "claude").trim().toLowerCase() || "claude",
    apiKeyConfigured: Boolean(Bun.env.OPENAI_COMPAT_API_KEY?.trim()),
  }),
```

- [ ] **Step 4: 起動時に fail-open で適用する**

`const realDeps: RouteDeps = { ... };` の閉じ括弧の直後（`Bun.serve({ ... })` の前）に追加:

```ts
// 起動時: DB に LLM 設定があれば実行中プロセスへ適用する（fail-open）。
// 行が無ければ何もせず、converse.ts のモジュールロード時 env 既定のまま（現行と完全同一）。
// provider="env" は settingsToEnv 経由で pure-env を再現する。UI 由来の不正値で LaunchAgent の
// crash-loop を起こさないため、失敗は warn してフォールバックする（プロセスは落とさない）。
const savedLlm = llmSettingsStore.get();
if (savedLlm) {
  try {
    applyLlmSettings(savedLlm);
  } catch (err) {
    console.warn(`[llm] failed to apply saved settings, falling back to environment/claude: ${String(err)}`);
  }
}
```

- [ ] **Step 5: 型チェック**

Run: `cd app && bun run typecheck`
Expected: エラーなし（`RouteDeps` の全フィールドが `realDeps` で満たされる）

- [ ] **Step 6: 手動スモーク（任意・環境が許せば）**

Run: `cd app && bun test` で全サーバテストが緑であることを確認（合成ルートの回帰）。実サーバ起動のスモークは Task 8 完了後にまとめて行う。
Expected: 全 PASS

- [ ] **Step 7: コミット**

```bash
git add app/server/index.ts
git commit -m "feat: llm-settingsをindex配線し起動時fail-open適用を追加"
```

---

### Task 6: クライアント — `api/llm-settings.ts` + バレル

**Files:**
- Create: `app/client/src/api/llm-settings.ts`
- Modify: `app/client/src/api/index.ts:26`（バレル再エクスポート追加）

**Interfaces:**
- Consumes: 既存 `extractErrorMessage`（`api/http.ts`）、HTTP `GET/PUT /api/llm-settings`（Task 4）
- Produces: `LlmProvider` / `LlmSettingsView` / `LlmSettingsInput` / `fetchLlmSettings` / `saveLlmSettings`（上記契約どおり）

- [ ] **Step 1: API クライアントを実装する**

`app/client/src/api/llm-settings.ts` を新規作成:

```ts
import { extractErrorMessage } from "./http";

export type LlmProvider = "env" | "claude" | "openai-compat" | "codex";

/** GET/PUT 応答。APIキー値は含まれない（有無のみ apiKeyConfigured）。 */
export type LlmSettingsView = {
  provider: LlmProvider;
  baseUrl: string | null;
  model: string | null;
  codexModel: string | null;
  apiKeyConfigured: boolean;
  envProvider: string;
  /** PUT 応答のみ: 実行中プロセスへ適用できたか */
  applied?: boolean;
  /** PUT 応答のみ: 適用失敗時のメッセージ */
  error?: string | null;
};

export type LlmSettingsInput = {
  provider: LlmProvider;
  baseUrl?: string | null;
  model?: string | null;
  codexModel?: string | null;
};

export async function fetchLlmSettings(): Promise<LlmSettingsView> {
  const res = await fetch("/api/llm-settings");
  if (!res.ok) throw new Error(`llm-settings failed: ${await extractErrorMessage(res)}`);
  return res.json();
}

export async function saveLlmSettings(input: LlmSettingsInput): Promise<LlmSettingsView> {
  const res = await fetch("/api/llm-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`llm-settings save failed: ${await extractErrorMessage(res)}`);
  return res.json();
}
```

- [ ] **Step 2: バレルに追加する**

`app/client/src/api/index.ts` の末尾（26行目 `export * from "./feedback";` の直後）に追加:

```ts
export * from "./llm-settings";
```

- [ ] **Step 3: 型チェック**

Run: `cd app/client && bun run build`
Expected: `tsc --noEmit` 成功 → `vite build` 成功（新モジュールが型・ビルドを通る）

- [ ] **Step 4: コミット**

```bash
git add app/client/src/api/llm-settings.ts app/client/src/api/index.ts
git commit -m "feat: クライアントのllm-settings APIクライアントを追加"
```

---

### Task 7: クライアント — i18n `llm` ブロック（EN/JA）

**Files:**
- Modify: `app/client/src/i18n.ts:41-49,213-221,236-245,483-492`（named 型追加・`Strings` 交差・EN/JA ブロック追加）

**Interfaces:**
- Consumes: 既存 `Strings` 交差型・`STR`
- Produces: `STR[lang].llm`（下記キー一式）。既存キーは不変。

- [ ] **Step 1: named 型を追加する**

`app/client/src/i18n.ts` の `type SupportStrings = { ... };`（41〜49行目）の**直後**に追加:

```ts
type LlmPanelStrings = {
  llm: {
    title: string;
    providerLabel: string;
    optEnv: string; optClaude: string; optOpenai: string; optCodex: string;
    baseUrlLabel: string; baseUrlPlaceholder: string;
    modelLabel: string; modelPlaceholder: string;
    codexModelLabel: string; codexModelPlaceholder: string;
    save: string; saving: string;
    applied: string;
    notApplied: (msg: string) => string;
    saveFailed: string;
    apiKeyConfigured: string; apiKeyMissing: string;
    help: string; helpAria: string;
    envNote: (envProvider: string) => string;
  };
};
```

- [ ] **Step 2: `Strings` 交差に組み込む**

`type Strings =` の末尾行（現状 `& LevelChipStrings & FeedbackRowStrings & FeedbackScreenStrings;`）を差し替える:

```ts
  & LevelChipStrings & FeedbackRowStrings & FeedbackScreenStrings & LlmPanelStrings;
```

- [ ] **Step 3: EN ブロックを追加する**

`STR.en` の `support: { ... },` ブロック（`helpAriaSuffix: (label) => \`About ${label}\`,` を含む）の**閉じ `},` の直後**に追加:

```ts
    llm: {
      title: "LLM provider",
      providerLabel: "Provider",
      optEnv: "Default (env)", optClaude: "Claude", optOpenai: "OpenAI-compatible", optCodex: "Codex",
      baseUrlLabel: "Base URL", baseUrlPlaceholder: "http://localhost:11434/v1",
      modelLabel: "Model", modelPlaceholder: "llama3.1",
      codexModelLabel: "Model (optional)", codexModelPlaceholder: "blank = Codex default",
      save: "Save", saving: "Saving…",
      applied: "Applied to the running app.",
      notApplied: (msg) => `Saved, but not applied: ${msg}`,
      saveFailed: "Could not save settings.",
      apiKeyConfigured: "API key: set in app/.env", apiKeyMissing: "API key: not set (app/.env)",
      help: "The API key is read from app/.env only and is never stored here. Reply quality depends on the model you choose; the default (Claude) is the tested baseline.",
      helpAria: "About the LLM provider setting",
      envNote: (p) => `Environment currently resolves to: ${p}`,
    },
```

- [ ] **Step 4: JA ブロックを追加する**

`STR.ja` の `support: { ... },` ブロック（`helpAriaSuffix: (label) => \`${label}の説明\`,` を含む）の**閉じ `},` の直後**に追加:

```ts
    llm: {
      title: "LLM プロバイダ",
      providerLabel: "プロバイダ",
      optEnv: "既定（環境変数）", optClaude: "Claude", optOpenai: "OpenAI 互換", optCodex: "Codex",
      baseUrlLabel: "ベース URL", baseUrlPlaceholder: "http://localhost:11434/v1",
      modelLabel: "モデル", modelPlaceholder: "llama3.1",
      codexModelLabel: "モデル（任意）", codexModelPlaceholder: "空欄で Codex 既定",
      save: "保存", saving: "保存中…",
      applied: "実行中のアプリに適用しました。",
      notApplied: (msg) => `保存しましたが適用できませんでした: ${msg}`,
      saveFailed: "設定を保存できませんでした。",
      apiKeyConfigured: "APIキー: app/.env に設定済み", apiKeyMissing: "APIキー: 未設定（app/.env）",
      help: "APIキーは app/.env からのみ読み込み、ここには保存しません。応答品質は選んだモデルに依存します。既定（Claude）が動作確認済みの基準です。",
      helpAria: "LLM プロバイダ設定の説明",
      envNote: (p) => `環境変数の現在の解決先: ${p}`,
    },
```

- [ ] **Step 5: 型チェック（EN/JA 双方の存在を強制）**

Run: `cd app/client && bun run build`
Expected: 成功。`STR: Record<Lang, Strings>` により、EN か JA のどちらかで `llm` ブロックが欠けると型エラーになる（両言語の完全性を保証）。

- [ ] **Step 6: コミット**

```bash
git add app/client/src/i18n.ts
git commit -m "feat: LLMプロバイダ設定UIのi18n(EN/JA)を追加"
```

---

### Task 8: クライアント — サイドバー `LlmPanel`（SupportPanel 直下）+ CSS

**Files:**
- Modify: `app/client/src/App.tsx:1-20,127,221`（import・描画・`LlmPanel` 追加）
- Modify: `app/client/src/styles/app.css`（`.llm-*` の最小スタイル追加）

**Interfaces:**
- Consumes: `fetchLlmSettings` / `saveLlmSettings` / `LlmProvider` / `LlmSettingsView`（Task 6）、`STR[lang].llm`（Task 7）、既存 `Button`（`./ui/Button`）
- Produces: サイドバー常設の LLM 設定パネル（typecheck + build で検証）

- [ ] **Step 1: import を追加する**

`app/client/src/App.tsx` の `api` からの import（1〜5行目の `from "./api"`）に、LLM API を足す。現状:

```ts
import {
  fetchPracticeDays, fetchProgressSummary, getHealth, onProgressUpdate, progressLevelAction, sessionEnd,
  sessionEndKeepalive, sessionStart, type Health, type ProgressSummary,
} from "./api";
```

差し替え:

```ts
import {
  fetchLlmSettings, fetchPracticeDays, fetchProgressSummary, getHealth, onProgressUpdate, progressLevelAction,
  saveLlmSettings, sessionEnd, sessionEndKeepalive, sessionStart,
  type Health, type LlmProvider, type LlmSettingsView, type ProgressSummary,
} from "./api";
```

- [ ] **Step 2: `SupportPanel` 直下に `LlmPanel` を描画する**

`app/client/src/App.tsx` の127行目 `<SupportPanel lang={lang} />` の直後に追加:

```tsx
        <LlmPanel lang={lang} />
```

- [ ] **Step 3: `LlmPanel` コンポーネントを実装する**

`SupportPanel` 関数の閉じ括弧（221行目 `}` ）の直後、`PracticeStat` の前に追加:

```tsx
/**
 * サイドバー常設の LLM プロバイダ設定。DB に永続化し、保存時に実行中プロセスへ即時適用する（再起動不要）。
 * APIキーは扱わない（app/.env のみ）。研究トーンで中立に表示する。
 */
function LlmPanel({ lang }: { lang: Lang }) {
  const t = STR[lang].llm;
  const [view, setView] = useState<LlmSettingsView | null>(null);
  const [provider, setProvider] = useState<LlmProvider>("env");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [codexModel, setCodexModel] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const fetchedRef = useRef(false);

  function hydrate(v: LlmSettingsView) {
    setView(v);
    setProvider(v.provider);
    setBaseUrl(v.baseUrl ?? "");
    setModel(v.model ?? "");
    setCodexModel(v.codexModel ?? "");
  }

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchLlmSettings().then(hydrate).catch(() => {});
  }, []);

  async function onSave() {
    setSaving(true);
    setResult(null);
    try {
      const v = await saveLlmSettings({
        provider,
        baseUrl: provider === "openai-compat" ? baseUrl : null,
        model: provider === "openai-compat" ? model : null,
        codexModel: provider === "codex" ? (codexModel || null) : null,
      });
      hydrate(v);
      setResult(v.applied === false ? t.notApplied(v.error ?? "") : t.applied);
    } catch {
      setResult(t.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  const providers: Array<{ key: LlmProvider; label: string }> = [
    { key: "env", label: t.optEnv },
    { key: "claude", label: t.optClaude },
    { key: "openai-compat", label: t.optOpenai },
    { key: "codex", label: t.optCodex },
  ];

  return (
    <div className="support-panel stack">
      <div className="support-label-row">
        <div className="stat-title">{t.title}</div>
        <button
          className="info-btn"
          aria-label={t.helpAria}
          title={t.help}
          aria-expanded={helpOpen}
          aria-controls="llm-help"
          onClick={() => setHelpOpen((v) => !v)}
        >ⓘ</button>
      </div>
      {helpOpen && <div id="llm-help" className="info-pop">{t.help}</div>}
      <div className="lang-toggle llm-provider-toggle" role="group" aria-label={t.providerLabel}>
        {providers.map((p) => (
          <button
            key={p.key}
            className={provider === p.key ? "is-active" : ""}
            onClick={() => setProvider(p.key)}
          >{p.label}</button>
        ))}
      </div>
      {provider === "env" && view && (
        <div className="text-sm text-muted">{t.envNote(view.envProvider)}</div>
      )}
      {provider === "openai-compat" && (
        <div className="llm-fields stack">
          <label className="llm-field">
            <span className="text-sm text-muted">{t.baseUrlLabel}</span>
            <input className="llm-input" value={baseUrl} placeholder={t.baseUrlPlaceholder} onChange={(e) => setBaseUrl(e.target.value)} />
          </label>
          <label className="llm-field">
            <span className="text-sm text-muted">{t.modelLabel}</span>
            <input className="llm-input" value={model} placeholder={t.modelPlaceholder} onChange={(e) => setModel(e.target.value)} />
          </label>
          <div className="text-sm text-muted">{view?.apiKeyConfigured ? t.apiKeyConfigured : t.apiKeyMissing}</div>
        </div>
      )}
      {provider === "codex" && (
        <label className="llm-field">
          <span className="text-sm text-muted">{t.codexModelLabel}</span>
          <input className="llm-input" value={codexModel} placeholder={t.codexModelPlaceholder} onChange={(e) => setCodexModel(e.target.value)} />
        </label>
      )}
      <Button variant="secondary" onClick={onSave} disabled={saving}>{saving ? t.saving : t.save}</Button>
      {result && <div className="info-pop" role="status">{result}</div>}
    </div>
  );
}
```

- [ ] **Step 4: CSS を追加する**

`app/client/src/styles/app.css` の末尾に追加（既存 `.lang-toggle` / `.support-panel` / `.info-pop` を再利用し、入力欄と4択の折返しだけ補う）:

```css
/* LLM プロバイダ設定パネル（サイドバー常設） */
.llm-provider-toggle { flex-wrap: wrap; }
.llm-field { display: flex; flex-direction: column; gap: var(--sp-1); }
.llm-input {
  font: inherit; font-size: var(--fs-sm); padding: 4px 6px; width: 100%;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--surface); color: var(--text);
}
```

- [ ] **Step 5: 型チェック + ビルド**

Run: `cd app/client && bun run build`
Expected: `tsc --noEmit` 成功・`vite build` 成功

- [ ] **Step 6: 手動スモーク（実サーバ）**

1つのターミナルで `cd app && bun run dev`、別ターミナルで `cd app/client && bun run dev` を起動し、ブラウザでサイドバーに「LLM プロバイダ」パネルが出ることを確認する。手順:
- 「OpenAI 互換」を選ぶと Base URL / Model 入力欄と「APIキー: …（app/.env）」が出る。
- 「Codex」を選ぶと任意モデル欄が出る。
- 「既定（環境変数）」を選ぶと「環境変数の現在の解決先: …」が出る。
- 保存すると「実行中のアプリに適用しました。」が出る（不正 URL 等は保存されず、サーバ 400 → `saveFailed` 文言）。
- レスポンス・DOM に APIキー値が現れないことを確認（`apiKeyConfigured` の boolean のみ）。

Expected: 上記が確認できる。異常時はエラーメッセージを添えて報告する（この計画では握りつぶさない）。

- [ ] **Step 7: コミット**

```bash
git add app/client/src/App.tsx app/client/src/styles/app.css
git commit -m "feat: サイドバーにLLMプロバイダ切替パネルを追加（再起動不要・キーは.env）"
```

---

### Task 9: ドキュメント — README 追記 + CHANGELOG v0.17.0

**Files:**
- Modify: `README.md`（「LLM プロバイダの切替」節に UI の一言を追記）
- Modify: `CHANGELOG.md`（先頭に v0.17.0 を追加）

**Interfaces:**
- Consumes: なし（ドキュメントのみ）
- Produces: なし

- [ ] **Step 1: README に UI の存在を追記する**

`README.md` の「LLM プロバイダの切替」節（132行目付近の説明段落）に、次の1文を段落末尾へ追記する:

```markdown
サイドバー下部の「LLM プロバイダ」パネルからも切替でき、保存すると実行中のアプリへ再起動なしで即時適用される（設定は SQLite の `llm_settings` 単一行に保存。**APIキーは UI・DB には保存されず `app/.env` の `OPENAI_COMPAT_API_KEY` のみ**）。「既定（環境変数）」を選ぶと `app/.env` の `LLM_PROVIDER` に従う状態へ戻る。
```

- [ ] **Step 2: CHANGELOG に v0.17.0 を追加する**

`CHANGELOG.md` の `## [0.16.0] - 2026-07-07` の**直前**に追加:

```markdown
## [0.17.0] - 2026-07-07

### Added

- **LLM プロバイダのサイドバー設定UI**: プロバイダ（既定=環境変数 / Claude / OpenAI 互換 / Codex）をサイドバーから選べるように。保存すると SQLite の `llm_settings`（単一行）に永続化し、実行中プロセスへ**再起動なしで即時適用**する。OpenAI 互換は Base URL / モデル名、Codex は任意モデル名を入力できる。**APIキーは UI・DB・API 応答・ログに一切載せず `app/.env`（`OPENAI_COMPAT_API_KEY`）のみ**（UI はキーの有無だけを表示）。起動時の DB 設定適用は fail-open（不正値でも warn してフォールバックし crash-loop を防ぐ）。DB 未設定 + env 未設定なら**現行の Claude と完全に同一**

```

- [ ] **Step 3: コミット**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: LLMプロバイダ設定UIをREADMEに追記しCHANGELOG v0.17.0を追加"
```

---

## Self-Review

**1. Spec coverage（骨子6点 → タスク対応）**

| 骨子 | 対応 |
| --- | --- |
| 1. ランタイム切替（安定参照ラッパ・6呼び出し側無変更・swap 関数 export） | Task 2（`defaultRunner` ラッパ・`applyLlmSettings`・`getCurrentRunner`）。Task 2 Step 5 で6呼び出し側の無変更 typecheck を確認 |
| 2. 永続化（単一行テーブル・ensureSchema・キーは .env のみ） | Task 3（`llm_settings` + `ensureLlmSettingsSchema`）。キー非保存は Task 1 `settingsToEnv` / Task 3 スキーマ（key 列なし）で担保 |
| 3. 優先順位と fail 挙動（起動時 DB→env・DB適用 fail-open） | Task 5 Step 4（起動時 try/catch fail-open）。pure-env fail-fast は Task 2 のモジュールロード初期化で不変 |
| 4. API（GET/PUT・検証・キーは boolean・リセット手段） | Task 4（`GET/PUT /api/llm-settings`・enum/URL/必須検証・`apiKeyConfigured` boolean・`provider:"env"` リセット） |
| 5. UI（SupportPanel 近く・現在値・条件付き入力・保存・中立結果・ⓘ・i18n） | Task 6〜8（API/i18n/`LlmPanel`）。SupportPanel 直下に描画（Task 8 Step 2） |
| 6. テスト（ストア TDD・ルート TDD・swap テスト・クライアント typecheck+build） | Task 1/2/3/4 が TDD、Task 6/7/8 が typecheck/build |

**2. リセット方式の決定と理由**: DB 行削除ではなく `provider:"env"` センチネル方式を採用（Task 1 `settingsToEnv` / Task 4 PUT）。理由 —(a) `settingsToEnv("env")` が env をそのまま返すことで「環境変数に従う」を1関数で表現でき、起動時ロジックが「行を読む→applyLlmSettings」で統一される（削除だと別分岐が必要）。(b) DELETE 動詞を増やさず GET/PUT 2本に収まる。(c) 単一行 upsert なので「戻す」も1回の save で冪等。(d) GET が `provider:"env"` + `envProvider` を返すため UI が「今は環境変数（→claude 等）に従う」と明示できる。研究制約（データ非削除）は学習データが対象で、設定行はその制約外だが、そもそも削除しない方式なので抵触しない。

**3. fail-open の実装場所の決定と理由**: fail-open は「起動時適用」（Task 5、`try/catch`→warn→env/claude フォールバック）に置き、`applyLlmSettings`（Task 2）自体は throw しうる純粋な swap にした。理由 — PUT ルート（Task 4）は不正入力を 400 で返して**エラーを利用者に見せたい**ので、apply が黙ってフォールバックすると検証の意味が消える。一方、起動時に壊れた DB 行で LaunchAgent が crash-loop するのは絶対に避けたいので、起動側だけ fail-open にする。PUT では検証済み入力の apply が万一 throw しても「保存成功・`applied:false`+`error`」を 200 で返す（Task 4 handlePut）ことで、保存成功を 5xx に化けさせない中立表示にした。なお `makeOpenAICompatRunner` / `makeCodexRunner` は生成時にネットワークを叩かない（クロージャを組むだけ）ため、検証済み入力の apply は実質 throw せず、crash 経路は「壊れた DB 行の起動時適用」に限定される。

**4. Placeholder scan**: 全 code ステップに完全なコードを記載。TODO/「適切なエラー処理」等の抽象指示なし。テストは実コードで記述。

**5. Type consistency**: `LlmProvider` / `LlmSettings` は Task 1 で定義し Task 2/3/4 が import（同一綴り）。クライアント側 `LlmProvider` / `LlmSettingsView` / `LlmSettingsInput` は Task 6 で定義し Task 8 が使用。`settingsToEnv(s, env?)` / `applyLlmSettings(s, env?)` / `getCurrentRunner()` / `makeLlmSettingsStore(db).get()|save()` / `makeLlmSettingsRoutes(deps)` の署名は Interfaces 契約と各タスクの実装で一致。`llmEnv(): { provider, apiKeyConfigured }` は Task 4 型・Task 5 実装・テストで一致。GET/PUT 応答形（`provider/baseUrl/model/codexModel/apiKeyConfigured/envProvider` + PUT の `applied/error`）は Task 4 `viewOf` と Task 6 `LlmSettingsView` で一致。

**6. 既定不変（回帰）**: Task 2 で `claudeRunner` を一度だけ生成し、`selectRunner`（env 未設定→同一参照）を通すため、DB 未設定 + env 未設定なら `defaultRunner` は現行と同一の claude 実装に委譲する（swap テストで同一参照復帰を検証）。既存 `converse.test.ts` / `llm-provider.test.ts` は無改変で回帰確認に使う。

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-07-llm-provider-ui.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
