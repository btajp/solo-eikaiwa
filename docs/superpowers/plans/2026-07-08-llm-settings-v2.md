# LLM 設定 v2 — 接続定義とロール割当の分離 + プリセット3種 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 設定画面の「言語モデル」を「接続（ローカル LLM / Codex の定義）」と「用途ごとのモデル割当（Claude / ローカル / Codex を直接選ぶ）」に再構成し、ロール割当を書くだけのプリセット3種（オールローカル / バランス〔推奨〕/ 最高品質）を最上部に追加する。

**Architecture:** 既存の3層（`llm_settings` 単一行 / `llm_role_settings` 複数行 / `applyLlmRoleSettings` 解決ロジック）はそのまま使い、**UI とプリセットが書き込む内容だけ**で v2 を実現する。`llm_settings` 単一行を「接続ストア（ローカル baseUrl/model + Codex model の置き場）」として再解釈し、各ロール行は `claude | openai-compat | codex` を接続値インラインで直接持つ。サーバ変更は `parseSettingsInput` の openai-compat 分岐で `codexModel` を保持する1点のみ（接続ストアがローカルと Codex を同居させるため必須・API のフィールド形状は不変）。解決ロジック（`applyLlmRoleSettings` / `runnerFor` / `settingsToEnv`）は**無変更**。

**Tech Stack:** Bun + TypeScript（`app/server`）、React + Vite（`app/client`）、bun:sqlite、bun:test。i18n は named 型辞書（`app/client/src/i18n.ts`）。

## Global Constraints

以下はタスク種別を問わず全タスクに適用される（`AGENTS.md` より・値は逐語）。

- **検証ゲート（必須・3種すべて緑）:**
  - `cd app && bun test`（サーバ + クライアント純ロジック）
  - `cd app && bun run typecheck`（サーバ型チェック）
  - `cd app/client && bun run build`（クライアント型チェック + ビルド）
- **サーバの新ロジックは TDD（赤→緑）**。テストは `app/server/__tests__/`、フェイクは `__tests__/helpers/route-deps.ts` の `satisfies` パターン、HTTP は `getReq` / `putJson` ヘルパで `makeFetchHandler(deps)` を直接叩く（ソケットを開かない）。
- **クライアントの純ロジックも TDD**。React コンポーネントの単体テスト基盤は無い（typecheck + build + `*.test.ts` の純ロジックテストで担保）。よって直列化・読み替えロジックは純関数モジュールに切り出してテストする。
- **i18n は named 型辞書**: 型 + `STR.en` + `STR.ja` の3点を同時に変更する。**既存キーの日本語文言は一字一句変更しない**。文字列の直書き禁止（JSX に句読点含む文字列リテラルを置かない）。
- **プロダクト制約（研究根拠つき・binding）**: 情報的フィードバックのみ。ノルマ・判定・警告・叱責調・喪失演出を導入しない。**ユーザーデータを削除する機能を作らない**。案内文（ローカル未定義時など）は中立・情報提供に徹する。
- **secrets**: API キーは `app/.env` のみ。DB・API レスポンス・ログ・plist に出さない。このリポジトリは PUBLIC。
- **ドキュメント規約（コード完了 ≠ タスク完了）**: ユーザーに見える変更は同じブランチで README 該当節 + CHANGELOG を更新する（Task 5）。CHANGELOG は Keep a Changelog 形式・日本語・ユーザー視点。リリース対象は **v0.21.0**（package.json に version フィールドは無く、リリース = CHANGELOG 追記 + git タグ）。
- **後方互換**: 旧 API（`GET/PUT /api/llm-settings` / `PUT /api/llm-settings/roles`）の**フィールド形状は不変**。既存の DB 行・env 直接運用（ヘッドレス CLI）は従来どおり動く。

---

## 設計: データモデルの読み替え（binding・実装前に必読）

物理スキーマは無変更（`CREATE TABLE IF NOT EXISTS` のみ・マイグレーション機構は作らない）。**意味の再解釈**だけで v2 を成立させる。

### `llm_settings`（単一行 id=1）= 「接続ストア」

| 列 | v1 の意味 | v2 の再解釈 |
| --- | --- | --- |
| `provider` | 全体の接続先（`env`/`claude`/`openai-compat`/`codex`） | **接続の在り方を表す内部フラグ**。UI にはトグルを出さない。ローカル定義済み → `openai-compat`。ローカル未定義で Codex model のみ → `codex`。何も無し → `env`（＝環境変数に従うリセット） |
| `base_url` | openai-compat の URL | **ローカル LLM の Base URL**（接続入力そのもの） |
| `model` | openai-compat のモデル | **ローカル LLM のモデル名**（接続入力そのもの） |
| `codex_model` | Codex のモデル | **Codex の任意モデル名**（接続入力そのもの・v1 では openai-compat 選択時に落とされていた → Task 1 で保持する） |

- `env` センチネルは廃止せず「内部フォールバック用」に温存する（`settingsToEnv` が `env` を「上書きしない」として扱う既存挙動を維持）。
- **API 応答（`viewOf`）は無変更**: `viewOf` は provider に関わらず `s.codexModel` を返すため（`routes/llm-settings.ts` の現行実装）、Task 1 で openai-compat 行に codexModel を保存すれば GET でそのまま往復する。ルートの応答形状は変わらない。

### `llm_role_settings`（role 主キーの複数行）= 「ロール割当」

- 各ロールは `provider = claude | openai-compat | codex` を**接続値インラインで直接持つ**（v2 では UI 上 `inherit` を書かない）。
  - ロール=ローカル → `{ provider: "openai-compat", baseUrl: <接続の baseUrl>, model: <接続の model> }`
  - ロール=Claude → `{ provider: "claude" }`
  - ロール=Codex → `{ provider: "codex", codexModel: <接続の codexModel or null> }`
- `inherit` は「未設定＝内部フォールバック」として残る（既存 DB の未設定ロール・env 直接運用向け）。UI からは新規に書き込まない。**v2 の書き込みは常に4ロールを明示的（非 inherit）に埋める**ため、書き込み後に inherit ロールは残らない。

### 既存ユーザーの初回表示（マイグレーション不要の読み替え）

現在の既存ユーザー状態: `llm_settings = { provider: "openai-compat", baseUrl, model: "qwen3", codexModel: null }`、`llm_role_settings` 行なし（全ロール実質 inherit）。

- **解決（挙動）**: `applyLlmRoleSettings` は globalRunner=ローカル、全ロール inherit→globalRunner を共有 = 全ロール実質ローカル。**v0.21.0 を開いても何も操作しなければ挙動は完全に不変**（サーバ解決ロジック無変更のため）。
- **表示（UI）**: 接続入力はローカル定義済み（baseUrl/model 表示）。ロール割当は「effective global provider（`view.provider === "env" ? view.envProvider : view.provider`）」に inherit を解決して3値表示する → 既存ユーザーは effective global = `openai-compat` なので**全ロールが「ローカル」表示**。要件（接続=ローカル定義済み・全ロール実質ローカル）を満たす。
- **新規ユーザー（DB 行なし・env=claude）**: `view.provider="env"`、`envProvider="claude"` → 全ロール「Claude」表示。接続=ローカル未定義。ローカルを含むプリセット（オールローカル/バランス）は非活性 + 中立案内。

---

## 設計: プリセット3種の書き込み内容（PUT `/api/llm-settings/roles` ペイロード）

全プリセットは `global`（接続ストア）と `roles`（4ロール明示）を同一リクエストで書く。**接続（`global` の baseUrl/model/codexModel）はどのプリセットでも保持**され、最高品質を選んでもローカル接続定義は失われない（後でローカルに戻せる）。

以下は接続 = `{ baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "" }`（ローカル定義済み・Codex 未指定）を例にした具体ペイロード。

**オールローカル**（全ロール=ローカル）:
```json
{
  "global": { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "qwen3", "codexModel": null },
  "roles": {
    "conversation": { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "qwen3" },
    "coaching":     { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "qwen3" },
    "generation":   { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "qwen3" },
    "assessment":   { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "qwen3" }
  }
}
```

**バランス（推奨表示）**（会話・教材生成=ローカル / コーチング・測定=Claude）:
```json
{
  "global": { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "qwen3", "codexModel": null },
  "roles": {
    "conversation": { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "qwen3" },
    "coaching":     { "provider": "claude" },
    "generation":   { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "qwen3" },
    "assessment":   { "provider": "claude" }
  }
}
```

> **バランスで測定を Claude 側に含める理由（計画に明記）**: ユーザー原案は「コーチングだけ Claude」だったが、**測定（レベル測定・月次レビュー）は Claude とローカルの品質差が最大かつ実行頻度が最も低い**（月次・レベル測定は稀）。品質が要る・コスト影響が小さいこの用途を Claude に寄せるのは配分として妥当。よってバランスは coaching + assessment の2ロールを Claude にする。

**最高品質**（全ロール=Claude・接続は保持）:
```json
{
  "global": { "provider": "openai-compat", "baseUrl": "http://localhost:11434/v1", "model": "qwen3", "codexModel": null },
  "roles": {
    "conversation": { "provider": "claude" },
    "coaching":     { "provider": "claude" },
    "generation":   { "provider": "claude" },
    "assessment":   { "provider": "claude" }
  }
}
```

- `global.codexModel` は接続に Codex model が入っているときのみ非 null になる（例では未指定なので null）。**この codexModel を openai-compat 行に載せるために Task 1 のサーバ変更が必要**。
- 接続にローカルが無い（baseUrl/model が空）場合、`global` は `{ "provider": "codex", "codexModel": <model> }`（Codex のみ）または `{ "provider": "env" }`（何も無し）になり、ローカルを含むプリセットは UI で非活性。

---

## File Structure

**新規:**
- `app/client/src/lib/llm-assignments.ts` — v2 の純ロジック（接続/割当の型・プリセット定義・`buildRolesPayload` 直列化・`hydrateConnection` / `hydrateTargets` 読み替え・`isLocalDefined` / `presetEnabled` ガード）。UI と分離してテスト可能にする。
- `app/client/src/lib/llm-assignments.test.ts` — 上記の純ロジックテスト。

**変更:**
- `app/server/routes/llm-settings.ts` — `parseSettingsInput` の openai-compat 分岐で `codexModel` を保持（接続ストア対応）。他は無変更。
- `app/server/__tests__/routes-llm-settings.test.ts` — codexModel 保持のテストを1件追加。
- `app/client/src/i18n.ts` — v2 の settings キーを追加、旧 preset/connection/roles キーを削除（型 + en + ja）。
- `app/client/src/screens/SettingsScreen.tsx` — 「言語モデル」節を接続 / 用途ごとのモデル / プリセットに全面再構成（TTS・表示節は不変）。
- `CHANGELOG.md` — v0.21.0 エントリ追加。
- `README.md` — 「LLM プロバイダの切替」節の UI 説明を再構成（env 表・env 直接運用の注意は温存）。

**無変更（触らない・明記）:**
- `app/server/converse.ts`（`applyLlmRoleSettings` / `runnerFor` / `settingsToEnv` / warmup）。
- `app/server/llm-settings-store.ts` / `llm-role-settings-store.ts` / `llm-provider.ts`。
- `app/server/index.ts` / `routes.ts`（RouteDeps・配線は変更なし。新ルート/新 deps を足さないため index.ts/routes.ts の配線矛盾は発生しない）。
- `app/client/src/api/llm-settings.ts`（`LlmRolesInput` / `LlmSettingsView` は既に codexModel と global を持つため型追加不要）。
- TTS 設定（接続・UI とも）。

---

## Task 1: サーバ — 接続ストアが openai-compat 行に codexModel を保持する（TDD）

**Files:**
- Modify: `app/server/routes/llm-settings.ts:50-56`（`parseSettingsInput` の openai-compat 分岐）
- Test: `app/server/__tests__/routes-llm-settings.test.ts`（`describe("llm-settings API")` 内に1件追加）

**Interfaces:**
- Consumes: 既存 `parseSettingsInput(b, allowed)` / `asOptionalStr(v, max)` / `isHttpUrl(v)`。
- Produces: openai-compat の PUT で `codexModel` を（省略時 null で）保持する `ParsedSettings`。GET は `viewOf` 経由で codexModel を往復（応答形状不変）。

- [ ] **Step 1: 失敗するテストを書く**

`app/server/__tests__/routes-llm-settings.test.ts` の `describe("llm-settings API", () => {` ブロック内、`test("PUT codex: ...")` の直前に次を追加する。

```ts
  test("PUT openai-compat: codexModel も接続ストアとして保持する（接続分離 v2）", async () => {
    const saved: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    await makeFetchHandler(deps)(putJson("/api/llm-settings", {
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex",
    }));
    expect(saved[0]).toEqual({
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex",
    });
  });
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd app && bun test routes-llm-settings`
Expected: FAIL — `saved[0].codexModel` が `null`（現行は openai-compat で codexModel を落とす）で `"gpt-5-codex"` に一致しない。

- [ ] **Step 3: 最小実装（openai-compat 分岐で codexModel を保持）**

`app/server/routes/llm-settings.ts` の openai-compat 分岐を差し替える。

置換前:
```ts
  if (b.provider === "openai-compat") {
    const baseUrl = asOptionalStr(b.baseUrl, 500);
    if (!baseUrl || !isHttpUrl(baseUrl)) return { ok: false, error: "baseUrl must be a valid http(s) URL for openai-compat" };
    const model = asOptionalStr(b.model, 200);
    if (!model) return { ok: false, error: "model is required for openai-compat" };
    return { ok: true, value: { provider: "openai-compat", baseUrl, model, codexModel: null } };
  }
```

置換後:
```ts
  if (b.provider === "openai-compat") {
    const baseUrl = asOptionalStr(b.baseUrl, 500);
    if (!baseUrl || !isHttpUrl(baseUrl)) return { ok: false, error: "baseUrl must be a valid http(s) URL for openai-compat" };
    const model = asOptionalStr(b.model, 200);
    if (!model) return { ok: false, error: "model is required for openai-compat" };
    // 接続ストア(llm_settings 単一行)にローカル(baseUrl/model)と Codex(codexModel)を同居させるため、
    // openai-compat でも codexModel を保持する（未指定は null）。openai-compat 解決時は CODEX_MODEL は不使用で無害。
    const codexModel = asOptionalStr(b.codexModel, 200);
    if (codexModel === undefined) return { ok: false, error: "codexModel must be a string of at most 200 characters" };
    return { ok: true, value: { provider: "openai-compat", baseUrl, model, codexModel } };
  }
```

- [ ] **Step 4: テストが通ることを確認する（既存テストの後方互換も確認）**

Run: `cd app && bun test routes-llm-settings`
Expected: PASS。新テストが緑。既存の `PUT openai-compat`（codexModel 未送信 → `codexModel: null`）・GET 系（stored codexModel が null）も緑のまま（codexModel 省略時は `asOptionalStr(undefined)=null`）。

- [ ] **Step 5: 検証ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全緑。

- [ ] **Step 6: コミット**

```bash
git add app/server/routes/llm-settings.ts app/server/__tests__/routes-llm-settings.test.ts
git commit -m "feat: 接続ストアが openai-compat 行に Codex モデルを同居保持できるようにする"
```

---

## Task 2: クライアント — v2 純ロジックモジュール `llm-assignments`（TDD）

**Files:**
- Create: `app/client/src/lib/llm-assignments.ts`
- Test: `app/client/src/lib/llm-assignments.test.ts`

**Interfaces:**
- Consumes: `../api` の `LLM_ROLES`、型 `LlmRole` / `LlmRolesInput` / `LlmSettingsView`。
- Produces:
  - 型 `RoleTarget = "claude" | "local" | "codex"`、`RoleTargets = Record<LlmRole, RoleTarget>`、`Connection = { baseUrl: string; model: string; codexModel: string }`、`PresetId = "all-local" | "balanced" | "high-quality"`。
  - `PRESETS: Record<PresetId, RoleTargets>`
  - `isLocalDefined(conn: Connection): boolean`
  - `presetEnabled(id: PresetId, conn: Connection): boolean`
  - `hydrateConnection(view: LlmSettingsView): Connection`
  - `hydrateTargets(view: LlmSettingsView): RoleTargets`
  - `buildRolesPayload(targets: RoleTargets, conn: Connection): LlmRolesInput`

- [ ] **Step 1: 失敗するテストを書く**

`app/client/src/lib/llm-assignments.test.ts` を作成する。

```ts
import { describe, expect, test } from "bun:test";
import type { LlmSettingsView } from "../api";
import {
  PRESETS, isLocalDefined, presetEnabled, hydrateConnection, hydrateTargets, buildRolesPayload,
  type RoleTargets,
} from "./llm-assignments";

const LOCAL_CONN = { baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "" };
const EMPTY_CONN = { baseUrl: "", model: "", codexModel: "" };

/** テスト用の LlmSettingsView 生成（roles は既定 inherit・上書き可）。 */
function mkView(over: Partial<LlmSettingsView> = {}): LlmSettingsView {
  const inherit = { provider: "inherit" as const, baseUrl: null, model: null, codexModel: null };
  return {
    provider: "env", baseUrl: null, model: null, codexModel: null,
    apiKeyConfigured: false, envProvider: "claude",
    roles: { conversation: inherit, coaching: inherit, generation: inherit, assessment: inherit },
    ...over,
  };
}

describe("isLocalDefined / presetEnabled", () => {
  test("baseUrl と model が両方あればローカル定義済み", () => {
    expect(isLocalDefined(LOCAL_CONN)).toBe(true);
    expect(isLocalDefined({ baseUrl: "http://x/v1", model: "", codexModel: "" })).toBe(false);
    expect(isLocalDefined(EMPTY_CONN)).toBe(false);
  });
  test("ローカルを含むプリセットはローカル定義が必要・最高品質は常に可", () => {
    expect(presetEnabled("all-local", LOCAL_CONN)).toBe(true);
    expect(presetEnabled("balanced", LOCAL_CONN)).toBe(true);
    expect(presetEnabled("all-local", EMPTY_CONN)).toBe(false);
    expect(presetEnabled("balanced", EMPTY_CONN)).toBe(false);
    expect(presetEnabled("high-quality", EMPTY_CONN)).toBe(true);
  });
});

describe("buildRolesPayload", () => {
  test("オールローカル: global=openai-compat・全ロール openai-compat インライン", () => {
    expect(buildRolesPayload(PRESETS["all-local"], LOCAL_CONN)).toEqual({
      global: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: null },
      roles: {
        conversation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
        coaching: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
        generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
        assessment: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      },
    });
  });

  test("バランス: 会話・教材生成=ローカル / コーチング・測定=Claude", () => {
    const payload = buildRolesPayload(PRESETS.balanced, LOCAL_CONN);
    expect(payload.roles).toEqual({
      conversation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      coaching: { provider: "claude" },
      generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      assessment: { provider: "claude" },
    });
    expect(payload.global).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: null });
  });

  test("最高品質: 全ロール Claude だが接続(global=openai-compat)は保持する", () => {
    const payload = buildRolesPayload(PRESETS["high-quality"], LOCAL_CONN);
    expect(payload.roles).toEqual({
      conversation: { provider: "claude" }, coaching: { provider: "claude" },
      generation: { provider: "claude" }, assessment: { provider: "claude" },
    });
    expect(payload.global).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: null });
  });

  test("接続に Codex model があれば global.codexModel と codex ロールに載る", () => {
    const conn = { baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" };
    const targets: RoleTargets = { conversation: "codex", coaching: "local", generation: "local", assessment: "claude" };
    const payload = buildRolesPayload(targets, conn);
    expect(payload.global).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" });
    expect(payload.roles.conversation).toEqual({ provider: "codex", codexModel: "gpt-5-codex" });
  });

  test("ローカル未定義で local ターゲットは claude にフォールバック・global=env", () => {
    const targets: RoleTargets = { conversation: "local", coaching: "claude", generation: "local", assessment: "claude" };
    const payload = buildRolesPayload(targets, EMPTY_CONN);
    expect(payload.global).toEqual({ provider: "env" });
    expect(payload.roles).toEqual({
      conversation: { provider: "claude" }, coaching: { provider: "claude" },
      generation: { provider: "claude" }, assessment: { provider: "claude" },
    });
  });

  test("ローカル未定義・Codex のみ定義なら global=codex", () => {
    const conn = { baseUrl: "", model: "", codexModel: "gpt-5-codex" };
    const targets: RoleTargets = { conversation: "codex", coaching: "codex", generation: "codex", assessment: "codex" };
    const payload = buildRolesPayload(targets, conn);
    expect(payload.global).toEqual({ provider: "codex", codexModel: "gpt-5-codex" });
    expect(payload.roles.conversation).toEqual({ provider: "codex", codexModel: "gpt-5-codex" });
  });
});

describe("hydrateTargets（inherit の読み替え）", () => {
  test("既存ユーザー: llm_settings=openai-compat・全ロール inherit → 全ロール local", () => {
    const view = mkView({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" });
    expect(hydrateTargets(view)).toEqual({ conversation: "local", coaching: "local", generation: "local", assessment: "local" });
  });
  test("新規ユーザー: provider=env・envProvider=claude・全ロール inherit → 全ロール claude", () => {
    expect(hydrateTargets(mkView())).toEqual({ conversation: "claude", coaching: "claude", generation: "claude", assessment: "claude" });
  });
  test("env の envProvider が openai-compat なら inherit は local", () => {
    expect(hydrateTargets(mkView({ provider: "env", envProvider: "openai-compat" })).conversation).toBe("local");
  });
  test("明示ロールを3値へ写像する", () => {
    const view = mkView({
      provider: "env",
      roles: {
        conversation: { provider: "openai-compat", baseUrl: "http://x/v1", model: "m", codexModel: null },
        coaching: { provider: "claude", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "codex", baseUrl: null, model: null, codexModel: "c" },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
    });
    expect(hydrateTargets(view)).toEqual({ conversation: "local", coaching: "claude", generation: "codex", assessment: "claude" });
  });
});

describe("hydrateConnection", () => {
  test("llm_settings から接続入力を復元する", () => {
    const view = mkView({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" });
    expect(hydrateConnection(view)).toEqual({ baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" });
  });
  test("llm_settings に無ければロール行からフォールバックする", () => {
    const view = mkView({
      provider: "env",
      roles: {
        conversation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: null },
        coaching: { provider: "codex", baseUrl: null, model: null, codexModel: "gpt-5-codex" },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
    });
    expect(hydrateConnection(view)).toEqual({ baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" });
  });
  test("何も無ければ空文字", () => {
    expect(hydrateConnection(mkView())).toEqual({ baseUrl: "", model: "", codexModel: "" });
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd app && bun test llm-assignments`
Expected: FAIL — `./llm-assignments` が存在しない（Cannot find module）。

- [ ] **Step 3: 純ロジックモジュールを実装する**

`app/client/src/lib/llm-assignments.ts` を作成する。

```ts
import { LLM_ROLES, type LlmRole, type LlmRolesInput, type LlmSettingsView } from "../api";

/** ロール割当の3値（UI が直接選ぶ）。inherit/env は UI に出さない。 */
export type RoleTarget = "claude" | "local" | "codex";
export type RoleTargets = Record<LlmRole, RoleTarget>;

/** 接続入力（接続セクションの3フィールド。空文字＝未指定）。 */
export type Connection = { baseUrl: string; model: string; codexModel: string };

/** プリセット識別子。 */
export type PresetId = "all-local" | "balanced" | "high-quality";

/**
 * プリセットのロール割当（固定）。バランスは会話・教材生成=ローカル / コーチング・測定=Claude。
 * 測定は Claude との品質差が最大かつ低頻度のため Claude 側に含める。
 */
export const PRESETS: Record<PresetId, RoleTargets> = {
  "all-local": { conversation: "local", coaching: "local", generation: "local", assessment: "local" },
  balanced: { conversation: "local", coaching: "claude", generation: "local", assessment: "claude" },
  "high-quality": { conversation: "claude", coaching: "claude", generation: "claude", assessment: "claude" },
};

/** baseUrl と model が両方非空ならローカル接続は定義済み。 */
export function isLocalDefined(conn: Connection): boolean {
  return conn.baseUrl.trim().length > 0 && conn.model.trim().length > 0;
}

/** ローカルを含むプリセットはローカル定義が必要。high-quality は常に可。 */
export function presetEnabled(id: PresetId, conn: Connection): boolean {
  if (id === "high-quality") return true;
  return isLocalDefined(conn);
}

/** llm_settings.provider（env は envProvider へ解決）を effective global provider として返す。 */
function effectiveGlobalProvider(view: LlmSettingsView): string {
  return view.provider === "env" ? view.envProvider : view.provider;
}

/** GET 応答から接続入力を復元する（llm_settings 優先・ロール行フォールバック）。 */
export function hydrateConnection(view: LlmSettingsView): Connection {
  const roleList = LLM_ROLES.map((r) => view.roles[r]);
  const localRole = roleList.find((r) => r.provider === "openai-compat" && r.baseUrl && r.model);
  const codexRole = roleList.find((r) => r.provider === "codex" && r.codexModel);
  return {
    baseUrl: view.baseUrl ?? localRole?.baseUrl ?? "",
    model: view.model ?? localRole?.model ?? "",
    codexModel: view.codexModel ?? codexRole?.codexModel ?? "",
  };
}

/** GET 応答からロール割当（3値）を復元する。inherit は effective global を辿る。 */
export function hydrateTargets(view: LlmSettingsView): RoleTargets {
  const global = effectiveGlobalProvider(view);
  const out = {} as RoleTargets;
  for (const role of LLM_ROLES) {
    const raw = view.roles[role].provider;
    const p = raw === "inherit" ? global : raw;
    out[role] = p === "openai-compat" ? "local" : p === "codex" ? "codex" : "claude";
  }
  return out;
}

/**
 * (targets, conn) を PUT /api/llm-settings/roles のペイロードへ直列化する。
 * - 接続は常に global（接続ストア）に保存する＝プリセット/割当保存でも接続は失われない。
 * - ローカル未定義のとき local ターゲットは claude にフォールバックする（空 baseUrl で 400 になるのを防ぐ）。
 */
export function buildRolesPayload(targets: RoleTargets, conn: Connection): LlmRolesInput {
  const baseUrl = conn.baseUrl.trim();
  const model = conn.model.trim();
  const codexModel = conn.codexModel.trim() || null;
  const localDefined = baseUrl.length > 0 && model.length > 0;

  const global: LlmRolesInput["global"] = localDefined
    ? { provider: "openai-compat", baseUrl, model, codexModel }
    : codexModel
    ? { provider: "codex", codexModel }
    : { provider: "env" };

  const roles = {} as NonNullable<LlmRolesInput["roles"]>;
  for (const role of LLM_ROLES) {
    const t = !localDefined && targets[role] === "local" ? "claude" : targets[role];
    roles[role] =
      t === "local" ? { provider: "openai-compat", baseUrl, model }
      : t === "codex" ? { provider: "codex", codexModel }
      : { provider: "claude" };
  }
  return { global, roles };
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd app && bun test llm-assignments`
Expected: PASS（全 describe 緑）。

- [ ] **Step 5: 検証ゲート**

Run: `cd app && bun test && cd client && bun run build`
Expected: 全緑・ビルド成功（新モジュールの型が通る）。

- [ ] **Step 6: コミット**

```bash
git add app/client/src/lib/llm-assignments.ts app/client/src/lib/llm-assignments.test.ts
git commit -m "feat: LLM 設定 v2 の接続/割当の直列化・読み替え純ロジックを追加"
```

---

## Task 3: クライアント — v2 の i18n キーを追加する（型 + EN + JA）

このタスクは**追加のみ**（旧キーは Task 4 で参照を消してから削除する）。追加後も既存 SettingsScreen が旧キーを参照し続けるため typecheck/build は緑のまま。

**Files:**
- Modify: `app/client/src/i18n.ts`（型 `SettingsStrings.settings` + `STR.en.settings` + `STR.ja.settings`）

**Interfaces:**
- Produces: `s.settings.{presetSection,presetAllLocal,presetAllLocalDesc,presetBalanced,presetBalancedBadge,presetBalancedDesc,presetHighQuality,presetHighQualityDesc,presetLocalRequired,connectionSection,claudeNoSetup,localConnTitle,codexConnTitle,roleAssignSection,roleAssignDesc,targetClaude,targetLocal,targetCodex,targetLocalDisabled,saveConnection,saveAssignments}`。

- [ ] **Step 1: 型に v2 キーを追加する**

`app/client/src/i18n.ts` の `type SettingsStrings = { settings: { ... } }` 内、`saveRoles: string;`（現 85 行）の直後に次を追加する。

```ts
    presetSection: string;
    presetAllLocal: string;
    presetAllLocalDesc: string;
    presetBalanced: string;
    presetBalancedBadge: string;
    presetBalancedDesc: string;
    presetHighQuality: string;
    presetHighQualityDesc: string;
    presetLocalRequired: string;
    connectionSection: string;
    claudeNoSetup: string;
    localConnTitle: string;
    codexConnTitle: string;
    roleAssignSection: string;
    roleAssignDesc: string;
    targetClaude: string;
    targetLocal: string;
    targetCodex: string;
    targetLocalDisabled: string;
    saveConnection: string;
    saveAssignments: string;
```

- [ ] **Step 2: EN 辞書に v2 値を追加する**

`STR.en` の `settings: { ... }` 内、`saveRoles: "Save per-role settings",`（現 336 行）の直後に次を追加する。

```ts
      presetSection: "Presets",
      presetAllLocal: "All local",
      presetAllLocalDesc: "Every role uses your local model.",
      presetBalanced: "Balanced",
      presetBalancedBadge: "Recommended",
      presetBalancedDesc: "Conversation and content generation run locally; coaching and assessment use Claude, where the quality gap is largest and the usage least frequent.",
      presetHighQuality: "Best quality",
      presetHighQualityDesc: "Every role uses Claude, the tested baseline.",
      presetLocalRequired: "Add a local LLM connection below to enable the local presets.",
      connectionSection: "Connections",
      claudeNoSetup: "Claude needs no setup — it works with your Claude subscription.",
      localConnTitle: "Local LLM (OpenAI-compatible)",
      codexConnTitle: "Codex (optional)",
      roleAssignSection: "Model per role",
      roleAssignDesc: "Choose which model handles each role.",
      targetClaude: "Claude",
      targetLocal: "Local",
      targetCodex: "Codex",
      targetLocalDisabled: "Add a local LLM connection above to choose Local.",
      saveConnection: "Save connections",
      saveAssignments: "Save assignments",
```

- [ ] **Step 3: JA 辞書に v2 値を追加する**

`STR.ja` の `settings: { ... }` 内、`saveRoles: "用途別設定を保存",`（現 644 行）の直後に次を追加する。

```ts
      presetSection: "プリセット",
      presetAllLocal: "オールローカル",
      presetAllLocalDesc: "すべての用途をローカルモデルで動かします。",
      presetBalanced: "バランス",
      presetBalancedBadge: "推奨",
      presetBalancedDesc: "会話・教材生成はローカル、コーチング・測定は品質差が最も大きく実行頻度も低いため Claude を使います。",
      presetHighQuality: "最高品質",
      presetHighQualityDesc: "すべての用途を Claude（動作確認済みの基準）で動かします。",
      presetLocalRequired: "下でローカル LLM の接続先を設定すると、ローカルを使うプリセットが選べます。",
      connectionSection: "接続",
      claudeNoSetup: "Claude は設定不要です（Claude のサブスクリプションで動作します）。",
      localConnTitle: "ローカル LLM（OpenAI 互換）",
      codexConnTitle: "Codex（任意）",
      roleAssignSection: "用途ごとのモデル",
      roleAssignDesc: "各用途をどのモデルに任せるか選びます。",
      targetClaude: "Claude",
      targetLocal: "ローカル",
      targetCodex: "Codex",
      targetLocalDisabled: "ローカルを選ぶには、上でローカル LLM の接続先を設定します。",
      saveConnection: "接続を保存",
      saveAssignments: "割当を保存",
```

- [ ] **Step 4: 検証ゲート（追加のみ・緑のはず）**

Run: `cd app/client && bun run build`
Expected: 成功（型 + en + ja が揃い、既存 SettingsScreen は旧キーを参照し続けるため未破綻）。

- [ ] **Step 5: コミット**

```bash
git add app/client/src/i18n.ts
git commit -m "feat: LLM 設定 v2 の i18n キー（接続/割当/プリセット）を追加"
```

---

## Task 4: クライアント — 設定画面「言語モデル」節を v2 に再構成し旧キーを削除する

**Files:**
- Modify（全面差し替え）: `app/client/src/screens/SettingsScreen.tsx`
- Modify（旧キー削除）: `app/client/src/i18n.ts`

**Interfaces:**
- Consumes: Task 2 の `../lib/llm-assignments`（`PRESETS` / `isLocalDefined` / `presetEnabled` / `hydrateConnection` / `hydrateTargets` / `buildRolesPayload` と型）、Task 3 の新 i18n キー、`../api` の `saveLlmRoleSettings` / `fetchLlmSettings`。
- Produces: 接続 / 用途ごとのモデル / プリセット3種を持つ設定画面。全書き込みは `PUT /api/llm-settings/roles`（`saveLlmRoleSettings`）経由。

- [ ] **Step 1: SettingsScreen.tsx を差し替える**

`app/client/src/screens/SettingsScreen.tsx` の全内容を次で置換する（TTS・表示節は現行と同一・言語モデル節のみ再構成）。

```tsx
import { useEffect, useRef, useState } from "react";
import {
  fetchLlmSettings, saveLlmRoleSettings, LLM_ROLES,
  fetchTtsSettings, saveTtsSettings,
  type LlmRole, type LlmSettingsView, type TtsSettingsView,
} from "../api";
import {
  PRESETS, isLocalDefined, presetEnabled, hydrateConnection, hydrateTargets, buildRolesPayload,
  type RoleTarget, type RoleTargets, type Connection, type PresetId,
} from "../lib/llm-assignments";
import { STR, type Lang } from "../i18n";
import { Button } from "../ui/Button";

export type UiScale = "small" | "medium" | "large" | "xlarge";

type Props = {
  lang: Lang;
  uiScale: UiScale;
  setUiScale: (s: UiScale) => void;
  switchLang: (l: Lang) => void;
};

type VoiceProviderKind = "kokoro" | "openai";
const VOICE_PRESETS: Record<VoiceProviderKind, { female: string; male: string }> = {
  kokoro: { female: "af_heart", male: "am_michael" },
  openai: { female: "nova", male: "onyx" },
};
const VOICE_PRESET_FEMALE_VALUES = Object.values(VOICE_PRESETS).map((p) => p.female);
const VOICE_PRESET_MALE_VALUES = Object.values(VOICE_PRESETS).map((p) => p.male);

/** baseUrl から音声プロバイダを推定する（8880 または kokoro を含めば Kokoro系、それ以外は OpenAI系）。 */
function detectVoiceProviderKind(baseUrl: string): VoiceProviderKind {
  const lower = baseUrl.toLowerCase();
  return lower.includes("8880") || lower.includes("kokoro") ? "kokoro" : "openai";
}

/** 1ロールの割当トグル（Claude / ローカル / Codex）。ローカル未定義時はローカルを非活性 + 中立案内。 */
function RoleTargetToggle(props: {
  value: RoleTarget;
  localEnabled: boolean;
  labels: Record<RoleTarget, string>;
  localDisabledNote: string;
  ariaLabel: string;
  onChange: (t: RoleTarget) => void;
}) {
  const order: RoleTarget[] = ["claude", "local", "codex"];
  return (
    <div className="stack">
      <div className="lang-toggle llm-provider-toggle" role="group" aria-label={props.ariaLabel}>
        {order.map((t) => (
          <button
            key={t}
            className={props.value === t ? "is-active" : ""}
            disabled={t === "local" && !props.localEnabled}
            onClick={() => props.onChange(t)}
          >
            {props.labels[t]}
          </button>
        ))}
      </div>
      {!props.localEnabled && <div className="text-sm text-muted">{props.localDisabledNote}</div>}
    </div>
  );
}

export function SettingsScreen({ lang, uiScale, setUiScale, switchLang }: Props) {
  const s = STR[lang];
  const [view, setView] = useState<LlmSettingsView | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fetchedRef = useRef(false);

  // 接続の編集状態
  const [connBaseUrl, setConnBaseUrl] = useState("");
  const [connModel, setConnModel] = useState("");
  const [connCodex, setConnCodex] = useState("");
  // ロール割当の編集状態（3値）
  const [targets, setTargets] = useState<RoleTargets>({
    conversation: "claude", coaching: "claude", generation: "claude", assessment: "claude",
  });
  // 音声（TTS）の編集状態
  const [ttsView, setTtsView] = useState<TtsSettingsView | null>(null);
  const [ttsBaseUrl, setTtsBaseUrl] = useState("");
  const [ttsModel, setTtsModel] = useState("");
  const [ttsVoice, setTtsVoice] = useState("");

  function hydrate(v: LlmSettingsView) {
    setView(v);
    const conn = hydrateConnection(v);
    setConnBaseUrl(conn.baseUrl);
    setConnModel(conn.model);
    setConnCodex(conn.codexModel);
    setTargets(hydrateTargets(v));
  }

  function hydrateTts(v: TtsSettingsView) {
    setTtsView(v);
    setTtsBaseUrl(v.baseUrl ?? "");
    setTtsModel(v.model ?? "");
    setTtsVoice(v.voice ?? "");
  }

  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchLlmSettings().then(hydrate).catch(() => {});
    fetchTtsSettings().then(hydrateTts).catch(() => {});
  }, []);

  const conn: Connection = { baseUrl: connBaseUrl, model: connModel, codexModel: connCodex };
  const localDefined = isLocalDefined(conn);

  function applyResult(v: LlmSettingsView) {
    hydrate(v);
    setResult(v.applied === false ? s.llm.notApplied(v.error ?? "") : s.llm.applied);
  }

  async function persist(nextTargets: RoleTargets, nextConn: Connection) {
    setSaving(true); setResult(null);
    try {
      applyResult(await saveLlmRoleSettings(buildRolesPayload(nextTargets, nextConn)));
    } catch { setResult(s.llm.saveFailed); } finally { setSaving(false); }
  }

  function applyPreset(id: PresetId) {
    const next = PRESETS[id];
    setTargets(next);
    void persist(next, conn);
  }

  function setTarget(role: LlmRole, t: RoleTarget) {
    setTargets((prev) => ({ ...prev, [role]: t }));
  }

  const voicePreset: "female" | "male" | "custom" = VOICE_PRESET_FEMALE_VALUES.includes(ttsVoice.trim())
    ? "female"
    : VOICE_PRESET_MALE_VALUES.includes(ttsVoice.trim())
    ? "male"
    : "custom";

  function applyVoicePreset(kind: "female" | "male") {
    setTtsVoice(VOICE_PRESETS[detectVoiceProviderKind(ttsBaseUrl)][kind]);
  }

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

  const targetLabels: Record<RoleTarget, string> = {
    claude: s.settings.targetClaude, local: s.settings.targetLocal, codex: s.settings.targetCodex,
  };

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{s.settings.title}</h2>
      </div>

      {/* 言語モデル */}
      <section className="support-panel stack">
        <div className="stat-title">{s.settings.llmSection}</div>

        {/* プリセット（最上部・ロール割当を書くだけ） */}
        <div className="stack">
          <div className="stat-title">{s.settings.presetSection}</div>
          <div className="text-sm text-muted">{s.settings.presetAllLocalDesc}</div>
          <Button variant="secondary" onClick={() => applyPreset("all-local")} disabled={saving || !view || !presetEnabled("all-local", conn)}>{s.settings.presetAllLocal}</Button>
          <div className="text-sm">{s.settings.presetBalancedBadge}</div>
          <div className="text-sm text-muted">{s.settings.presetBalancedDesc}</div>
          <Button variant="primary" onClick={() => applyPreset("balanced")} disabled={saving || !view || !presetEnabled("balanced", conn)}>{s.settings.presetBalanced}</Button>
          <div className="text-sm text-muted">{s.settings.presetHighQualityDesc}</div>
          <Button variant="secondary" onClick={() => applyPreset("high-quality")} disabled={saving || !view}>{s.settings.presetHighQuality}</Button>
          {!localDefined && <div className="text-sm text-muted">{s.settings.presetLocalRequired}</div>}
        </div>

        {/* 接続（ローカル LLM / Codex を定義する場所） */}
        <div className="stack">
          <div className="stat-title">{s.settings.connectionSection}</div>
          <div className="text-sm text-muted">{s.settings.claudeNoSetup}</div>
          <div className="llm-fields stack">
            <div className="text-sm">{s.settings.localConnTitle}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.baseUrlLabel}</span>
              <input className="llm-input" value={connBaseUrl} placeholder={s.llm.baseUrlPlaceholder} onChange={(e) => setConnBaseUrl(e.target.value)} />
            </label>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.modelLabel}</span>
              <input className="llm-input" value={connModel} placeholder={s.llm.modelPlaceholder} onChange={(e) => setConnModel(e.target.value)} />
            </label>
            <div className="text-sm text-muted">{view?.apiKeyConfigured ? s.llm.apiKeyConfigured : s.llm.apiKeyMissing}</div>
          </div>
          <div className="llm-fields stack">
            <div className="text-sm">{s.settings.codexConnTitle}</div>
            <label className="llm-field">
              <span className="text-sm text-muted">{s.llm.codexModelLabel}</span>
              <input className="llm-input" value={connCodex} placeholder={s.llm.codexModelPlaceholder} onChange={(e) => setConnCodex(e.target.value)} />
            </label>
          </div>
          <div className="text-sm text-muted">{s.llm.help}</div>
          <Button variant="secondary" onClick={() => persist(targets, conn)} disabled={saving || !view}>{saving ? s.llm.saving : s.settings.saveConnection}</Button>
        </div>

        {/* 用途ごとのモデル（ロール割当） */}
        <div className="stack">
          <div className="stat-title">{s.settings.roleAssignSection}</div>
          <div className="text-sm text-muted">{s.settings.roleAssignDesc}</div>
          {LLM_ROLES.map((role) => (
            <div key={role} className="stack">
              <div className="text-sm">{s.settings.roleName[role]}</div>
              <div className="text-sm text-muted">{s.settings.roleDesc[role]}</div>
              <RoleTargetToggle
                value={targets[role]}
                localEnabled={localDefined}
                labels={targetLabels}
                localDisabledNote={s.settings.targetLocalDisabled}
                ariaLabel={s.settings.roleName[role]}
                onChange={(t) => setTarget(role, t)}
              />
            </div>
          ))}
          <Button variant="secondary" onClick={() => persist(targets, conn)} disabled={saving || !view}>{saving ? s.llm.saving : s.settings.saveAssignments}</Button>
        </div>

        {result && <div className="info-pop" role="status">{result}</div>}
      </section>

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
          <div className="llm-field">
            <span className="text-sm text-muted">{s.settings.ttsVoicePresetLabel}</span>
            <div className="lang-toggle" role="group" aria-label={s.settings.ttsVoicePresetLabel}>
              <button className={voicePreset === "female" ? "is-active" : ""} disabled={!ttsView} onClick={() => applyVoicePreset("female")}>{s.settings.ttsVoiceFemale}</button>
              <button className={voicePreset === "male" ? "is-active" : ""} disabled={!ttsView} onClick={() => applyVoicePreset("male")}>{s.settings.ttsVoiceMale}</button>
              <button className={voicePreset === "custom" ? "is-active" : ""} disabled={!ttsView}>{s.settings.ttsVoiceCustom}</button>
            </div>
            <span className="text-sm text-muted">{s.settings.ttsVoicePresetNote}</span>
          </div>
          <label className="llm-field">
            <span className="text-sm text-muted">{s.settings.ttsVoiceLabel}</span>
            <input className="llm-input" value={ttsVoice} placeholder={s.settings.ttsVoicePlaceholder} onChange={(e) => setTtsVoice(e.target.value)} />
          </label>
          <div className="text-sm text-muted">{ttsView?.apiKeyConfigured ? s.settings.ttsApiKeyConfigured : s.settings.ttsApiKeyOptional}</div>
        </div>
        <Button variant="secondary" onClick={onSaveTts} disabled={saving || !ttsView}>{saving ? s.llm.saving : s.llm.save}</Button>
        <div className="text-sm text-muted">{s.settings.ttsResetDesc}</div>
        <Button variant="secondary" onClick={onResetTts} disabled={saving || !ttsView}>{s.settings.ttsReset}</Button>
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

- [ ] **Step 2: typecheck + build を実行して緑を確認する（旧キーはまだ型に残存）**

Run: `cd app/client && bun run build`
Expected: 成功。SettingsScreen が新キーのみ参照し、旧キーは i18n 型に残っているため未破綻。

- [ ] **Step 3: 旧 settings キーの参照が消えたことを確認する**

Run: `cd app/client && grep -rn "connectionTitle\|presetTitle\|recommendApply\|recommendDesc\|recommendDisabled\|resetApply\|resetDesc\|rolesTitle\|rolesSummary\|optInherit\|saveRoles" src --include="*.tsx" --include="*.ts" | grep -v i18n.ts`
Expected: 出力なし（i18n.ts の定義以外に参照が無い）。

- [ ] **Step 4: 旧 settings キーを型 + EN + JA から削除する**

`app/client/src/i18n.ts` の3箇所（型 `SettingsStrings.settings` / `STR.en.settings` / `STR.ja.settings`）から、11キーに対応する**各行を1行ずつ個別に削除する**（各行は全体で一意なので単純な行削除で足りる）。

> **重要（転記ハザード注意）**: これら11キーは連続ブロックではない。3箇所いずれも `roleName` と `roleDesc` の定義が削除対象キーの**間に挟まっている**（型では `rolesSummary` の次が `roleName`/`roleDesc`、その次が `optInherit`）。**`roleName` / `roleDesc` / `llmSection` / `title` は必ず残す**。連続ブロックとして一括削除せず、以下の各行を個別に削除すること。

型 `SettingsStrings.settings`（現 73-85 行相当）で削除する各行:
```ts
    connectionTitle: string;
    presetTitle: string;
    recommendApply: string;
    recommendDesc: string;
    recommendDisabled: string;
    resetApply: string;
    resetDesc: string;
    rolesTitle: string;
    rolesSummary: string;
    optInherit: string;
    saveRoles: string;
```

`STR.en.settings`（現 314-336 行相当）で削除する各行:
```ts
      connectionTitle: "Overall provider",
      presetTitle: "Quick setup",
      recommendApply: "Apply recommended setup",
      recommendDesc: "Use your local model for casual conversation and keep the tested default for coaching, content, and assessment.",
      recommendDisabled: "Connect a local LLM above first to enable the recommended setup.",
      resetApply: "Reset everything to default",
      resetDesc: "Set the overall provider to the environment default and let every role follow it.",
      rolesTitle: "Per-role model (advanced)",
      rolesSummary: "Set a different model per role",
      optInherit: "Follow overall",
      saveRoles: "Save per-role settings",
```

`STR.ja.settings`（現 622-644 行相当）で削除する各行:
```ts
      connectionTitle: "全体の接続先",
      presetTitle: "かんたん設定",
      recommendApply: "推奨構成を適用",
      recommendDesc: "自由会話はローカルモデルに任せ、添削・教材生成・測定は動作確認済みの既定のままにします。",
      recommendDisabled: "先に上でローカルLLMを接続すると推奨構成が使えます。",
      resetApply: "すべて既定に戻す",
      resetDesc: "全体の接続先を環境変数の既定に戻し、各ロールはそれに従います。",
      rolesTitle: "用途別モデル（詳細）",
      rolesSummary: "ロールごとに別のモデルを指定する",
      optInherit: "全体に従う",
      saveRoles: "用途別設定を保存",
```

削除後、各 `settings` オブジェクト内で `roleName` の直前は `llmSection`（型では `llmSection` の次が直接 `roleName`）、`roleDesc` の直後は Task 3 で追加した `presetSection` 以降の新キー、という並びになる。

> 備考: `llm.optEnv` / `llm.providerLabel` / `llm.envNote` / `llm.helpAria` は v2 UI では未使用になるが、`llm` 名前空間には手を入れず温存する（`llm.title` 等の周辺キーへの巻き込み削除を避けるため。未使用キーは無害）。**既存の残存キーの日本語文言は一字一句変更しない。**

- [ ] **Step 5: 検証ゲート（削除後）**

Run: `cd app && bun test && bun run typecheck && cd client && bun run build`
Expected: 全緑。削除キーへの参照が無いため typecheck 成功。

- [ ] **Step 6: 実機スモーク（任意・HMR 停止に注意）**

Run: `cd app/client && bun run build`（dist 直配信のため即反映）。ブラウザで「⚙️ 設定 → 言語モデル」を開き、(1) 接続にローカル baseUrl/model を保存 → プリセット オールローカル/バランスが活性、(2) バランス適用後にロール割当が会話/教材生成=ローカル・コーチング/測定=Claude、(3) 最高品質適用後も接続入力が残る、を目視確認。
Expected: 上記のとおり表示・保存できる。

- [ ] **Step 7: コミット**

```bash
git add app/client/src/screens/SettingsScreen.tsx app/client/src/i18n.ts
git commit -m "feat: 設定の言語モデルを接続/用途ごとのモデル/プリセット3種に再構成"
```

---

## Task 5: ドキュメント — CHANGELOG v0.21.0 + README「LLM プロバイダの切替」節の再構成

**Files:**
- Modify: `CHANGELOG.md`（先頭に v0.21.0 エントリ）
- Modify: `README.md`（UI 説明の再構成・env 表と env 直接運用の注意は温存）

**Interfaces:**
- Consumes: Task 1-4 の最終挙動。
- Produces: ユーザー視点の CHANGELOG・現行 UI に一致する README。

- [ ] **Step 1: CHANGELOG に v0.21.0 を追記する**

`CHANGELOG.md` の `## [0.20.0] - 2026-07-08` の**直前**に次を挿入する。

```markdown
## [0.21.0] - 2026-07-08

### Changed

- **設定「言語モデル」を接続とロール割当に再構成 + プリセット3種**: 「⚙️ 設定 → 言語モデル」を **接続**（ローカル LLM の Base URL・モデル名と Codex の任意モデル名を一度だけ定義）と **用途ごとのモデル**（会話 / コーチング / 教材生成 / 測定の4用途がそれぞれ **Claude / ローカル / Codex** を直接選ぶ）に分けた。最上部に **プリセット3種**（**オールローカル** / **バランス〔推奨〕** / **最高品質**）を追加し、ワンタップで4用途の割当をまとめて設定できる。バランスは会話・教材生成をローカル、コーチング・測定を Claude に割り当てる（測定は品質差が最も大きく実行頻度も低いため Claude 側）。ローカルの接続先が未設定のときはローカルを使うプリセット・選択肢を中立に非活性化して案内する。Claude はサブスクリプションで動くため接続設定は不要。**最高品質を選んでもローカル接続の定義は保持**され、いつでもローカルに戻せる。**設定を何も変えなければ挙動は従来と完全に同一**（既存のローカル接続・全用途ローカルの状態はそのまま表示・動作する）。`app/.env` の `LLM_PROVIDER` 等による env 直接運用は従来どおり。**APIキーは従来どおり UI・DB・API 応答・ログに一切載せず `app/.env` の `OPENAI_COMPAT_API_KEY` のみ**
```

- [ ] **Step 2: README 149 行（切替の導入段落）を差し替える**

`README.md` の現 149 行（`コーチ・会話・コンテンツ生成が使う LLM バックエンドは…「既定（環境変数）」を選ぶと `app/.env` の `LLM_PROVIDER` に従う状態へ戻る。`）を次で置換する。

```markdown
コーチ・会話・コンテンツ生成が使う LLM バックエンドは環境変数 `LLM_PROVIDER` で切り替えられる。既定（未設定 or `claude`）は Anthropic Claude Agent SDK で、現行と完全に同一の挙動。env 直接運用（ヘッドレス・CLI）の設定は `app/.env`（gitignore 済み）に置く。LaunchAgent の plist には秘密情報を書かない。ふだんの切替は「記録・測定」の **⚙️ 設定 → 言語モデル**から行い、保存すると実行中のアプリへ再起動なしで即時適用される（設定は SQLite の `llm_settings`〔接続〕・`llm_role_settings`〔ロール割当〕に保存。**APIキーは UI・DB には保存されず `app/.env` の `OPENAI_COMPAT_API_KEY` のみ**）。
```

- [ ] **Step 3: README 151 行（用途別ルーティングの見出し段落）を差し替える**

現 151 行（`**用途別ルーティング（設定画面）**: サイドバー「記録・測定」の **⚙️ 設定 → 言語モデル**で、LLM 呼び出しを4つの用途ロールに分けて別々のプロバイダに割り当てられる。`）を次で置換する。

```markdown
**設定画面の構成（接続 / 用途ごとのモデル / プリセット）**: **⚙️ 設定 → 言語モデル**は3つに分かれる。**接続**でローカル LLM（OpenAI 互換）の Base URL・モデル名と Codex の任意モデル名を一度だけ定義する（Claude はサブスクリプションで動くため設定不要）。**用途ごとのモデル**で、LLM 呼び出しを4つの用途に分け、それぞれ **Claude / ローカル / Codex** を直接割り当てる。**プリセット**は割当をワンタップで書き換えるボタン。
```

- [ ] **Step 4: README 162 行（推奨構成/すべて既定の段落）を差し替える**

現 162 行（`各ロールの既定は「全体に従う（inherit）」で、…**設定を何も変えなければ全ロール inherit のままで、現行と完全に同一の挙動**。`）を次で置換する。

```markdown
プリセットは3種。**オールローカル**（全用途=ローカル）、**バランス〔推奨〕**（会話・教材生成=ローカル / コーチング・測定=Claude）、**最高品質**（全用途=Claude）。バランスが測定を Claude にするのは、測定〔レベル測定・月次レビュー〕が Claude との品質差が最も大きく実行頻度も低いため（高頻度・低リスクの会話や教材生成はローカルで速く安く、品質が要る用途は動作確認済みの Claude に寄せる配分）。ローカルの接続先が未設定のときはローカルを使うプリセット・選択肢が中立に非活性化される。**最高品質を選んでもローカル接続の定義は保持**され、いつでもローカルに戻せる。接続は `llm_settings`、ロール割当は `llm_role_settings` に保存し、APIキーは持たせない（`app/.env` のみ）。**設定を何も変えなければ挙動は現行と完全に同一**（既存のローカル接続・全用途ローカルの状態はそのまま表示・動作する）。env のみで運用する場合は下表の `LLM_PROVIDER` を `app/.env` に直接置けば従来どおり動く。
```

- [ ] **Step 5: README 189 行（Ollama 例の保存手順）を差し替える**

現 189 行（`**⚙️ 設定 → 言語モデル**で **OpenAI 互換** を選び、Base URL `http://localhost:11434/v1`・モデル名 `qwen3:30b-instruct` を保存すれば完了（Ollama は API キー不要なので「キー未設定」表示のままで正常）。`）を次で置換する。

```markdown
**⚙️ 設定 → 言語モデル → 接続**の「ローカル LLM（OpenAI 互換）」に Base URL `http://localhost:11434/v1`・モデル名 `qwen3:30b-instruct` を入力して保存すれば完了（Ollama は API キー不要なので「キー未設定」表示のままで正常）。あとはプリセット **オールローカル**（全部ローカル）や **バランス**（会話・教材生成だけローカル）で用途割当を一括設定できる。
```

- [ ] **Step 6: README 192 行（使い分けの目安）を差し替える**

現 192 行（`- **使い分けの目安**: 会話相手・ロールプレイ・訳はローカル 30B 級で実用的。…前述「推奨構成を適用」で一括設定できる）。`）を次で置換する。

```markdown
- **使い分けの目安**: 会話相手・ロールプレイ・訳はローカル 30B 級で実用的。添削の日本語解説・月次レビュー・レベル測定は Claude の品質が明確に上なので、**⚙️ 設定 → 言語モデル**の**用途ごとのモデル**で品質が要る用途だけ Claude に寄せる運用がおすすめ（プリセット **バランス** で一括設定できる）。
```

- [ ] **Step 7: README 差分チェック（AGENTS.md リリース手順）**

Run: `cd <repo-root> && grep -n "推奨構成\|すべて既定\|全体の接続先\|全体に従う\|既定（環境変数）\|OpenAI 互換 を選び" README.md`
Expected: 出力なし（旧 UI 文言が README に残っていない。env 表〔166-173 行〕・env 直接運用の注意〔175-180 行〕は温存されていること・用途表〔153-158 行〕はそのままで可）。

- [ ] **Step 8: 検証ゲート（全体最終）**

Run: `cd app && bun test && bun run typecheck && cd client && bun run build`
Expected: 全緑。

- [ ] **Step 9: コミット**

```bash
git add CHANGELOG.md README.md
git commit -m "docs: v0.21.0（LLM 設定の接続/割当分離 + プリセット3種）を CHANGELOG と README に反映"
```

---

## Self-Review

**1. Spec coverage（team-lead 承認済み設計との突き合わせ）:**

- 「全体の接続先」概念を UI から廃止 → Task 4（provider トグル削除・接続セクション化）。✅
- 接続セクション（ローカル baseUrl/model + Codex 任意 model・Claude 定義不要） → Task 4 接続節 + Task 3 i18n（`localConnTitle`/`codexConnTitle`/`claudeNoSetup`）。✅
- ロール割当セクション（4ロールが Claude/ローカル/Codex を直接選択・inherit/env を出さない・ローカル未定義時は中立案内） → Task 4 `RoleTargetToggle` + Task 2 `hydrateTargets` + i18n `target*`。✅
- プリセット3種（最上部・オールローカル/バランス〔推奨〕/最高品質・ローカル未定義時に該当を非活性 + 案内） → Task 2 `PRESETS`/`presetEnabled` + Task 4 プリセット節。✅
- バランスに測定を含める理由の明記 → 「設計: プリセット」節 + PRESETS のコメント + CHANGELOG/README。✅
- データモデルの読み替え（llm_settings=接続ストア・llm_role_settings=割当・env/inherit 温存・旧 API 形状不変） → 「設計: データモデルの読み替え」節 + Task 1（codexModel 保持のみ）。✅
- 既存ユーザーの無挙動変化・自然表示（マイグレーション不要） → 「既存ユーザーの初回表示」節 + Task 2 `hydrateTargets`/`hydrateConnection` + テスト。✅
- サーバ解決ロジック無変更／最小サーバ変更の明記 → Task 1（`parseSettingsInput` の1点のみ・理由と後方互換を明記）。✅
- TTS・表示節は不変 → Task 4 で現行を逐語保持。✅
- env 直接運用は従来どおり／README の env 表温存 → Task 5（表・注意を残し UI 説明のみ再構成）。✅
- named 型 i18n EN/JA・既存 JA キー不変・再構成に伴う変更を列挙 → Task 3（追加）+ Task 4 Step 4（削除11キーを逐語列挙）。✅
- TDD → Task 1（サーバ赤→緑）・Task 2（クライアント純ロジック赤→緑）。✅
- docs ゲート（CHANGELOG v0.21.0 + README） → Task 5。✅
- typecheck ゲートと index.ts/routes.ts 配線の分離矛盾を作らない → 新ルート/新 deps を足さないため配線変更なし（「File Structure 無変更」に明記）。✅

**2. Placeholder scan:** 各コード step は完全なコードを含む（TBD・「適切に処理」・「Task N と同様」なし）。i18n の追加/削除は逐語の行を列挙。README/CHANGELOG は置換後テキストを逐語提示。✅

**3. Type consistency:**
- `RoleTarget`/`RoleTargets`/`Connection`/`PresetId` は Task 2 で定義し Task 4 が同名で consume。✅
- `buildRolesPayload`/`hydrateConnection`/`hydrateTargets`/`isLocalDefined`/`presetEnabled`/`PRESETS` の名前は Task 2 定義と Task 4 使用で一致。✅
- `LlmRolesInput`（`{ global?, roles? }`）・`LlmSettingsView` は `app/client/src/api/llm-settings.ts` の既存 export（`api/index.ts` が `export * from "./llm-settings"`）。`buildRolesPayload` の戻り値は `LlmRolesInput` に構造一致（`global` は `LlmSettingsInput`、`roles` は `Partial<Record<LlmRole, LlmRoleInput>>` で `baseUrl`/`model`/`codexModel` は任意）。✅
- サーバの `ParsedSettings`（`{ provider; baseUrl; model; codexModel }`）は Task 1 変更後も同形状。既存テスト（codexModel 未送信→null）と後方互換。✅
- Task 4 は `saveLlmSettings`/`ProviderEditor`/`GLOBAL_PROVIDERS`/`ROLE_PROVIDERS`/`onRecommended`/`onResetAll` を削除。これらは他ファイルから参照されない（`grep` 済み: `llm-settings` API 消費は SettingsScreen のみ）。✅

**確認済みの前提（実装者向けメモ）:**
- `viewOf` は provider 非依存で `s.codexModel` を返すため、Task 1 のみで openai-compat 接続の codexModel が GET 往復する（応答形状不変）。
- クライアント純ロジックテストは `bun test`（app）に含まれる（既存 `app/client/src/**/**.test.ts` 実績あり）。
- CSS クラス（`lang-toggle`/`llm-provider-toggle`/`llm-fields`/`llm-field`/`llm-input`/`support-panel`/`stat-title`/`text-sm`/`text-muted`/`info-pop`）は `app/client/src/styles/app.css` に既存。新規 CSS 不要。
- package.json に version フィールドは無い（リリース = CHANGELOG + git タグ）。
