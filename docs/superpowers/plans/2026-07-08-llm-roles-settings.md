# 用途別 LLM ルーティング + 設定画面 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LLM 呼び出しを 4 つの用途ロール（`conversation` / `coaching` / `generation` / `assessment`）に分け、ロールごとにプロバイダを選べるようにする。設定は新設の「設定」画面（推奨プリセット主役・ロール別は折りたたみ詳細）で行い、DB に永続化して実行中プロセスへ再起動なしで即時適用する。何も設定しなければ全ロール inherit（全体設定に従う）で、DB 未設定 + env 未設定なら現行 Claude とビット単位で同一挙動を保つ。

**Architecture:** 既存の `selectRunner` / `settingsToEnv` / `makeOpenAICompatRunner` / `makeCodexRunner` をそのまま再利用し、新しいプロバイダアダプタは作らない。`converse.ts` に「ロール別の resolved runner を持つ `Map<LlmRole, ClaudeRunner>` + ロール別の安定参照ラッパ」を導入し、`runnerFor(role)` が安定参照ラッパを返す。`applyLlmRoleSettings(global, roles, env)` が全ロールの runner を一括で再解決する（inherit ロールは global の runner を共有）。既存 `applyLlmSettings(global)` は「global を設定し全ロール inherit」の後方互換ラッパとして残す。永続化は既存 `llm_settings`（単一行 = 全体設定）を無改変で残し、**新テーブル `llm_role_settings`（role 主キー）** を追加する（`CREATE TABLE IF NOT EXISTS` のみ・既存行の移行不要）。HTTP は既存 `GET/PUT /api/llm-settings` を additive 拡張（GET に `roles` を追加・旧 PUT は全体設定用に不変）し、`PUT /api/llm-settings/roles` を新設する。UI はサイドバーの `LlmPanel` と文字サイズ/言語トグルを撤去し、nav「記録・測定」に「設定」を追加して新画面へ移設する。

**Tech Stack:** Bun + TypeScript / bun:sqlite（`Database`）/ Claude Agent SDK（既存 `makeClaudeRunner`）/ React 18 + Vite（クライアント）/ named 型 i18n（`app/client/src/i18n.ts`）

## Global Constraints

- **既定完全不変（回帰基準・最優先）**: 全ロール inherit + `llm_settings` 未設定 + env 未設定なら、4 ロールの resolved runner はすべて現行と**同一参照**の `claudeRunner`。`converse.ts` のモジュールロード時初期化も pure-env のまま。これを converse.ts のユニットテストでロックする（Task 2）。
- **secrets 衛生**: APIキーを DB・レスポンス JSON・UI・console ログに出さない。APIキーは `app/.env` の `OPENAI_COMPAT_API_KEY` のみ。API はキーの**有無**を `apiKeyConfigured: boolean` でのみ開示する。ロール別設定も同様（DB の role 行に APIキーを持たせない）。
- **fail-open な起動時適用**: DB 設定の起動時適用は `try/catch` で握り、失敗時は `console.warn` して env/claude にフォールバック（UI 由来の不正値で LaunchAgent の crash-loop を起こさない）。ルート層の apply も try/catch で `applied:false + error` を返す（保存成功を 5xx にしない）。
- **アダプタ非新設**: 既存の `selectRunner` / `settingsToEnv` / `makeOpenAICompatRunner` / `makeCodexRunner` を再利用する。プロバイダ実装を新規追加しない。
- **Codex 既定の維持**: `selectRunner` の Codex 既定（reasoning effort `medium`・service tier `fast`）は不変。今回はロール振り分けのみで Codex アダプタには一切触れない。
- **API additive / 後方互換**: `GET /api/llm-settings` は `roles` を追加するのみ（既存フィールド不変）。**旧 `PUT /api/llm-settings`（全体設定 `{provider, baseUrl?, model?, codexModel?}`）はそのまま動く**。ロール別は新エンドポイント `PUT /api/llm-settings/roles` に分離する。
- **マイグレーション禁止**: 永続化は `ensureXSchema(db)`（`CREATE TABLE IF NOT EXISTS` のみ）。既存 `llm_settings` に列を足さない（ALTER 不可のため）。ロール別は**別テーブル `llm_role_settings`** で表現する。inherit はセンチネル（`provider="inherit"`）で表し、row 不在も inherit とみなす（DELETE は使わない = 「ユーザーデータを削除しない」規約に整合）。
- **移設に伴う i18n 削除は発生しない**: `LlmPanel` と文字サイズ/言語トグルは設定画面へ**移設**するだけで、既存の `llm` / `uiScale` / `appShell` キーは設定画面で再利用する。既存の JA/EN キーは一字一句変更しない。追加キー（`nav.settings` と `settings` ブロック）は named 型で EN/JA 両方を additive 追加する。
- **研究トーン**: UI 文言は情報的・中立（目標の押し付け・優劣の断定をしない）。「品質は選んだモデルに依存、既定 Claude が動作確認済みの基準」を維持する。
- **ウォームアップは影響ゼロ（Task 10）**: ローカルLLMのウォームアップは fire-and-forget（`await` しない・例外を伝播させない）で、リクエスト処理のレイテンシ・成否に一切影響しない。失敗は `console.warn` のみ。セッションストア（会話履歴）に一切触れない。ウォームアップの HTTP はローカル LLM への OUTBOUND であり、当サーバの受信フックを再帰トリガーしない（トリガーは INBOUND 受信側のため無関係）。240秒スロットルで温める頻度を抑える。
- **uiScale/言語の挙動不変**: 文字サイズ（`localStorage["ui.scale"]` + `document.documentElement.dataset.uiScale`）と言語（`localStorage["lang"]`）の永続化キー・副作用は不変。置き場所（サイドバー → 設定画面）だけが変わる。State は引き続き `App` が保持し、設定画面へ props で渡す。
- **TDD（サーバ）**: サーバ新ロジックは赤 → 緑。テストは `__tests__/`、フェイクは `__tests__/helpers/route-deps.ts` の `satisfies`、HTTP は `postJson`/`getReq`/`putJson` で `makeFetchHandler(deps)` を直接叩く。クライアントは React 単体テスト基盤が無いため typecheck + build で担保する（既存規約どおり）。
- **コミット**: Conventional Commits（日本語）。各タスク末尾で 1 コミット。
- **検証ゲート**: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`。

## ロール対応表（実コードで確定）

runner を実際に呼ぶ関数だけがロールを持つ（`partnerSystemPrompt` / `roleplayPrompt` / `makeAeSystem` 等の**プロンプト生成関数はランナーを呼ばない**ため対象外）。routing は各ドメイン関数のシグネチャ（`runner: ClaudeRunner = defaultRunner`）を**触らず**、`index.ts` の配線と CLI の runner 変数だけを差し替える。

| ロール | ドメイン関数 | 定義ファイル | routing point（差し替え先） |
|---|---|---|---|
| `conversation` | `converseTurn`（自由会話＋ロールプレイの相手応答） | `converse.ts` | `index.ts`: `converse: (args) => converseTurn({ ...args, runner: runnerFor("conversation") })` |
| `coaching` | `generateAeFeedback`（AE添削） | `coach.ts` | `index.ts`: `aeFeedback: … runnerFor("coaching")` |
| `coaching` | `generateReflection`（振り返り） | `coach.ts` | `index.ts`: `reflection: … runnerFor("coaching")` |
| `coaching` | `generateUtteranceTranslation`（AI発話の訳） | `coach.ts` | `index.ts`: `translate: … runnerFor("coaching")` |
| `coaching` | `generatePhraseHints`（言い方ヒント） | `coach.ts` | `index.ts`: `phraseHint: … runnerFor("coaching")` |
| `coaching` | `generateFixExplanation`（fix 解説） | `coach.ts` | `index.ts`: `fixExplain: … runnerFor("coaching")` |
| `coaching` | `generateTalkExplanation`（talk 訳・解説） | `coach.ts` | `index.ts`: `explainTalk: … runnerFor("coaching")` |
| `coaching` | `generateSentenceExplanation`（例文の文法解説）※ | `coach.ts` | `index.ts`: `explainSentence: … runnerFor("coaching")` |
| `generation` | `generateModelTalk`（モデルトーク） | `coach.ts` | `index.ts`: `modelTalk: … runnerFor("generation")` |
| `generation` | `generatePrepPack`（4/3/2 準備チャンク） | `coach.ts` | `index.ts`: `prepPack: … runnerFor("generation")` |
| `generation` | `genSentences` / `genTopics` / `genScenarios` / `genTopicsBand` / `genListening`（CLI 教材生成） | `content-gen.ts` | `scripts/generate-content.ts`: `const runner = runnerFor("generation")` |
| `assessment` | `evaluatePlacement`（レベル測定） | `placement.ts` | `index.ts`: `evaluatePlacement: (subs) => evaluatePlacement(subs, runnerFor("assessment"))` |
| `assessment` | `generateMonthlyReport`（月次レビュー） | `assessment.ts` | `index.ts`: `generateMonthlyReport: (data) => generateMonthlyReport(data, runnerFor("assessment"))` |

※ `generateSentenceExplanation`（例文の詳しい文法解説）はタスク文の coaching 列挙（AE添削・振り返り・訳・言い方ヒント・fix/talk解説）に明示されていないが、coach.ts に属する学習支援の**解説系**であり generation/assessment のどちらでもないため coaching に分類する。

**CLI についての注意**: `scripts/generate-content.ts` は独立プロセスで、DB のロール設定を runner に適用する経路を持たない（`applyLlmRoleSettings` を呼ばない）。`runnerFor("generation")` はモジュールロード時の pure-env baseline を返すため、**現行 `defaultRunner` と挙動は同一**（依然として shell の env に従う）。差し替えは将来 DB 適用を足すときのための整合であり、今回は挙動中立。

**ウォームアップの位置づけ（Task 10）**: 上表の4ロールとは別レイヤーの付随機能。runner ロールではなく、**`conversation` ロールの解決先が openai-compat のときだけ**、API リクエスト受信を契機にローカルモデルを温める（240秒スロットル・fire-and-forget・セッションストア非関与）。Claude/Codex は対象外。

## Interfaces（タスク間契約）

- **Task 1（`app/server/llm-provider.ts`）Produces:**
  - `export type LlmRole = "conversation" | "coaching" | "generation" | "assessment"`
  - `export const LLM_ROLES: readonly LlmRole[]`（`["conversation","coaching","generation","assessment"]`）
  - `export type LlmRoleProvider = "inherit" | "claude" | "openai-compat" | "codex"`
  - `export type LlmRoleSetting = { provider: LlmRoleProvider; baseUrl: string | null; model: string | null; codexModel: string | null }`
  - `export function isInheritRole(s: LlmRoleSetting): boolean`
  - `export function roleSettingToSettings(s: LlmRoleSetting): LlmSettings`（inherit 以外専用）
  - 既存 `LlmProvider` / `LlmSettings` / `settingsToEnv` / `selectRunner` は不変。
- **Task 2（`app/server/converse.ts`）Consumes:** Task 1 の型 + 既存 `settingsToEnv`/`selectRunner`。**Produces:**
  - `export function runnerFor(role: LlmRole): ClaudeRunner`（安定参照ラッパ）
  - `export function applyLlmRoleSettings(global: LlmSettings, roles: Record<LlmRole, LlmRoleSetting>, env?: Record<string, string | undefined>): void`
  - `export const defaultRunner: ClaudeRunner`（型不変・conversation ロールへ委譲）
  - `export function getCurrentRunner(role?: LlmRole): ClaudeRunner`（既定 `"conversation"`・後方互換）
  - `export function applyLlmSettings(settings: LlmSettings, env?: Record<string, string | undefined>): void`（後方互換・全ロール inherit で apply）
- **Task 3（`app/server/llm-role-settings-store.ts`・新規 / `app/server/db.ts`）Consumes:** `LlmRole` / `LlmRoleSetting` / `LlmRoleProvider` / `LLM_ROLES`（Task 1）。**Produces:**
  - `export function ensureLlmRoleSettingsSchema(db: Database): void`
  - `export type LlmRoleSettingsStore = { getAll(): Record<LlmRole, LlmRoleSetting>; save(role: LlmRole, s: LlmRoleSetting): void }`
  - `export function makeLlmRoleSettingsStore(db: Database): LlmRoleSettingsStore`
  - `db.ts` の `openDb` が `ensureLlmRoleSettingsSchema` を呼ぶ。
- **Task 4（`app/server/routes/llm-settings.ts`）Consumes:** Task 1 の型。**Produces（additive）:**
  - `LlmSettingsRoutesDeps` に `getLlmRoleSettings: () => Record<LlmRole, LlmRoleSetting>` と `saveLlmRoleSettings: (role: LlmRole, s: LlmRoleSetting) => void` を追加。
  - `GET /api/llm-settings` 応答に `roles: Record<LlmRole, { provider; baseUrl; model; codexModel }>` を additive 追加。
  - `PUT /api/llm-settings/roles` body `{ global?: {provider,baseUrl?,model?,codexModel?}, roles?: Partial<Record<LlmRole, {provider,baseUrl?,model?,codexModel?}>> }` → 同 view + `{applied, error}`（検証失敗は 400）。
  - 旧 `PUT /api/llm-settings`（全体設定）は不変。
  - `__tests__/helpers/route-deps.ts` に新 deps 既定（全 inherit）を追加。
- **Task 5（`app/server/index.ts` / `scripts/generate-content.ts`）Consumes:** Task 2〜4 の全 export。配線 + 起動時 fail-open。
- **Task 6（`app/client/src/api/llm-settings.ts`）Produces:** `LlmRole` / `LLM_ROLES` / `LlmRoleProvider` / `LlmRoleView` / `LlmRoleInput` / `LlmRolesInput`、`LlmSettingsView.roles`、`saveLlmRoleSettings(input)`。
- **Task 7（`app/client/src/i18n.ts`）Produces:** `nav.settings` と `settings` ブロック（EN/JA）。
- **Task 8（`app/client/src/screens/SettingsScreen.tsx`・新規）Consumes:** Task 6・Task 7。
- **Task 9（`app/client/src/App.tsx`）Consumes:** Task 8。settings mode + nav + サイドバー撤去 + props 配線。
- **Task 10（`app/server/providers/openai-compat.ts` / `app/server/llm-warmup.ts`・新規 / `converse.ts` / `routes.ts` / `index.ts`）Consumes:** Task 2（`applyLlmRoleSettings` の解決点）。**Produces:**
  - `export type OpenAICompatWarmConfig = { baseUrl: string; apiKey?: string; model: string }`
  - `export async function warmOpenAICompat(cfg: OpenAICompatWarmConfig, fetchFn?: typeof fetch): Promise<void>`
  - `export function openAICompatWarmTargetFromEnv(env: Record<string, string | undefined>): OpenAICompatWarmConfig | null`
  - `export type Warmup = { setTarget(t: OpenAICompatWarmConfig | null): void; maybeWarm(now?: number): void }`
  - `export function makeWarmup(opts?: { fetchFn?: typeof fetch; windowMs?: number }): Warmup` / `export const conversationWarmup: Warmup`
  - `LlmSettingsRoutesDeps` に `warmLlm: () => void` を追加（makeFetchHandler の受信入口が呼ぶ fire-and-forget フック）。
- **Task 11:** CHANGELOG（v0.18.0）+ README。

---

### Task 1: サーバ — ロール型と写像ヘルパ（`llm-provider.ts`）

**Files:**
- Modify: `app/server/llm-provider.ts`
- Test: `app/server/__tests__/llm-provider.test.ts`（既存に describe 追加）

**Interfaces:**
- Consumes: 既存 `LlmProvider` / `LlmSettings`（同ファイル）
- Produces: `LlmRole` / `LLM_ROLES` / `LlmRoleProvider` / `LlmRoleSetting` / `isInheritRole` / `roleSettingToSettings`

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/llm-provider.test.ts` の末尾に追記する（ファイル冒頭の import に `isInheritRole, roleSettingToSettings, LLM_ROLES` と型 `LlmRoleSetting` を足す）:

```ts
import { LLM_ROLES, isInheritRole, roleSettingToSettings } from "../llm-provider";
import type { LlmRoleSetting } from "../llm-provider";

describe("role settings helpers", () => {
  test("LLM_ROLES は4ロール固定・順序も固定", () => {
    expect([...LLM_ROLES]).toEqual(["conversation", "coaching", "generation", "assessment"]);
  });

  test("isInheritRole は provider==='inherit' のときだけ true", () => {
    const inherit: LlmRoleSetting = { provider: "inherit", baseUrl: null, model: null, codexModel: null };
    const claude: LlmRoleSetting = { provider: "claude", baseUrl: null, model: null, codexModel: null };
    expect(isInheritRole(inherit)).toBe(true);
    expect(isInheritRole(claude)).toBe(false);
  });

  test("roleSettingToSettings は provider/フィールドをそのまま LlmSettings へ写す", () => {
    const rs: LlmRoleSetting = { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null };
    expect(roleSettingToSettings(rs)).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `cd app && bun test __tests__/llm-provider.test.ts`
Expected: FAIL（`isInheritRole`/`roleSettingToSettings`/`LLM_ROLES` が未定義）

- [ ] **Step 3: 最小実装を書く**

`app/server/llm-provider.ts` の先頭 `export type LlmProvider = …` の直後に追記する:

```ts
/** LLM 呼び出しの用途ロール（4つ固定）。各ロールは全体設定を継承(inherit)するか、独自プロバイダを持つ。 */
export type LlmRole = "conversation" | "coaching" | "generation" | "assessment";

/** ロールの走査順（UI テーブルの並びと一致させる）。 */
export const LLM_ROLES: readonly LlmRole[] = ["conversation", "coaching", "generation", "assessment"];

/** ロール別プロバイダ。"inherit" は「全体設定に従う」センチネル。それ以外は LlmProvider の部分集合（"env" はロールでは扱わない）。 */
export type LlmRoleProvider = "inherit" | "claude" | "openai-compat" | "codex";

/** ロール別の永続化設定。APIキーは含めない（.env のみ）。inherit のときフィールドは null。 */
export type LlmRoleSetting = {
  provider: LlmRoleProvider;
  baseUrl: string | null;
  model: string | null;
  codexModel: string | null;
};

/** inherit センチネルか判定する。 */
export function isInheritRole(s: LlmRoleSetting): boolean {
  return s.provider === "inherit";
}

/** 非 inherit のロール設定を settingsToEnv が食える LlmSettings へ写す（inherit では呼ばない前提）。 */
export function roleSettingToSettings(s: LlmRoleSetting): LlmSettings {
  return { provider: s.provider as LlmProvider, baseUrl: s.baseUrl, model: s.model, codexModel: s.codexModel };
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test __tests__/llm-provider.test.ts`
Expected: PASS

- [ ] **Step 5: 型チェック**

Run: `cd app && bun run typecheck`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add app/server/llm-provider.ts app/server/__tests__/llm-provider.test.ts
git commit -m "feat: LLMロール型と写像ヘルパを追加（llm-provider）"
```

---

### Task 2: サーバ — ロール別ランナールーティング（`converse.ts`）

**Files:**
- Modify: `app/server/converse.ts:80-108`（`currentRunner` 初期化 〜 `applyLlmSettings`）
- Test: `app/server/__tests__/converse-runtime.test.ts`（既存に追記）

**Interfaces:**
- Consumes: Task 1（`LlmRole` / `LLM_ROLES` / `LlmRoleSetting` / `isInheritRole` / `roleSettingToSettings`）+ 既存 `settingsToEnv` / `selectRunner`
- Produces: `runnerFor` / `applyLlmRoleSettings` / `defaultRunner`（不変型）/ `getCurrentRunner(role?)` / `applyLlmSettings`（後方互換）

- [ ] **Step 1: 失敗するテストを書く（既定不変の回帰ロック + ロール分離）**

`app/server/__tests__/converse-runtime.test.ts` の import 行を差し替え、末尾に describe を追記する:

```ts
import { applyLlmSettings, applyLlmRoleSettings, getCurrentRunner, runnerFor } from "../converse";
import { LLM_ROLES } from "../llm-provider";
import type { LlmSettings, LlmRole, LlmRoleSetting } from "../llm-provider";
```

```ts
const INHERIT: LlmRoleSetting = { provider: "inherit", baseUrl: null, model: null, codexModel: null };
const allInherit = (): Record<LlmRole, LlmRoleSetting> =>
  Object.fromEntries(LLM_ROLES.map((r) => [r, INHERIT])) as Record<LlmRole, LlmRoleSetting>;

describe("runnerFor / applyLlmRoleSettings ロール別ルーティング", () => {
  afterAll(() => applyLlmSettings(CLAUDE, emptyEnv));

  test("全ロール inherit + global=env なら4ロールとも同一の claude runner に解決する（既定不変）", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner("conversation");
    applyLlmRoleSettings({ provider: "env", baseUrl: null, model: null, codexModel: null }, allInherit(), emptyEnv);
    for (const role of LLM_ROLES) {
      // resolved runner は全ロール同一参照（= claudeRunner）
      expect(getCurrentRunner(role)).toBe(claudeRef);
    }
  });

  test("runnerFor は安定参照（再解決しても同じラッパを返す）", () => {
    const before = runnerFor("coaching");
    applyLlmRoleSettings(
      { provider: "claude", baseUrl: null, model: null, codexModel: null },
      { ...allInherit(), coaching: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null } },
      emptyEnv,
    );
    expect(runnerFor("coaching")).toBe(before);
  });

  test("1ロールだけ openai-compat 上書きすると、そのロールの解決先だけ別参照になり他ロールは inherit(claude) のまま", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner("conversation");
    applyLlmRoleSettings(
      CLAUDE,
      { ...allInherit(), generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null } },
      emptyEnv,
    );
    expect(getCurrentRunner("generation")).not.toBe(claudeRef);
    expect(getCurrentRunner("conversation")).toBe(claudeRef);
    expect(getCurrentRunner("coaching")).toBe(claudeRef);
    expect(getCurrentRunner("assessment")).toBe(claudeRef);
  });

  test("後方互換: applyLlmSettings(global) は全ロールを inherit として global へ解決する", () => {
    applyLlmSettings({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null }, emptyEnv);
    const conv = getCurrentRunner("conversation");
    for (const role of LLM_ROLES) expect(getCurrentRunner(role)).toBe(conv);
  });
});
```

（`afterAll` / `describe` / `CLAUDE` / `emptyEnv` は既存ファイル冒頭で定義済み。`afterAll` は既存 import に含まれている。）

- [ ] **Step 2: テストが落ちることを確認**

Run: `cd app && bun test __tests__/converse-runtime.test.ts`
Expected: FAIL（`applyLlmRoleSettings`/`runnerFor` 未定義、`getCurrentRunner` が role 引数を取らない）

- [ ] **Step 3: 最小実装を書く**

`app/server/converse.ts` の import を差し替える（2 行目）:

```ts
import {
  selectRunner, settingsToEnv, roleSettingToSettings, isInheritRole, LLM_ROLES,
  type LlmSettings, type LlmRole, type LlmRoleSetting,
} from "./llm-provider";
```

`app/server/converse.ts:80-108`（`const claudeRunner = …` 〜 `applyLlmSettings` の閉じ括弧）を次で置き換える:

```ts
const claudeRunner = makeClaudeRunner(query);

/** env を渡して runner を1つ解決する薄いヘルパ（env 省略で Bun.env・= 現行の初期化と同一）。 */
function resolveRunner(env?: Record<string, string | undefined>): ClaudeRunner {
  return selectRunner({
    claudeRunner,
    defaultSystemPrompt: PARTNER_SYSTEM_PROMPT,
    ...(env ? { env } : {}),
  });
}

/**
 * ロール別の「現在解決済み runner」。モジュールロード時は全ロール pure-env baseline
 * （env/claude では resolveRunner が同一の claudeRunner を返すので、全ロール同一参照＝現行と完全一致）。
 */
const currentRunners = new Map<LlmRole, ClaudeRunner>(LLM_ROLES.map((r) => [r, resolveRunner()]));

/**
 * ロール別の「安定参照ラッパ」。呼び出し側（index.ts の runnerFor(role)）はこのラッパを保持し続け、
 * applyLlmRoleSettings による currentRunners 差し替えが再起動なしで反映される。
 */
const roleWrappers = new Map<LlmRole, ClaudeRunner>(
  LLM_ROLES.map((r) => [r, (prompt: string, resumeId?: string, opts?: { systemPrompt?: string }) =>
    currentRunners.get(r)!(prompt, resumeId, opts)]),
);

/** ロールに紐づく安定参照ランナーを返す（index.ts の各呼び出し側がこれを注入する）。 */
export function runnerFor(role: LlmRole): ClaudeRunner {
  return roleWrappers.get(role)!;
}

/**
 * 後方互換の全ドメイン既定ランナー（conversation ロールへ委譲する安定参照）。
 * 各ドメイン関数の `runner: ClaudeRunner = defaultRunner` 既定はこのまま（実運用の配線は index.ts が runnerFor(role) を渡す）。
 */
export const defaultRunner: ClaudeRunner = (prompt, resumeId, opts) =>
  currentRunners.get("conversation")!(prompt, resumeId, opts);

/** 指定ロールの解決済み runner を返す（診断・テスト用のシーム）。既定は conversation（後方互換）。 */
export function getCurrentRunner(role: LlmRole = "conversation"): ClaudeRunner {
  return currentRunners.get(role)!;
}

/**
 * 全体設定 + ロール別設定から4ロールの runner を一括再解決する（再起動不要）。
 * inherit ロールは global の runner を共有参照する（= 全 inherit なら全ロール同一参照）。
 * APIキーは env（.env）由来のみ（settingsToEnv が担保）。不正 provider 等では selectRunner が throw しうるため、
 * 起動時適用側（index.ts）とルート層で fail-open ガードする。
 */
export function applyLlmRoleSettings(
  global: LlmSettings,
  roles: Record<LlmRole, LlmRoleSetting>,
  env: Record<string, string | undefined> = Bun.env,
): void {
  const globalRunner = resolveRunner(settingsToEnv(global, env));
  for (const role of LLM_ROLES) {
    const rs = roles[role];
    currentRunners.set(
      role,
      isInheritRole(rs) ? globalRunner : resolveRunner(settingsToEnv(roleSettingToSettings(rs), env)),
    );
  }
}

/**
 * 後方互換: 全体設定のみを適用する（全ロール inherit として apply）。
 * 既存の起動時適用・テストがこの形で呼ぶ。ロール別上書きを保持したい配線は index.ts 側で
 * applyLlmRoleSettings(global, roleStore.getAll()) を使う。
 */
export function applyLlmSettings(
  settings: LlmSettings,
  env: Record<string, string | undefined> = Bun.env,
): void {
  const allInherit = Object.fromEntries(
    LLM_ROLES.map((r) => [r, { provider: "inherit" as const, baseUrl: null, model: null, codexModel: null }]),
  ) as Record<LlmRole, LlmRoleSetting>;
  applyLlmRoleSettings(settings, allInherit, env);
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test __tests__/converse-runtime.test.ts`
Expected: PASS（既存の「openai-compat 適用で別参照 / env リセットで claude 同一参照」も含めて緑）

- [ ] **Step 5: 型チェック**

Run: `cd app && bun run typecheck`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add app/server/converse.ts app/server/__tests__/converse-runtime.test.ts
git commit -m "feat: ロール別ランナールーティング（runnerFor / applyLlmRoleSettings）"
```

---

### Task 3: サーバ — ロール別設定ストアと openDb 配線

**Files:**
- Create: `app/server/llm-role-settings-store.ts`
- Modify: `app/server/db.ts:12`（import 追加）, `app/server/db.ts:68-69`（openDb に ensure 追加）
- Test: Create `app/server/__tests__/llm-role-settings-store.test.ts`, Modify `app/server/__tests__/db.test.ts`（テーブル存在アサーション追加）

**Interfaces:**
- Consumes: Task 1（`LlmRole` / `LlmRoleSetting` / `LlmRoleProvider` / `LLM_ROLES`）
- Produces: `ensureLlmRoleSettingsSchema` / `LlmRoleSettingsStore` / `makeLlmRoleSettingsStore`

- [ ] **Step 1: 失敗するテストを書く（ストア）**

Create `app/server/__tests__/llm-role-settings-store.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureLlmRoleSettingsSchema, makeLlmRoleSettingsStore } from "../llm-role-settings-store";

function freshStore() {
  const db = new Database(":memory:");
  ensureLlmRoleSettingsSchema(db);
  return makeLlmRoleSettingsStore(db);
}

describe("llm-role-settings-store", () => {
  test("getAll: 未設定なら4ロールとも inherit を返す", () => {
    const store = freshStore();
    const all = store.getAll();
    expect(Object.keys(all).sort()).toEqual(["assessment", "coaching", "conversation", "generation"]);
    for (const role of Object.keys(all) as Array<keyof typeof all>) {
      expect(all[role]).toEqual({ provider: "inherit", baseUrl: null, model: null, codexModel: null });
    }
  });

  test("save→getAll: 保存したロールだけ反映され、他は inherit のまま", () => {
    const store = freshStore();
    store.save("conversation", { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
    const all = store.getAll();
    expect(all.conversation).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
    expect(all.coaching).toEqual({ provider: "inherit", baseUrl: null, model: null, codexModel: null });
  });

  test("save: 同一ロールは upsert（provider='inherit' で inherit へ戻せる・DELETE を使わない）", () => {
    const store = freshStore();
    store.save("generation", { provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" });
    store.save("generation", { provider: "inherit", baseUrl: null, model: null, codexModel: null });
    expect(store.getAll().generation).toEqual({ provider: "inherit", baseUrl: null, model: null, codexModel: null });
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `cd app && bun test __tests__/llm-role-settings-store.test.ts`
Expected: FAIL（モジュール未作成）

- [ ] **Step 3: ストアを実装する**

Create `app/server/llm-role-settings-store.ts`:

```ts
import type { Database } from "bun:sqlite";
import { LLM_ROLES, type LlmRole, type LlmRoleProvider, type LlmRoleSetting } from "./llm-provider";

/**
 * ロール別 LLM 設定の永続化（role 主キーの複数行）。全体設定の llm_settings（単一行）とは別テーブル。
 * 既存 DB への影響なし（CREATE IF NOT EXISTS のみ・ALTER しない）。row 不在のロールは inherit とみなす。
 * APIキーは持たない（.env のみ）。
 */
export function ensureLlmRoleSettingsSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS llm_role_settings (
    role TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    base_url TEXT,
    model TEXT,
    codex_model TEXT,
    updated_at TEXT NOT NULL
  )`);
}

export type LlmRoleSettingsStore = {
  /** 4ロール分を必ず返す。未設定ロールは { provider: "inherit", … null } を埋める。 */
  getAll(): Record<LlmRole, LlmRoleSetting>;
  /** 1ロールを upsert（provider="inherit" で inherit へ戻す。DELETE は使わない）。妥当性は route が保証する。 */
  save(role: LlmRole, s: LlmRoleSetting): void;
};

type Row = { role: string; provider: string; base_url: string | null; model: string | null; codex_model: string | null };

export function makeLlmRoleSettingsStore(db: Database): LlmRoleSettingsStore {
  return {
    getAll() {
      const rows = db
        .query<Row, []>("SELECT role, provider, base_url, model, codex_model FROM llm_role_settings")
        .all();
      const byRole = new Map(rows.map((r) => [r.role, r]));
      const out = {} as Record<LlmRole, LlmRoleSetting>;
      for (const role of LLM_ROLES) {
        const r = byRole.get(role);
        out[role] = r
          ? { provider: r.provider as LlmRoleProvider, baseUrl: r.base_url, model: r.model, codexModel: r.codex_model }
          : { provider: "inherit", baseUrl: null, model: null, codexModel: null };
      }
      return out;
    },
    save(role, s) {
      db.run(
        `INSERT INTO llm_role_settings (role, provider, base_url, model, codex_model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(role) DO UPDATE SET
           provider = excluded.provider,
           base_url = excluded.base_url,
           model = excluded.model,
           codex_model = excluded.codex_model,
           updated_at = excluded.updated_at`,
        [role, s.provider, s.baseUrl, s.model, s.codexModel, new Date().toISOString()],
      );
    },
  };
}
```

- [ ] **Step 4: ストアテストが通ることを確認**

Run: `cd app && bun test __tests__/llm-role-settings-store.test.ts`
Expected: PASS

- [ ] **Step 5: openDb に配線する（失敗するアサーションを先に書く）**

`app/server/__tests__/db.test.ts` に、`openDb(":memory:")` で `llm_role_settings` テーブルが作られることを確認する test を追記する（既存の import/describe に合わせて追加。テーブル存在は sqlite_master で確認）:

```ts
test("openDb: llm_role_settings テーブルを作成する", () => {
  const db = openDb(":memory:");
  const row = db
    .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get("llm_role_settings");
  expect(row?.name).toBe("llm_role_settings");
});
```

Run: `cd app && bun test __tests__/db.test.ts`
Expected: FAIL（openDb がまだ ensure を呼ばない）

- [ ] **Step 6: openDb を配線する**

`app/server/db.ts:12` の import 群に追加:

```ts
import { ensureLlmRoleSettingsSchema } from "./llm-role-settings-store";
```

`app/server/db.ts` の `openDb` 内、`ensureLlmSettingsSchema(db);`（68 行目）の直後に追加:

```ts
  ensureLlmRoleSettingsSchema(db);
```

- [ ] **Step 7: db テストが通ることを確認**

Run: `cd app && bun test __tests__/db.test.ts __tests__/llm-role-settings-store.test.ts`
Expected: PASS

- [ ] **Step 8: 型チェック**

Run: `cd app && bun run typecheck`
Expected: エラーなし

- [ ] **Step 9: コミット**

```bash
git add app/server/llm-role-settings-store.ts app/server/db.ts app/server/__tests__/llm-role-settings-store.test.ts app/server/__tests__/db.test.ts
git commit -m "feat: ロール別LLM設定ストア（llm_role_settings）とopenDb配線"
```

---

### Task 4: サーバ — ルート additive 拡張（GET roles + PUT /roles）

**Files:**
- Modify: `app/server/routes/llm-settings.ts`（全面）
- Modify: `app/server/__tests__/helpers/route-deps.ts`（新 deps 既定を追加）
- Test: `app/server/__tests__/routes-llm-settings.test.ts`（既存 GET を additive 更新 + 新テスト追加）

**Interfaces:**
- Consumes: Task 1（`LlmRole` / `LlmRoleSetting` / `LlmRoleProvider` / `LLM_ROLES`）
- Produces: `LlmSettingsRoutesDeps` に `getLlmRoleSettings` / `saveLlmRoleSettings`、GET に `roles`、`PUT /api/llm-settings/roles`

- [ ] **Step 1: フェイク deps に新フィールド既定を足す**

`app/server/__tests__/helpers/route-deps.ts` の `makeTestDeps` 内、`getLlmSettings: () => null,`（192 行目付近）の直後に追加する。まずファイル冒頭の import に型を足す:

```ts
import type { LlmRole, LlmRoleSetting } from "../../llm-provider";
```

`makeTestDeps` 内 `saveLlmSettings: (_s) => {},` の直後に追加:

```ts
    getLlmRoleSettings: (): Record<LlmRole, LlmRoleSetting> => ({
      conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
    }),
    saveLlmRoleSettings: (_role, _s) => {},
```

- [ ] **Step 2: 既存 GET テストを additive 更新し、新テストを書く（失敗する）**

`app/server/__tests__/routes-llm-settings.test.ts` の 2 つの GET `toEqual` に `roles` を追加する。1 つ目（未設定）の期待値を差し替え:

```ts
    expect(await res.json()).toEqual({
      provider: "env", baseUrl: null, model: null, codexModel: null,
      apiKeyConfigured: false, envProvider: "claude",
      roles: {
        conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
    });
```

2 つ目（保存済み openai-compat）の期待値も同様に `roles`（全 inherit）を追加する。次に末尾へ新 describe を追記:

```ts
describe("llm-settings roles API", () => {
  test("GET: 保存済みロール上書きを roles に反映する", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmRoleSettings: () => ({
        conversation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null },
        coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      }),
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    expect((await res.json()).roles.conversation).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
  });

  test("PUT /roles: 個別ロール上書きを保存し applied:true を返す", async () => {
    const savedRoles: Array<{ role: string; s: LlmSettings & { provider: string } }> = [];
    const appliedGlobals: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleSettings: (role, s) => savedRoles.push({ role, s: s as never }),
      applyLlmSettings: (s) => appliedGlobals.push(s),
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      roles: { generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3" } },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: true, error: null });
    expect(savedRoles).toEqual([{ role: "generation", s: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null } }]);
    // 保存後に「現在の全体設定 + 保存済みロール」で再解決する（effectiveGlobal は未設定→env）
    expect(appliedGlobals).toEqual([{ provider: "env", baseUrl: null, model: null, codexModel: null }]);
  });

  test("PUT /roles: global も同時に更新できる（全体設定 + ロールを一括保存）", async () => {
    const savedGlobals: LlmSettings[] = [];
    const savedRoles: string[] = [];
    let current: LlmSettings | null = null;
    const { deps } = makeTestDeps({
      getLlmSettings: () => current,
      saveLlmSettings: (s) => { savedGlobals.push(s); current = s; },
      saveLlmRoleSettings: (role) => savedRoles.push(role),
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      global: { provider: "env" },
      roles: {
        conversation: { provider: "inherit" }, coaching: { provider: "inherit" },
        generation: { provider: "inherit" }, assessment: { provider: "inherit" },
      },
    }));
    expect(savedGlobals).toEqual([{ provider: "env", baseUrl: null, model: null, codexModel: null }]);
    expect(savedRoles.sort()).toEqual(["assessment", "conversation", "coaching", "generation"]);
  });

  test("PUT /roles 400: 未知ロール・不正 provider・openai-compat の欠落（保存しない）", async () => {
    const saved: string[] = [];
    const { deps } = makeTestDeps({
      saveLlmRoleSettings: (role) => saved.push(role), getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    const h = makeFetchHandler(deps);
    expect((await h(putJson("/api/llm-settings/roles", { roles: { unknownRole: { provider: "claude" } } }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings/roles", { roles: { coaching: { provider: "env" } } }))).status).toBe(400); // env はロール不可
    expect((await h(putJson("/api/llm-settings/roles", { roles: { coaching: { provider: "openai-compat", model: "m" } } }))).status).toBe(400);
    expect(saved).toHaveLength(0);
  });
});
```

（`LlmSettings` は既存 import 済み。）

- [ ] **Step 3: テストが落ちることを確認**

Run: `cd app && bun test __tests__/routes-llm-settings.test.ts`
Expected: FAIL（GET に roles が無い / `/roles` 404 / deps 未対応）

- [ ] **Step 4: ルートを実装する（全面差し替え）**

`app/server/routes/llm-settings.ts` を次で置き換える:

```ts
import { json, parseJsonBody, exact, type RouteEntry } from "./http";
import { LLM_ROLES, type LlmSettings, type LlmProvider, type LlmRole, type LlmRoleProvider, type LlmRoleSetting } from "../llm-provider";

export type LlmSettingsRoutesDeps = {
  getLlmSettings: () => LlmSettings | null;
  saveLlmSettings: (s: LlmSettings) => void;
  getLlmRoleSettings: () => Record<LlmRole, LlmRoleSetting>;
  saveLlmRoleSettings: (role: LlmRole, s: LlmRoleSetting) => void;
  applyLlmSettings: (s: LlmSettings) => void;
  /** env 由来の情報。値そのものは返さず、APIキーは presence(boolean) のみ。 */
  llmEnv: () => { provider: string; apiKeyConfigured: boolean };
};

const PROVIDERS = ["env", "claude", "openai-compat", "codex"] as const;
const ROLE_PROVIDERS = ["inherit", "claude", "openai-compat", "codex"] as const;

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

type SettingsInput = { provider?: unknown; baseUrl?: unknown; model?: unknown; codexModel?: unknown };
type ParsedSettings = { provider: string; baseUrl: string | null; model: string | null; codexModel: string | null };

/**
 * 全体設定/ロール設定の共通バリデータ。allowed で provider 集合を切替（全体=env含む・ロール=inherit含む）。
 * openai-compat は baseUrl(http(s)) + model 必須、codex は codexModel 任意、それ以外はフィールドなし。
 */
function parseSettingsInput(
  b: SettingsInput,
  allowed: readonly string[],
): { ok: true; value: ParsedSettings } | { ok: false; error: string } {
  if (typeof b.provider !== "string" || !allowed.includes(b.provider)) {
    return { ok: false, error: `provider must be one of ${allowed.join(", ")}` };
  }
  if (b.provider === "openai-compat") {
    const baseUrl = asOptionalStr(b.baseUrl, 500);
    if (!baseUrl || !isHttpUrl(baseUrl)) return { ok: false, error: "baseUrl must be a valid http(s) URL for openai-compat" };
    const model = asOptionalStr(b.model, 200);
    if (!model) return { ok: false, error: "model is required for openai-compat" };
    return { ok: true, value: { provider: "openai-compat", baseUrl, model, codexModel: null } };
  }
  if (b.provider === "codex") {
    const codexModel = asOptionalStr(b.codexModel, 200);
    if (codexModel === undefined) return { ok: false, error: "codexModel must be a string of at most 200 characters" };
    return { ok: true, value: { provider: "codex", baseUrl: null, model: null, codexModel } };
  }
  // env / claude / inherit: 付随フィールドは持たない
  return { ok: true, value: { provider: b.provider, baseUrl: null, model: null, codexModel: null } };
}

/** GET と PUT 応答の共通ビュー。APIキー値は決して含めない（有無の boolean のみ）。roles は additive。 */
function viewOf(deps: LlmSettingsRoutesDeps, applied?: boolean, error?: string | null) {
  const stored = deps.getLlmSettings();
  const env = deps.llmEnv();
  const s: LlmSettings = stored ?? { provider: "env", baseUrl: null, model: null, codexModel: null };
  const roleSettings = deps.getLlmRoleSettings();
  const roles = {} as Record<LlmRole, { provider: LlmRoleProvider; baseUrl: string | null; model: string | null; codexModel: string | null }>;
  for (const role of LLM_ROLES) {
    const r = roleSettings[role];
    roles[role] = { provider: r.provider, baseUrl: r.baseUrl, model: r.model, codexModel: r.codexModel };
  }
  return {
    provider: s.provider,
    baseUrl: s.baseUrl,
    model: s.model,
    codexModel: s.codexModel,
    apiKeyConfigured: env.apiKeyConfigured,
    envProvider: env.provider,
    roles,
    ...(applied === undefined ? {} : { applied }),
    ...(error === undefined ? {} : { error }),
  };
}

/** 「現在の全体設定 + 保存済みロール」で全ロール runner を再解決する。fail-open で applied/error を返す。 */
function applyResolved(deps: LlmSettingsRoutesDeps): { applied: boolean; error: string | null } {
  const effectiveGlobal = deps.getLlmSettings() ?? { provider: "env" as LlmProvider, baseUrl: null, model: null, codexModel: null };
  try {
    deps.applyLlmSettings(effectiveGlobal);
    return { applied: true, error: null };
  } catch (err) {
    return { applied: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type Body = { provider?: unknown; baseUrl?: unknown; model?: unknown; codexModel?: unknown };

async function handlePut(req: Request, deps: LlmSettingsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<Body>(req);
  if (!parsed.ok) return parsed.response;
  const g = parseSettingsInput(parsed.body, PROVIDERS);
  if (!g.ok) return json({ error: g.error }, 400);

  deps.saveLlmSettings({
    provider: g.value.provider as LlmProvider,
    baseUrl: g.value.baseUrl,
    model: g.value.model,
    codexModel: g.value.codexModel,
  });
  // fail-open: 検証済み入力は基本 throw しないが、万一失敗しても「保存は成功」として applied:false + error を返す。
  const { applied, error } = applyResolved(deps);
  return json(viewOf(deps, applied, error));
}

async function handlePutRoles(req: Request, deps: LlmSettingsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ global?: unknown; roles?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  // 任意: 全体設定も同時更新（プリセット「すべて既定に戻す」で env にリセットする用途）
  if (body.global !== undefined) {
    if (typeof body.global !== "object" || body.global === null) return json({ error: "global must be an object" }, 400);
    const g = parseSettingsInput(body.global as SettingsInput, PROVIDERS);
    if (!g.ok) return json({ error: g.error }, 400);
    deps.saveLlmSettings({
      provider: g.value.provider as LlmProvider,
      baseUrl: g.value.baseUrl,
      model: g.value.model,
      codexModel: g.value.codexModel,
    });
  }

  // ロール別上書き（各値は inherit|claude|openai-compat|codex）
  if (body.roles !== undefined) {
    if (typeof body.roles !== "object" || body.roles === null) return json({ error: "roles must be an object" }, 400);
    const rolesObj = body.roles as Record<string, unknown>;
    for (const role of Object.keys(rolesObj)) {
      if (!(LLM_ROLES as readonly string[]).includes(role)) return json({ error: `unknown role: ${role}` }, 400);
      const rv = rolesObj[role];
      if (typeof rv !== "object" || rv === null) return json({ error: `role ${role} must be an object` }, 400);
      const p = parseSettingsInput(rv as SettingsInput, ROLE_PROVIDERS);
      if (!p.ok) return json({ error: `${role}: ${p.error}` }, 400);
      deps.saveLlmRoleSettings(role as LlmRole, {
        provider: p.value.provider as LlmRoleProvider,
        baseUrl: p.value.baseUrl,
        model: p.value.model,
        codexModel: p.value.codexModel,
      });
    }
  }

  const { applied, error } = applyResolved(deps);
  return json(viewOf(deps, applied, error));
}

export function makeLlmSettingsRoutes(deps: LlmSettingsRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/llm-settings", () => json(viewOf(deps))),
    exact("PUT", "/api/llm-settings", (req) => handlePut(req, deps)),
    exact("PUT", "/api/llm-settings/roles", (req) => handlePutRoles(req, deps)),
  ];
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `cd app && bun test __tests__/routes-llm-settings.test.ts`
Expected: PASS（既存 PUT テスト・GET additive 更新・新 roles テスト全緑）

- [ ] **Step 6: 型チェック**

Run: `cd app && bun run typecheck`
Expected: エラーなし

- [ ] **Step 7: コミット**

```bash
git add app/server/routes/llm-settings.ts app/server/__tests__/helpers/route-deps.ts app/server/__tests__/routes-llm-settings.test.ts
git commit -m "feat: LLM設定APIにロール別ルート（GET roles + PUT /roles）をadditive追加"
```

---

### Task 5: サーバ — index.ts 配線と CLI の runner 差し替え

**Files:**
- Modify: `app/server/index.ts`（import・realDeps 配線・起動時 fail-open）
- Modify: `scripts/generate-content.ts`（runner 変数）

**Interfaces:**
- Consumes: Task 2（`runnerFor` / `applyLlmRoleSettings`）, Task 3（`makeLlmRoleSettingsStore`）, Task 4（新 deps フィールド）
- Produces: なし（合成ルート = typecheck + 既存テストで担保）

- [ ] **Step 1: import を差し替える**

`app/server/index.ts:4` を差し替え:

```ts
import { converseTurn, applyLlmRoleSettings, runnerFor } from "./converse";
```

`app/server/index.ts:23`（`makeLlmSettingsStore` の import 行）の直後に追加:

```ts
import { makeLlmRoleSettingsStore } from "./llm-role-settings-store";
```

- [ ] **Step 2: ストアを1つ増やす**

`app/server/index.ts:40`（`const llmSettingsStore = makeLlmSettingsStore(db);`）の直後に追加:

```ts
const llmRoleSettingsStore = makeLlmRoleSettingsStore(db);
```

- [ ] **Step 3: realDeps の runner を runnerFor(role) に機械的差し替え**

`app/server/index.ts` の `realDeps` 内、次の各行を置き換える（対応表どおり）:

`converse: converseTurn,` →
```ts
  converse: (args) => converseTurn({ ...args, runner: runnerFor("conversation") }),
```

`aeFeedback: (args) => generateAeFeedback({ ...args, stage: stageOf(progressStore.getLevel()) }),` →
```ts
  aeFeedback: (args) => generateAeFeedback({ ...args, stage: stageOf(progressStore.getLevel()) }, runnerFor("coaching")),
```

`modelTalk` の中の `generateModelTalk({ … })` を →
```ts
    const talk = await generateModelTalk({ topicTitle: topic.title, hints: topic.hints, stage: stageOf(progressStore.getLevel()) }, runnerFor("generation"));
```

`reflection: () => generateReflection({ events: readEvents(sessionLogPath(new Date())) }),` →
```ts
  reflection: () => generateReflection({ events: readEvents(sessionLogPath(new Date())) }, runnerFor("coaching")),
```

`prepPack` の中の `return generatePrepPack({ … });` を →
```ts
    return generatePrepPack({ topicTitle: topic.title, hints: topic.hints, chunkCount: p.chunkCount, hintLang: p.hintLang, stage }, runnerFor("generation"));
```

`evaluatePlacement: (subs) => evaluatePlacement(subs),` →
```ts
  evaluatePlacement: (subs) => evaluatePlacement(subs, runnerFor("assessment")),
```

`explainSentence: (s) => generateSentenceExplanation(s),` →
```ts
  explainSentence: (s) => generateSentenceExplanation(s, runnerFor("coaching")),
```

`explainTalk: (text) => generateTalkExplanation({ text }),` →
```ts
  explainTalk: (text) => generateTalkExplanation({ text }, runnerFor("coaching")),
```

`translate: (text) => generateUtteranceTranslation({ text }),` →
```ts
  translate: (text) => generateUtteranceTranslation({ text }, runnerFor("coaching")),
```

`phraseHint: (args) => generatePhraseHints(args),` →
```ts
  phraseHint: (args) => generatePhraseHints(args, runnerFor("coaching")),
```

`fixExplain: (args) => generateFixExplanation(args),` →
```ts
  fixExplain: (args) => generateFixExplanation(args, runnerFor("coaching")),
```

`generateMonthlyReport: (data) => generateMonthlyReport(data),` →
```ts
  generateMonthlyReport: (data) => generateMonthlyReport(data, runnerFor("assessment")),
```

- [ ] **Step 4: LLM 設定 deps を追加し、applyLlmSettings をロール対応にする**

`app/server/index.ts` の realDeps 内、`saveLlmSettings: (s) => llmSettingsStore.save(s),` の直後に追加:

```ts
  getLlmRoleSettings: () => llmRoleSettingsStore.getAll(),
  saveLlmRoleSettings: (role, s) => llmRoleSettingsStore.save(role, s),
```

同じく realDeps 内の `applyLlmSettings: (s) => applyLlmSettings(s),` を差し替える（全体設定変更時も**保存済みロール上書きを保持**して再解決する）:

```ts
  applyLlmSettings: (s) => applyLlmRoleSettings(s, llmRoleSettingsStore.getAll()),
```

- [ ] **Step 5: 起動時 fail-open をロール対応にする**

`app/server/index.ts` の起動時ブロック（`const savedLlm = llmSettingsStore.get();` 〜 `}`）を差し替える:

```ts
// 起動時: DB に LLM 設定（全体 or ロール上書き）があれば実行中プロセスへ適用する（fail-open）。
// 全体行が無く全ロール inherit のままなら何もせず、converse.ts のモジュールロード時 env 既定（= 現行と完全同一）を維持する。
const savedLlm = llmSettingsStore.get();
const savedRoles = llmRoleSettingsStore.getAll();
const hasRoleOverride = Object.values(savedRoles).some((r) => r.provider !== "inherit");
if (savedLlm || hasRoleOverride) {
  try {
    applyLlmRoleSettings(savedLlm ?? { provider: "env", baseUrl: null, model: null, codexModel: null }, savedRoles);
  } catch (err) {
    console.warn(`[llm] failed to apply saved settings, falling back to environment/claude: ${String(err)}`);
  }
}
```

- [ ] **Step 6: CLI の runner を generation ロールに差し替える**

`scripts/generate-content.ts:15` を差し替え:

```ts
import { runnerFor } from "../app/server/converse";
```

`scripts/generate-content.ts:22` を差し替え:

```ts
const runner = runnerFor("generation");
```

- [ ] **Step 7: 型チェックと全テスト**

Run: `cd app && bun run typecheck && bun test`
Expected: エラーなし・全テスト緑（既存 routes/converse テストが realDeps 変更後も緑であることを確認）

- [ ] **Step 8: コミット**

```bash
git add app/server/index.ts scripts/generate-content.ts
git commit -m "feat: index.tsとgenerate-content CLIで各呼び出しをrunnerFor(role)へ配線"
```

---

### Task 6: クライアント — LLM 設定 API にロール型を追加

**Files:**
- Modify: `app/client/src/api/llm-settings.ts`

**Interfaces:**
- Produces: `LlmRole` / `LLM_ROLES` / `LlmRoleProvider` / `LlmRoleView` / `LlmRoleInput` / `LlmRolesInput`、`LlmSettingsView.roles`、`saveLlmRoleSettings(input)`

- [ ] **Step 1: 型と関数を additive 追加する**

`app/client/src/api/llm-settings.ts` の `export type LlmProvider = …` の直後に追加:

```ts
export type LlmRole = "conversation" | "coaching" | "generation" | "assessment";
export const LLM_ROLES: readonly LlmRole[] = ["conversation", "coaching", "generation", "assessment"];
export type LlmRoleProvider = "inherit" | "claude" | "openai-compat" | "codex";

export type LlmRoleView = {
  provider: LlmRoleProvider;
  baseUrl: string | null;
  model: string | null;
  codexModel: string | null;
};
```

`LlmSettingsView` に `roles` フィールドを追加する（`error?` の後に）:

```ts
  /** ロール別の現在設定（未設定ロールは provider:"inherit"）。 */
  roles: Record<LlmRole, LlmRoleView>;
```

ファイル末尾に追加:

```ts
export type LlmRoleInput = {
  provider: LlmRoleProvider;
  baseUrl?: string | null;
  model?: string | null;
  codexModel?: string | null;
};

/** ロール別設定の一括更新。global を含めると全体設定も同時に保存する（プリセット用）。 */
export type LlmRolesInput = {
  global?: LlmSettingsInput;
  roles?: Partial<Record<LlmRole, LlmRoleInput>>;
};

export async function saveLlmRoleSettings(input: LlmRolesInput): Promise<LlmSettingsView> {
  const res = await fetch("/api/llm-settings/roles", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`llm role settings save failed: ${await extractErrorMessage(res)}`);
  return res.json();
}
```

- [ ] **Step 2: ビルド（型チェック）**

Run: `cd app/client && bun run build`
Expected: 成功（`api/index.ts` の `export * from "./llm-settings"` で新 export がバレルに載る）

- [ ] **Step 3: コミット**

```bash
git add app/client/src/api/llm-settings.ts
git commit -m "feat: クライアントLLM API にロール型と saveLlmRoleSettings を追加"
```

---

### Task 7: クライアント — i18n（nav.settings + settings ブロック）

**Files:**
- Modify: `app/client/src/i18n.ts`

**Interfaces:**
- Consumes: Task 6（`LlmRole`）
- Produces: `nav.settings` / `settings` ブロック（EN/JA）

- [ ] **Step 1: 型を追加する**

`app/client/src/i18n.ts` 冒頭に型 import を追加（`export type Lang` の直後）:

```ts
import type { LlmRole } from "./api/llm-settings";
```

`NavStrings` の `nav` に `settings: string;` を追加する（`feedback: string;` の後）:

```ts
type NavStrings = {
  nav: {
    home: string; placement: string; free: string; library: string; sentences: string; listening: string; progress: string; feedback: string; settings: string;
    sectionToday: string; sectionSelf: string; sectionRecords: string; selfStudyHint: string;
  };
};
```

`LlmPanelStrings` の直後に新しい型を追加:

```ts
type SettingsStrings = {
  settings: {
    title: string;
    llmSection: string;
    connectionTitle: string;
    presetTitle: string;
    recommendApply: string;
    recommendDesc: string;
    recommendDisabled: string;
    resetApply: string;
    resetDesc: string;
    rolesTitle: string;
    rolesSummary: string;
    roleName: Record<LlmRole, string>;
    roleDesc: Record<LlmRole, string>;
    optInherit: string;
    saveRoles: string;
    displaySection: string;
  };
};
```

`type Strings =` の交差に `& SettingsStrings` を追加（末尾 `& LlmPanelStrings;` を `& LlmPanelStrings & SettingsStrings;` に）。

- [ ] **Step 2: EN 文言を追加する**

`STR.en` の `nav` に `settings: "Settings",` を追加（`feedback: "Feedback",` の後）。`STR.en.llm` ブロックの直後に追加:

```ts
    settings: {
      title: "Settings",
      llmSection: "Language model",
      connectionTitle: "Overall provider",
      presetTitle: "Quick setup",
      recommendApply: "Apply recommended setup",
      recommendDesc: "Use your local model for casual conversation and keep the tested default for coaching, content, and assessment.",
      recommendDisabled: "Connect a local LLM above first to enable the recommended setup.",
      resetApply: "Reset everything to default",
      resetDesc: "Set the overall provider to the environment default and let every role follow it.",
      rolesTitle: "Per-role model (advanced)",
      rolesSummary: "Set a different model per role",
      roleName: {
        conversation: "Conversation",
        coaching: "Coaching",
        generation: "Content generation",
        assessment: "Assessment",
      },
      roleDesc: {
        conversation: "Free talk and role-play replies",
        coaching: "Feedback, reflection, translation, phrasing hints, explanations",
        generation: "Model talks, 4/3/2 prep, generated study material",
        assessment: "Level check and monthly review",
      },
      optInherit: "Follow overall",
      saveRoles: "Save per-role settings",
      displaySection: "Display",
    },
```

- [ ] **Step 3: JA 文言を追加する**

`STR.ja` の `nav` に `settings: "設定",` を追加（`feedback: "フィードバック",` の後）。`STR.ja.llm` ブロックの直後に追加:

```ts
    settings: {
      title: "設定",
      llmSection: "言語モデル",
      connectionTitle: "全体の接続先",
      presetTitle: "かんたん設定",
      recommendApply: "推奨構成を適用",
      recommendDesc: "自由会話はローカルモデルに任せ、添削・教材生成・測定は動作確認済みの既定のままにします。",
      recommendDisabled: "先に上でローカルLLMを接続すると推奨構成が使えます。",
      resetApply: "すべて既定に戻す",
      resetDesc: "全体の接続先を環境変数の既定に戻し、各ロールはそれに従います。",
      rolesTitle: "用途別モデル（詳細）",
      rolesSummary: "ロールごとに別のモデルを指定する",
      roleName: {
        conversation: "会話",
        coaching: "コーチング",
        generation: "教材生成",
        assessment: "測定",
      },
      roleDesc: {
        conversation: "自由会話・ロールプレイの相手応答",
        coaching: "添削・振り返り・訳・言い方ヒント・解説",
        generation: "モデルトーク・4/3/2 準備・生成教材",
        assessment: "レベル測定・月次レビュー",
      },
      optInherit: "全体に従う",
      saveRoles: "用途別設定を保存",
      displaySection: "表示",
    },
```

- [ ] **Step 4: ビルド（型チェック）**

Run: `cd app/client && bun run build`
Expected: 成功（`Strings` 交差に `SettingsStrings` が満たされる）

- [ ] **Step 5: コミット**

```bash
git add app/client/src/i18n.ts
git commit -m "feat: 設定画面のi18n（nav.settings + settingsブロック EN/JA）"
```

---

### Task 8: クライアント — 設定画面 `SettingsScreen`

**Files:**
- Create: `app/client/src/screens/SettingsScreen.tsx`

**Interfaces:**
- Consumes: Task 6（api）, Task 7（i18n）
- Produces: `export function SettingsScreen(props): JSX.Element`
  - props: `{ lang: Lang; uiScale: UiScale; setUiScale: (s: UiScale) => void; switchLang: (l: Lang) => void }`
  - `export type UiScale = "small" | "medium" | "large" | "xlarge"`

- [ ] **Step 1: 画面コンポーネントを実装する**

Create `app/client/src/screens/SettingsScreen.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import {
  fetchLlmSettings, saveLlmSettings, saveLlmRoleSettings, LLM_ROLES,
  type LlmProvider, type LlmRole, type LlmRoleProvider, type LlmRoleView, type LlmSettingsView,
} from "../api";
import { STR, type Lang } from "../i18n";
import { Button } from "../ui/Button";

export type UiScale = "small" | "medium" | "large" | "xlarge";

type Props = {
  lang: Lang;
  uiScale: UiScale;
  setUiScale: (s: UiScale) => void;
  switchLang: (l: Lang) => void;
};

const GLOBAL_PROVIDERS: LlmProvider[] = ["env", "claude", "openai-compat", "codex"];
const ROLE_PROVIDERS: LlmRoleProvider[] = ["inherit", "claude", "openai-compat", "codex"];

/** provider トグル + openai-compat/codex の条件フィールドを描く共有エディタ（全体設定とロール行で再利用）。 */
function ProviderEditor<P extends string>(props: {
  lang: Lang;
  providers: P[];
  labelOf: (p: P) => string;
  value: { provider: P; baseUrl: string | null; model: string | null; codexModel: string | null };
  onChange: (next: { provider: P; baseUrl: string | null; model: string | null; codexModel: string | null }) => void;
  apiKeyConfigured: boolean;
  ariaLabel: string;
}) {
  const t = STR[props.lang].llm;
  const v = props.value;
  return (
    <div className="stack">
      <div className="lang-toggle llm-provider-toggle" role="group" aria-label={props.ariaLabel}>
        {props.providers.map((p) => (
          <button key={p} className={v.provider === p ? "is-active" : ""} onClick={() => props.onChange({ ...v, provider: p })}>
            {props.labelOf(p)}
          </button>
        ))}
      </div>
      {v.provider === "openai-compat" && (
        <div className="llm-fields stack">
          <label className="llm-field">
            <span className="text-sm text-muted">{t.baseUrlLabel}</span>
            <input className="llm-input" value={v.baseUrl ?? ""} placeholder={t.baseUrlPlaceholder} onChange={(e) => props.onChange({ ...v, baseUrl: e.target.value })} />
          </label>
          <label className="llm-field">
            <span className="text-sm text-muted">{t.modelLabel}</span>
            <input className="llm-input" value={v.model ?? ""} placeholder={t.modelPlaceholder} onChange={(e) => props.onChange({ ...v, model: e.target.value })} />
          </label>
          <div className="text-sm text-muted">{props.apiKeyConfigured ? t.apiKeyConfigured : t.apiKeyMissing}</div>
        </div>
      )}
      {v.provider === "codex" && (
        <label className="llm-field">
          <span className="text-sm text-muted">{t.codexModelLabel}</span>
          <input className="llm-input" value={v.codexModel ?? ""} placeholder={t.codexModelPlaceholder} onChange={(e) => props.onChange({ ...v, codexModel: e.target.value })} />
        </label>
      )}
    </div>
  );
}

export function SettingsScreen({ lang, uiScale, setUiScale, switchLang }: Props) {
  const s = STR[lang];
  const [view, setView] = useState<LlmSettingsView | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fetchedRef = useRef(false);

  // 全体設定の編集状態
  const [gProvider, setGProvider] = useState<LlmProvider>("env");
  const [gBaseUrl, setGBaseUrl] = useState("");
  const [gModel, setGModel] = useState("");
  const [gCodex, setGCodex] = useState("");
  // ロール別の編集状態
  const [roles, setRoles] = useState<Record<LlmRole, LlmRoleView>>({
    conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
    coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
    generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
    assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
  });

  function hydrate(v: LlmSettingsView) {
    setView(v);
    setGProvider(v.provider === "env" || v.provider === "claude" || v.provider === "openai-compat" || v.provider === "codex" ? v.provider : "env");
    setGBaseUrl(v.baseUrl ?? "");
    setGModel(v.model ?? "");
    setGCodex(v.codexModel ?? "");
    setRoles(v.roles);
  }

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchLlmSettings().then(hydrate).catch(() => {});
  }, []);

  function applyResult(v: LlmSettingsView) {
    hydrate(v);
    setResult(v.applied === false ? s.llm.notApplied(v.error ?? "") : s.llm.applied);
  }

  async function onSaveGlobal() {
    setSaving(true); setResult(null);
    try {
      applyResult(await saveLlmSettings({
        provider: gProvider,
        baseUrl: gProvider === "openai-compat" ? gBaseUrl : null,
        model: gProvider === "openai-compat" ? gModel : null,
        codexModel: gProvider === "codex" ? (gCodex || null) : null,
      }));
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  async function onSaveRoles() {
    setSaving(true); setResult(null);
    try {
      applyResult(await saveLlmRoleSettings({ roles }));
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  async function onRecommended() {
    if (!view || view.provider !== "openai-compat") return;
    setSaving(true); setResult(null);
    try {
      applyResult(await saveLlmRoleSettings({
        roles: {
          conversation: { provider: "openai-compat", baseUrl: view.baseUrl, model: view.model },
          coaching: { provider: "inherit" },
          generation: { provider: "inherit" },
          assessment: { provider: "inherit" },
        },
      }));
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  async function onResetAll() {
    setSaving(true); setResult(null);
    try {
      applyResult(await saveLlmRoleSettings({
        global: { provider: "env" },
        roles: {
          conversation: { provider: "inherit" }, coaching: { provider: "inherit" },
          generation: { provider: "inherit" }, assessment: { provider: "inherit" },
        },
      }));
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  const recommendEnabled = view?.provider === "openai-compat";

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{s.settings.title}</h2>
      </div>

      {/* 言語モデル */}
      <section className="support-panel stack">
        <div className="stat-title">{s.settings.llmSection}</div>

        {/* 全体の接続先（現 LlmPanel 相当） */}
        <div className="stack">
          <div className="support-label-row">
            <div className="text-sm text-muted">{s.settings.connectionTitle}</div>
          </div>
          <ProviderEditor
            lang={lang}
            providers={GLOBAL_PROVIDERS}
            labelOf={(p) => ({ env: s.llm.optEnv, claude: s.llm.optClaude, "openai-compat": s.llm.optOpenai, codex: s.llm.optCodex }[p])}
            value={{ provider: gProvider, baseUrl: gBaseUrl, model: gModel, codexModel: gCodex }}
            onChange={(n) => { setGProvider(n.provider); setGBaseUrl(n.baseUrl ?? ""); setGModel(n.model ?? ""); setGCodex(n.codexModel ?? ""); }}
            apiKeyConfigured={Boolean(view?.apiKeyConfigured)}
            ariaLabel={s.llm.providerLabel}
          />
          {gProvider === "env" && view && <div className="text-sm text-muted">{s.llm.envNote(view.envProvider)}</div>}
          <div className="text-sm text-muted">{s.llm.help}</div>
          <Button variant="secondary" onClick={onSaveGlobal} disabled={saving}>{saving ? s.llm.saving : s.llm.save}</Button>
        </div>

        {/* かんたん設定（プリセット主役） */}
        <div className="stack">
          <div className="stat-title">{s.settings.presetTitle}</div>
          <div className="text-sm text-muted">{s.settings.recommendDesc}</div>
          <Button variant="primary" onClick={onRecommended} disabled={saving || !recommendEnabled}>{s.settings.recommendApply}</Button>
          {!recommendEnabled && <div className="text-sm text-muted">{s.settings.recommendDisabled}</div>}
          <div className="text-sm text-muted">{s.settings.resetDesc}</div>
          <Button variant="secondary" onClick={onResetAll} disabled={saving}>{s.settings.resetApply}</Button>
        </div>

        {/* 用途別モデル（折りたたみ詳細） */}
        <details className="stack">
          <summary className="text-sm text-muted">{s.settings.rolesSummary}</summary>
          <div className="stat-title">{s.settings.rolesTitle}</div>
          {LLM_ROLES.map((role) => (
            <div key={role} className="stack">
              <div className="text-sm">{s.settings.roleName[role]}</div>
              <div className="text-sm text-muted">{s.settings.roleDesc[role]}</div>
              <ProviderEditor
                lang={lang}
                providers={ROLE_PROVIDERS}
                labelOf={(p) => ({ inherit: s.settings.optInherit, claude: s.llm.optClaude, "openai-compat": s.llm.optOpenai, codex: s.llm.optCodex }[p])}
                value={roles[role]}
                onChange={(n) => setRoles((prev) => ({ ...prev, [role]: n }))}
                apiKeyConfigured={Boolean(view?.apiKeyConfigured)}
                ariaLabel={s.settings.roleName[role]}
              />
            </div>
          ))}
          <Button variant="secondary" onClick={onSaveRoles} disabled={saving}>{saving ? s.llm.saving : s.settings.saveRoles}</Button>
        </details>

        {result && <div className="info-pop" role="status">{result}</div>}
      </section>

      {/* 表示 */}
      <section className="support-panel stack">
        <div className="stat-title">{s.settings.displaySection}</div>
        <div className="lang-toggle" role="group" aria-label={s.appShell.textSize}>
          <button className={uiScale === "small" ? "is-active" : ""} onClick={() => setUiScale("small")}>{s.uiScale.small}</button>
          <button className={uiScale === "medium" ? "is-active" : ""} onClick={() => setUiScale("medium")}>{s.uiScale.medium}</button>
          <button className={uiScale === "large" ? "is-active" : ""} onClick={() => setUiScale("large")}>{s.uiScale.large}</button>
          <button className={uiScale === "xlarge" ? "is-active" : ""} onClick={() => setUiScale("xlarge")}>{s.uiScale.xlarge}</button>
        </div>
        <div className="lang-toggle" role="group" aria-label={s.appShell.language}>
          <button className={lang === "en" ? "is-active" : ""} onClick={() => switchLang("en")}>EN</button>
          <button className={lang === "ja" ? "is-active" : ""} onClick={() => switchLang("ja")}>日本語</button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: ビルド（型チェック）**

Run: `cd app/client && bun run build`
Expected: 成功

補足: `app/client/src/ui/Button.tsx` の `variant` は `"primary" | "secondary" | "ghost" | "danger"` を受け付ける（確認済み）。推奨ボタンは `variant="primary"`、他は `variant="secondary"` を使う。

- [ ] **Step 3: コミット**

```bash
git add app/client/src/screens/SettingsScreen.tsx
git commit -m "feat: 設定画面SettingsScreen（LLMロール別設定 + プリセット + 表示設定）"
```

---

### Task 9: クライアント — App.tsx に設定画面を統合しサイドバーを整理

**Files:**
- Modify: `app/client/src/App.tsx`

**Interfaces:**
- Consumes: Task 8（`SettingsScreen` / `UiScale`）
- Produces: なし（build で担保）

- [ ] **Step 1: import を差し替える**

`app/client/src/App.tsx:2-6` の api import から、設定画面へ移設して不要になる `fetchLlmSettings, saveLlmSettings` と型 `LlmProvider, LlmSettingsView` を削除する（他の import はそのまま）。差し替え後:

```tsx
import {
  fetchPracticeDays, fetchProgressSummary, getHealth, onProgressUpdate, progressLevelAction,
  sessionEnd, sessionEndKeepalive, sessionStart,
  type Health, type ProgressSummary,
} from "./api";
```

`import { StartScreen, type StartSelection } from "./screens/StartScreen";` の直後に追加:

```tsx
import { SettingsScreen, type UiScale } from "./screens/SettingsScreen";
```

- [ ] **Step 2: Mode に settings を追加し、uiScale の型を共有型にする**

`type Mode = …` に `| { kind: "settings" }` を追加（`| { kind: "feedback" }` の後）。

`useState<"small" | "medium" | "large" | "xlarge">` の総称を `UiScale` に差し替える:

```tsx
  const [uiScale, setUiScale] = useState<UiScale>(() => {
```

- [ ] **Step 3: nav に「設定」を追加する**

`navItems` 配列の末尾（`feedback` 行の後）に追加:

```tsx
    { key: "settings", icon: "⚙️", label: t.nav.settings, active: mode.kind === "settings", go: () => setMode({ kind: "settings" }), section: "records" },
```

- [ ] **Step 4: サイドバーから LlmPanel と 文字サイズ/言語トグルを撤去する**

`app/client/src/App.tsx` のサイドバー内、次の3ブロックを削除する:

削除1（LlmPanel 描画・129 行目）:
```tsx
        <LlmPanel lang={lang} />
```

削除2（文字サイズトグル・130-135 行目 `<div className="lang-toggle" role="group" aria-label={t.appShell.textSize}> … </div>`）全体。

削除3（言語トグル・136-139 行目 `<div className="lang-toggle" role="group" aria-label={t.appShell.language}> … </div>`）全体。

`<SupportPanel lang={lang} />` と `<PracticeStat lang={lang} />` は残す。削除後のサイドバー末尾は次のようになる:

```tsx
        <div className="sidebar-spacer" />
        <SupportPanel lang={lang} />
        <PracticeStat lang={lang} />
      </aside>
```

- [ ] **Step 5: 設定画面をメインに描画する**

`{mode.kind === "feedback" && <FeedbackScreen lang={lang} />}` の直後に追加:

```tsx
      {mode.kind === "settings" && (
        <SettingsScreen lang={lang} uiScale={uiScale} setUiScale={setUiScale} switchLang={switchLang} />
      )}
```

- [ ] **Step 6: 未使用になった LlmPanel コンポーネント定義を削除する**

`app/client/src/App.tsx` 内の `function LlmPanel({ lang }: { lang: Lang }) { … }` 定義全体（コメント含む 225-330 行目付近）を削除する。ロジックは `SettingsScreen` に移設済み。

- [ ] **Step 7: ビルド（型チェック・未使用 import 検出）**

Run: `cd app/client && bun run build`
Expected: 成功（`fetchLlmSettings` 等の未使用 import が残っていればエラーになるので、残っていれば削除する）

- [ ] **Step 8: 全ゲート**

Run: `cd app && bun test && bun run typecheck && cd client && bun run build`
Expected: すべて成功

- [ ] **Step 9: コミット**

```bash
git add app/client/src/App.tsx
git commit -m "feat: 設定画面を新設しサイドバーからLLM/文字サイズ/言語を移設"
```

---

### Task 10: サーバ — ローカルLLMの活動連動ウォームアップ

**Files:**
- Modify: `app/server/providers/openai-compat.ts`（`warmOpenAICompat` / `openAICompatWarmTargetFromEnv` 追加）
- Create: `app/server/llm-warmup.ts`
- Modify: `app/server/converse.ts`（warm target の更新配線）, `app/server/routes.ts`（受信入口フック）, `app/server/index.ts`（`warmLlm` 配線）
- Modify: `app/server/__tests__/helpers/route-deps.ts`（`warmLlm` 既定）
- Test: `app/server/__tests__/openai-compat.test.ts`（追記）, Create `app/server/__tests__/llm-warmup.test.ts`

**Interfaces:**
- Consumes: Task 2（`applyLlmRoleSettings` の解決点・`settingsToEnv` / `isInheritRole` / `roleSettingToSettings`）
- Produces: `OpenAICompatWarmConfig` / `warmOpenAICompat` / `openAICompatWarmTargetFromEnv` / `Warmup` / `makeWarmup` / `conversationWarmup` / `LlmSettingsRoutesDeps.warmLlm`

**設計判断（理由つき）:**
- **warm の置き場所**: HTTP と env マッピングは openai-compat 固有なので `warmOpenAICompat` / `openAICompatWarmTargetFromEnv` を `providers/openai-compat.ts` に凝集する（`makeOpenAICompatRunner` と同じ request 形状を共有）。スロットラー/状態は runner 解決から独立させるため専用モジュール `llm-warmup.ts`（`makeWarmup` ファクトリ）に置く。テストは独自インスタンス + 注入 clock/fetchFn で隔離できる。`converse.ts` は「conversation の解決先が openai-compat か」を `applyLlmRoleSettings` 内で判定して `conversationWarmup.setTarget()` を更新し、provider 知識を converse に閉じ込める。route 層は `warmLlm` を fire-and-forget で呼ぶだけ。
- **スロットラーの状態管理**: モジュール単一インスタンス `conversationWarmup`（`makeWarmup()`）がクロージャで `target`/`lastWarmAt`/`warming` を保持する。`lastWarmAt` はトリガー時点で楽観更新して同時多発リクエストを1回に畳む。240秒窓は Ollama の既定アンロード（5分）に対し「利用中は常駐・離脱後は自然解放（明示アンロードはしない＝ユーザーの他用途を妨げない）」の意図をコメントで明記する。
- **DB 未設定でも env で openai-compat のときに温める**: モジュールロード時に `openAICompatWarmTargetFromEnv(Bun.env)` で初期 target を設定する（DB を使わず env で openai-compat を指す構成も対象になる）。以後 `applyLlmRoleSettings` が呼ばれるたびに最新の conversation 解決先へ更新する。

- [ ] **Step 1: warmOpenAICompat / openAICompatWarmTargetFromEnv の失敗テストを書く**

`app/server/__tests__/openai-compat.test.ts` の import を差し替える:

```ts
import { makeOpenAICompatRunner, warmOpenAICompat, openAICompatWarmTargetFromEnv, type OpenAICompatConfig } from "../providers/openai-compat";
```

末尾に追記する（既存の `fakeChatFetch(reply, captured)` を再利用）:

```ts
describe("warmOpenAICompat", () => {
  test("max_tokens=1 の極小 completion を /chat/completions に POST（baseUrl 正規化・apiKey で Authorization）", async () => {
    const calls: CapturedReq[] = [];
    await warmOpenAICompat({ baseUrl: "http://localhost:11434/v1/", apiKey: "sk-x", model: "m" }, fakeChatFetch("x", calls));
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0].body.model).toBe("m");
    expect(calls[0].body.max_tokens).toBe(1);
    expect(calls[0].headers["authorization"]).toBe("Bearer sk-x");
  });

  test("apiKey なし: Authorization を付けない", async () => {
    const calls: CapturedReq[] = [];
    await warmOpenAICompat({ baseUrl: "http://localhost:11434/v1", model: "m" }, fakeChatFetch("x", calls));
    expect(calls[0].headers["authorization"]).toBeUndefined();
  });

  test("非2xx は throw する（呼び出し側の warn に回す）", async () => {
    const badFetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(warmOpenAICompat({ baseUrl: "http://x/v1", model: "m" }, badFetch)).rejects.toThrow(/500/);
  });
});

describe("openAICompatWarmTargetFromEnv", () => {
  test("openai-compat + 必須値ありで config を返す", () => {
    expect(openAICompatWarmTargetFromEnv({
      LLM_PROVIDER: "openai-compat",
      OPENAI_COMPAT_BASE_URL: "http://localhost:11434/v1",
      OPENAI_COMPAT_MODEL: "m",
      OPENAI_COMPAT_API_KEY: "sk",
    })).toEqual({ baseUrl: "http://localhost:11434/v1", apiKey: "sk", model: "m" });
  });

  test("claude/codex/値欠落は null（warm しない）", () => {
    expect(openAICompatWarmTargetFromEnv({ LLM_PROVIDER: "claude" })).toBeNull();
    expect(openAICompatWarmTargetFromEnv({ LLM_PROVIDER: "codex" })).toBeNull();
    expect(openAICompatWarmTargetFromEnv({ LLM_PROVIDER: "openai-compat", OPENAI_COMPAT_BASE_URL: "http://x/v1" })).toBeNull();
  });
});
```

- [ ] **Step 2: テストが落ちることを確認**

Run: `cd app && bun test __tests__/openai-compat.test.ts`
Expected: FAIL（`warmOpenAICompat` / `openAICompatWarmTargetFromEnv` 未定義）

- [ ] **Step 3: openai-compat アダプタに warm を実装する**

`app/server/providers/openai-compat.ts` の末尾に追記する:

```ts
/** warm 用の最小接続情報（defaultSystemPrompt/fetchFn を持たない・runner とは独立）。 */
export type OpenAICompatWarmConfig = { baseUrl: string; apiKey?: string; model: string };

/**
 * ローカルモデルを常駐させておくための極小 chat completion（max_tokens=1）。
 * 会話履歴（makeOpenAICompatRunner の store）には一切触れない。best-effort で、応答本文は使わない。
 * 非2xx は throw し、呼び出し側（llm-warmup）の warn に回す。
 */
export async function warmOpenAICompat(cfg: OpenAICompatWarmConfig, fetchFn: typeof fetch = fetch): Promise<void> {
  const endpoint = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  const res = await fetchFn(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: "ping" }], max_tokens: 1, stream: false }),
  });
  if (!res.ok) throw new Error(`OpenAI-compat warm failed: ${res.status}`);
}

/**
 * env が openai-compat を指し必要値が揃っていれば warm 用 config を返す。それ以外（claude/codex/env・値欠落）は null。
 * selectRunner の requireEnv（throw する）とは別に、warm は best-effort なので欠落時は null を返す（throw しない）。
 */
export function openAICompatWarmTargetFromEnv(env: Record<string, string | undefined>): OpenAICompatWarmConfig | null {
  if ((env.LLM_PROVIDER ?? "").trim().toLowerCase() !== "openai-compat") return null;
  const baseUrl = env.OPENAI_COMPAT_BASE_URL?.trim();
  const model = env.OPENAI_COMPAT_MODEL?.trim();
  if (!baseUrl || !model) return null;
  return { baseUrl, apiKey: env.OPENAI_COMPAT_API_KEY?.trim() || undefined, model };
}
```

- [ ] **Step 4: warm テストが通ることを確認**

Run: `cd app && bun test __tests__/openai-compat.test.ts`
Expected: PASS

- [ ] **Step 5: makeWarmup と makeFetchHandler フックの失敗テストを書く**

Create `app/server/__tests__/llm-warmup.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { makeWarmup } from "../llm-warmup";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq } from "./helpers/http";

type Call = { url: string; body: any; headers: Record<string, string> };

function fakeWarmFetch(calls: Call[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    calls.push({ url, body: JSON.parse(String(init.body)), headers });
    return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("makeWarmup", () => {
  test("target=null（非 openai-compat）なら何もしない", async () => {
    const calls: Call[] = [];
    const w = makeWarmup({ fetchFn: fakeWarmFetch(calls) });
    w.setTarget(null);
    w.maybeWarm(0);
    await flush();
    expect(calls.length).toBe(0);
  });

  test("スロットル: 240秒窓内は1回だけ・窓を越えると再度温める（クロック注入）", async () => {
    const calls: Call[] = [];
    const w = makeWarmup({ fetchFn: fakeWarmFetch(calls), windowMs: 240_000 });
    w.setTarget({ baseUrl: "http://localhost:11434/v1", model: "m" });

    w.maybeWarm(0); await flush();
    expect(calls.length).toBe(1);

    w.maybeWarm(100_000); await flush();
    expect(calls.length).toBe(1); // 窓内 → no-op

    w.maybeWarm(239_999); await flush();
    expect(calls.length).toBe(1); // 窓ぎりぎり内 → no-op

    w.maybeWarm(240_000); await flush();
    expect(calls.length).toBe(2); // 窓に到達 → 再warm
  });
});

describe("makeFetchHandler warm フック", () => {
  test("受信時に warmLlm を fire-and-forget で1回呼ぶ", async () => {
    let called = 0;
    const { deps } = makeTestDeps({ warmLlm: () => { called++; } });
    await makeFetchHandler(deps)(getReq("/api/health"));
    expect(called).toBe(1);
  });

  test("warmLlm が throw してもリクエスト処理は成功する（影響ゼロ）", async () => {
    const { deps } = makeTestDeps({ warmLlm: () => { throw new Error("boom warm"); } });
    const res = await makeFetchHandler(deps)(getReq("/api/health"));
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 6: テストが落ちることを確認**

Run: `cd app && bun test __tests__/llm-warmup.test.ts`
Expected: FAIL（`llm-warmup` 未作成 / `warmLlm` deps 未対応 / makeFetchHandler がフックしない）

- [ ] **Step 7: llm-warmup モジュールを実装する**

Create `app/server/llm-warmup.ts`:

```ts
import { warmOpenAICompat, type OpenAICompatWarmConfig } from "./providers/openai-compat";

/**
 * conversation ロールが openai-compat のとき、API リクエスト受信を契機にローカルモデルを温めておく。
 * 目的: 利用中はモデルを常駐させ、初回会話応答のコールドスタートを避ける。
 * 240秒スロットルにより、Ollama の既定アンロード（5分）に対して「利用中は常駐・離脱後は自然に解放」になる
 * （明示アンロードはしない＝ユーザーの他用途を妨げない）。
 * warm 自体の HTTP はローカル LLM への OUTBOUND であり、当サーバの受信フックを再帰トリガーしない。
 */
export type Warmup = {
  /** conversation の解決先が openai-compat のとき config、それ以外（Claude/Codex）は null。 */
  setTarget(target: OpenAICompatWarmConfig | null): void;
  /** 直近 windowMs 以内に温めた or 温め中なら no-op。target が null なら no-op。fire-and-forget（await しない）。 */
  maybeWarm(now?: number): void;
};

export function makeWarmup(opts: { fetchFn?: typeof fetch; windowMs?: number } = {}): Warmup {
  const windowMs = opts.windowMs ?? 240_000;
  let target: OpenAICompatWarmConfig | null = null;
  let lastWarmAt = Number.NEGATIVE_INFINITY;
  let warming = false;
  return {
    setTarget(t) {
      target = t;
    },
    maybeWarm(now = Date.now()) {
      if (!target) return; // Claude/Codex は対象外
      if (warming) return; // 温め中
      if (now - lastWarmAt < windowMs) return; // 直近窓内
      lastWarmAt = now; // 楽観的に窓を開始し、同時多発リクエストを1回に畳む
      warming = true;
      // fire-and-forget: リクエスト処理をブロックしない。失敗は warn のみ。
      void warmOpenAICompat(target, opts.fetchFn)
        .catch((err) => console.warn(`[llm-warmup] warm failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => { warming = false; });
    },
  };
}

/** 本番配線用の既定インスタンス（converse.ts が setTarget、index.ts が maybeWarm を配線する）。 */
export const conversationWarmup = makeWarmup();
```

- [ ] **Step 8: RouteDeps に warmLlm を足し、makeFetchHandler で受信フックする**

`app/server/routes/llm-settings.ts` の `LlmSettingsRoutesDeps` に1行追加（`llmEnv` の後）:

```ts
  /** 受信入口の fire-and-forget フック（conversation が openai-compat のときローカルモデルを温める）。llm-settings ルート自体は使わない。 */
  warmLlm: () => void;
```

`app/server/routes.ts` の `makeFetchHandler` が返す `fetch` 関数の先頭（`const url = new URL(req.url);` の直前）に追加:

```ts
    // 受信を契機にローカルLLM（conversation が openai-compat のとき）を温める。throttle 済み・fire-and-forget。
    // リクエスト処理には一切影響させない（await しない・例外を伝播させない）。
    try { deps.warmLlm(); } catch { /* warmup must never affect request handling */ }
```

`app/server/__tests__/helpers/route-deps.ts` の `makeTestDeps` 内、`llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),` の直後に追加:

```ts
    warmLlm: () => {},
```

- [ ] **Step 9: converse.ts で warm target を配線する**

`app/server/converse.ts` の import に追加（既存の llm-provider import の下）:

```ts
import { conversationWarmup } from "./llm-warmup";
import { openAICompatWarmTargetFromEnv } from "./providers/openai-compat";
```

`applyLlmRoleSettings` 関数の末尾（`for` ループの後、関数を閉じる `}` の直前）に追加:

```ts
  // conversation の解決先が openai-compat のときだけ warm 対象を更新する（inherit なら global を辿る）。
  const convSetting = isInheritRole(roles.conversation) ? global : roleSettingToSettings(roles.conversation);
  conversationWarmup.setTarget(openAICompatWarmTargetFromEnv(settingsToEnv(convSetting, env)));
```

`app/server/converse.ts` の `applyLlmSettings` 定義の直後（モジュール末尾）に追加（DB 未設定でも env で openai-compat のとき初期 target を張る）:

```ts
// 起動時: env 由来 provider（DB 未設定で env が openai-compat を指す構成）も warm 対象にする。
// 以後は applyLlmRoleSettings が呼ばれるたびに最新の conversation 解決先へ更新される。
conversationWarmup.setTarget(openAICompatWarmTargetFromEnv(Bun.env));
```

- [ ] **Step 10: index.ts で warmLlm を配線する**

`app/server/index.ts` の import（`makeLlmRoleSettingsStore` の下）に追加:

```ts
import { conversationWarmup } from "./llm-warmup";
```

`realDeps` 内、`llmEnv: () => ({ … }),` の直後に追加:

```ts
  warmLlm: () => conversationWarmup.maybeWarm(),
```

- [ ] **Step 11: 全テストと型チェック**

Run: `cd app && bun test __tests__/llm-warmup.test.ts __tests__/openai-compat.test.ts __tests__/converse-runtime.test.ts && bun run typecheck && bun test`
Expected: すべて PASS（warmup 単体・受信フック・既存 converse 回帰・全体緑）

- [ ] **Step 12: コミット**

```bash
git add app/server/providers/openai-compat.ts app/server/llm-warmup.ts app/server/converse.ts app/server/routes.ts app/server/routes/llm-settings.ts app/server/index.ts app/server/__tests__/openai-compat.test.ts app/server/__tests__/llm-warmup.test.ts app/server/__tests__/helpers/route-deps.ts
git commit -m "feat: ローカルLLMの活動連動ウォームアップ（openai-compat時のみ・240秒スロットル・影響ゼロ）"
```

---

### Task 11: ドキュメント（CHANGELOG v0.18.0 + README）

**Files:**
- Modify: `CHANGELOG.md`（先頭に v0.18.0 追記）
- Modify: `README.md:50`（「できること」サイドバー行）, `README.md:136-138`（LLM プロバイダ節）

**Interfaces:** なし（AGENTS.md のドキュメントゲート）

- [ ] **Step 1: CHANGELOG に v0.18.0 を追記する**

`CHANGELOG.md` の `# Changelog` 説明段落の直後、`## [0.17.2] - 2026-07-08` の直前に挿入:

```markdown
## [0.18.0] - 2026-07-08

### Added

- **用途別 LLM ルーティング + 設定画面**: LLM 呼び出しを4つの用途ロール（会話 / コーチング / 教材生成 / 測定）に分け、ロールごとにプロバイダを選べるように。サイドバーにあった「LLM プロバイダ」パネルと文字サイズ・言語トグルを、nav「記録・測定」の新設「⚙️ 設定」画面へ移設。設定画面は**推奨構成の適用**（会話だけローカルモデル・他は動作確認済みの既定）と**すべて既定に戻す**のプリセットを主役にし、ロール別の個別指定は折りたたみ詳細に。何も設定しなければ全ロールが「全体に従う（inherit）」で、**DB 未設定 + env 未設定なら現行 Claude と完全に同一**。ロール別設定は SQLite の新テーブル `llm_role_settings` に永続化し、保存すると実行中プロセスへ**再起動なしで即時適用**する。**APIキーは従来どおり UI・DB・API 応答・ログに一切載せず `app/.env` の `OPENAI_COMPAT_API_KEY` のみ**
- **ローカルLLMの活動連動ウォームアップ**: 会話ロールがローカルLLM（OpenAI 互換）のとき、アプリを操作している間はバックグラウンドで極小リクエスト（`max_tokens=1`）を送ってモデルを常駐させ、初回応答のコールドスタートを避けます（240秒に1回まで・利用中は常駐/離脱後は自然に解放）。リクエスト処理には一切影響せず、失敗しても静かに無視します。Claude/Codex では何もしません

### Changed

- LLM プロバイダの切替 UI をサイドバーの常設パネルから「設定」画面へ移設（文言・保存の挙動は不変。全体の接続先はこれまでどおり選択可能）
- 文字サイズ・言語の切替をサイドバーから「設定」画面の「表示」セクションへ移設（保存キー・挙動は不変）
```

- [ ] **Step 2: README「できること」のサイドバー行を更新する**

`README.md:50` を差し替える:

```markdown
- サイドバーは**今日の練習 / 自主練 / 記録・測定**の3セクション構成。自主練の取り組み順ヒント（聞く→覚える→話す）を ⓘ で確認できます。「記録・測定」の **⚙️ 設定**で LLM プロバイダ（用途別ルーティング含む・後述）と文字サイズ・言語を変更できます。
```

（`README.md:51` の「UI はデフォルト英語。サイドバーの **EN / 日本語** トグルで…」は、言語トグルが設定画面へ移ったため次に差し替える:）

```markdown
- UI はデフォルト英語。**⚙️ 設定 → 表示**の **EN / 日本語** でいつでも切り替え可能
```

- [ ] **Step 3: README の LLM プロバイダ節に用途別ルーティングを追記する**

`README.md:138` の段落末尾（「…従う状態へ戻る。」の直後）に段落を追加する:

```markdown

**用途別ルーティング（設定画面）**: サイドバー「記録・測定」の **⚙️ 設定 → 言語モデル**で、LLM 呼び出しを4つの用途ロールに分けて別々のプロバイダに割り当てられる。

| ロール | 使われる場面 |
| --- | --- |
| 会話 | 自由会話・ロールプレイの相手応答 |
| コーチング | 添削・振り返り・訳・言い方ヒント・各種解説 |
| 教材生成 | モデルトーク・4/3/2 準備・生成コンテンツ（CLI 含む） |
| 測定 | レベル測定・月次レビュー |

各ロールの既定は「全体に従う（inherit）」で、全体の接続先（上記表の `LLM_PROVIDER` 相当）をそのまま使う。**推奨構成を適用**は、全体をローカル LLM（OpenAI 互換）に接続済みのときだけ有効で、会話だけをそのローカルモデルに割り当て、コーチング・教材生成・測定は既定（Claude）に残す（高頻度・低リスクの会話はローカルで速く安く、品質が要る用途は動作確認済みの Claude に寄せる、という配分）。**すべて既定に戻す**で全体=環境変数の既定・全ロール inherit に戻せる。ロール別設定は `llm_role_settings` テーブルに保存し、APIキーは持たせない（`app/.env` のみ）。**設定を何も変えなければ全ロール inherit のままで、現行と完全に同一の挙動**。

会話ロールがローカル LLM（OpenAI 互換）に解決されるときは、アプリを操作している間、API リクエスト受信を契機にバックグラウンドで極小リクエスト（`max_tokens=1`）を送ってモデルを常駐させる（240秒に1回まで・fire-and-forget でリクエスト処理には無影響・失敗は無視）。Ollama 等の既定アンロード（5分）に対して「利用中は常駐・離脱後は自然に解放」になり、初回会話のコールドスタートを抑える。Claude/Codex のときは何もしない。
```

- [ ] **Step 4: ドキュメント差分の目視確認**

Run: `git diff --stat CHANGELOG.md README.md`
Expected: 両ファイルに差分がある

- [ ] **Step 5: 最終ゲート**

Run: `cd app && bun test && bun run typecheck && cd client && bun run build`
Expected: すべて成功

- [ ] **Step 6: コミット**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: v0.18.0（用途別LLMルーティング + 設定画面）のCHANGELOG/README"
```

---

## Self-Review

### 1. Spec coverage（確定済み設計との対応）

| 確定事項 | 対応タスク |
| --- | --- |
| ①ロール4つ固定 + 対応表を実コードで確定 | ロール対応表（本文）+ Task 1（`LlmRole`）+ Task 5（配線） |
| ②既定は全ロール inherit（ビット単位同一 = 回帰基準） | Task 2 Step 1 の回帰ロックテスト・Global Constraints 冒頭 |
| ③推奨プリセット主役（openai-compat 設定時のみ活性・未設定は案内）+ すべて既定に戻す + ロール別は折りたたみ詳細 | Task 8（`onRecommended`/`recommendEnabled`/`onResetAll`/`<details>`）+ Task 7 文言 |
| ④設定画面新設（LLM + 表示）・サイドバー LlmPanel/uiScale/言語 撤去・SupportPanel/PracticeStat 残置 | Task 8（画面）+ Task 9（統合・撤去） |
| ⑤runnerFor(role) + ロール別 currentRunner Map + 安定参照ラッパ・applyLlmRoleSettings・store ロール別拡張・API additive・機械的差し替え | Task 2 / Task 3 / Task 4 / Task 5 |
| ⑥codex 既定・secrets 衛生・研究制約・named 型 i18n EN/JA・TDD | Global Constraints + 各タスクのテスト/文言 |
| 追加要件: ローカルLLM活動連動ウォームアップ（受信フック・openai-compat のみ・warm() with fetchFn 注入・240秒スロットル・非対象時 no-op・失敗 warn のみ・await しない・ループ非発生・ループ設計明記） | Task 10（`warmOpenAICompat`/`openAICompatWarmTargetFromEnv`/`makeWarmup`/`conversationWarmup`/`warmLlm` フック）+ ロール対応表の位置づけ注記 + Global Constraints「ウォームアップは影響ゼロ」 |
| CHANGELOG v0.18.0 + README（LLM 節・できること整合・ウォームアップ追記） | Task 11 |

主要設計判断（理由つき）:
- **ストア形状 = 別テーブル `llm_role_settings`（既存 `llm_settings` は無改変）**。理由: AGENTS.md「`CREATE TABLE IF NOT EXISTS` のみ・ALTER 禁止」の下では既存テーブルに `role` 列を足せない（既存 DB に列が増えない → クラッシュ）。別テーブルなら新規 `ensureXSchema` だけで既存行の移行が不要、フレッシュ/既存とも全ロール inherit = 現行同一を自然に満たす。inherit は `provider="inherit"` センチネル（row 不在も inherit 扱い）で表し、リセットは UPSERT（DELETE 不使用 = 「データ削除機能を作らない」規約に整合）。
- **`applyLlmRoleSettings` 追加 + `applyLlmSettings` は後方互換ラッパ**。理由: 既存 `converse-runtime.test.ts` と起動時適用・ルート層 dep が `applyLlmSettings(global)` 形で呼ぶ。これを「全ロール inherit で apply」に保つと既存テスト・API が無改変で通り、`getCurrentRunner()` の参照同一性ロックもそのまま生きる。全体設定変更時にロール上書きを保持する必要（旧 PUT）は、index.ts 側 dep を `applyLlmRoleSettings(s, roleStore.getAll())` にすることで解決（ルート層のシグネチャは不変）。
- **API は旧 PUT 不変 + 新 `PUT /roles`**。理由: 「旧形状の PUT も動く」を最も確実に満たす。プリセットの原子性は `/roles` が `{global?, roles}` を一括受理して1回だけ再解決することで担保。

### 2. Placeholder scan

- 全 Step にコードまたは正確なコマンド/期待出力を記載。「適切なエラー処理を追加」等の曖昧表現なし。
- ロール判定の境界（inherit/未知ロール/env はロール不可/openai-compat 欠落）は Task 4 Step 2 の 400 テストで具体化。
- Task 8 Step 2 に `Button` の `variant` 実値に関する確認補足を明記（推測で `"primary"` 固定にしない安全弁）。

### 3. Type consistency

- `LlmRole` / `LlmRoleProvider` / `LlmRoleSetting` はサーバ（`llm-provider.ts`）とクライアント（`api/llm-settings.ts`）で**同一の文字列リテラル**で二重定義（クライアントはサーバ型を import しないプロジェクト構成のため意図的重複・値は一致）。`LLM_ROLES` の順序も両者一致（`["conversation","coaching","generation","assessment"]`）。
- `runnerFor(role: LlmRole): ClaudeRunner`（Task 2）↔ index.ts 呼び出し（Task 5）で名前・引数一致。`applyLlmRoleSettings(global, roles, env?)`（Task 2）↔ index.ts / ルート dep（Task 4/5）一致。
- ルート dep `getLlmRoleSettings(): Record<LlmRole, LlmRoleSetting>` / `saveLlmRoleSettings(role, s)`（Task 4）↔ フェイク（Task 4 Step 1）↔ index 実装（Task 5 Step 4）一致。
- GET 応答 `roles`（Task 4 viewOf）↔ クライアント `LlmSettingsView.roles: Record<LlmRole, LlmRoleView>`（Task 6）↔ `SettingsScreen` の `setRoles(v.roles)`（Task 8）一致。
- `store.getAll()` は4ロール全て埋めて返す（Task 3）ので、viewOf と SettingsScreen が undefined ロールに触れない。
- ウォームアップ（Task 10）: `OpenAICompatWarmConfig` は `warmOpenAICompat` / `openAICompatWarmTargetFromEnv`（openai-compat.ts）↔ `makeWarmup`/`conversationWarmup`（llm-warmup.ts）↔ converse の `setTarget` 引数で一貫。`warmLlm: () => void` は型定義（llm-settings.ts）↔ makeFetchHandler 呼び出し（routes.ts）↔ フェイク（route-deps.ts）↔ 実配線（index.ts）で名前・シグネチャ一致。`warmOpenAICompat(cfg, fetchFn?)` の request 形状（`/chat/completions`・`stream:false`・Bearer）は既存 `makeOpenAICompatRunner` と一致（`max_tokens:1` のみ追加）。

### 4. 既定不変の検証手段

- **Task 2 Step 1**: 全ロール inherit + global=env で `getCurrentRunner(role)` が4ロールとも同一の claudeRunner 参照になること、および1ロール上書き時に他ロールが不変であることを参照同一性（`.toBe`）でロック。既存 `converse-runtime.test.ts` の「openai-compat で別参照 / env リセットで claude 同一参照」も保持。
- **Task 3**: `getAll()` 未設定=全 inherit をユニットテストでロック。
- **Task 4**: GET 未設定応答が `roles` 全 inherit を含む完全一致（`toEqual`）でロック。旧 PUT の 400/200 挙動テストは不変のまま緑。
- **Task 5 Step 7 / Task 9 Step 8**: `bun test` 全緑で index 配線後の回帰を担保。起動時ブロックは「全体行なし + 全ロール inherit なら apply を呼ばない」ため、フレッシュ環境ではモジュールロード時 env 既定がそのまま残る（＝現行と同一）。
- **ウォームアップの既定不変（Task 10）**: 既定（会話が openai-compat 以外 = Claude）では warm target が null になり `maybeWarm` は no-op（Task 10 Step 5 の「target=null なら何もしない」テストでロック）。受信フックの `try/catch` と「warmLlm が throw してもリクエストは 200」テスト（Step 5）で、ウォームアップがリクエスト処理に影響しないことを担保。よって既定挙動のバイト単位不変性はウォームアップ導入後も保たれる。
