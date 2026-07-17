# 設定の UI 一元化（env は API キーのみ）実装計画（v0.29 追補）

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API キー5種（`ANTHROPIC_API_KEY`/`CODEX_API_KEY`/`OPENAI_API_KEY`/`OPENAI_COMPAT_API_KEY`/`TTS_API_KEY`）とインフラ系 `SOLO_EIKAIWA_*` 以外の env 読み取りを全廃し、Claude グローバルモデル・TTS プロバイダ選択を含む全設定を UI で完結させる

**Architecture:** spec `docs/superpowers/specs/2026-07-10-ui-only-settings-design.md` が正。`settingsToEnv` を「DB 設定 + 実 env の API キーだけから合成 env を作る純関数」に再設計。グローバルチューニングは `llm_role_tuning` の `role="global"` 行（スキーマ変更なし・解決順: ロール別 > global > コード既定）。TTS プロバイダは新単一行テーブル `tts_provider_settings`（auto|say|openai-compat・say フォールバックは維持）。env 取り込みマイグレーションはしない（ユーザー決定）。既存 DB の `provider="env"` は store 読込時に `"claude"` 解釈。

**Tech Stack:** 既存構成のみ（Bun/TypeScript・SQLite・React）。新依存なし。

## Global Constraints

- サーバ新ロジックは TDD（赤→緑）。検証ゲート3種 + 既存テスト全緑を各コミット前に確認
- i18n は型 + EN + JA の3点同時。文言変更はコミットメッセージに明示
- ensure は CREATE TABLE IF NOT EXISTS のみ（列追加・マイグレーション機構禁止）
- API キーを DB・API レスポンス・ログに出さない（既存衛生の維持）
- CLI スクリプト（scripts/generate-content.ts 等）は変更しない（env 駆動のまま・スコープ外）

---

### Task 1: `"env"` センチネル廃止 + settingsToEnv 再設計（サーバ・TDD）

**Files:** `app/server/llm-provider.ts`（`LlmProvider` から `"env"` 削除・`settingsToEnv` を「API キーのみ実 env から引き継ぎ、他は DB 値のみで構成」へ・`isOpenAiCompatReady` 追従）/ `app/server/llm-settings-store.ts`（get() で `"env"`→`"claude"` 正規化）/ `app/server/routes/llm-settings.ts`（入力検証から `"env"` 削除）/ 既存テストの棚卸し（`"env"` 依存テストの更新）

- [ ] TDD（合成 env に LLM 4変数の実 env 値が漏れないこと・API キーは通ること・`"env"` 保存済み行の claude 正規化・route が `"env"` を 400 で拒否）→ 3ゲート → Commit `feat!: LLM設定のenvフォールバックを廃止（provider="env"センチネル削除・設定はUI/DBのみ）`

### Task 2: 残存 env 読み取りの削除（health・カタログ・warmup）

**Files:** `app/server/index.ts`（health の provider 表示を DB 由来に・catalog local fetcher の `OPENAI_COMPAT_BASE_URL` フォールバック削除）/ `app/server/providers/openai-compat.ts`（warmup の env 判定を DB 設定注入に変更）/ Test

- [ ] TDD → 3ゲート → Commit `feat: health/モデルカタログ/warmupのenv参照をDB設定へ一本化`

### Task 3: グローバルチューニング（`role="global"` 行）

**Files:** `app/server/llm-role-tuning-store.ts`（`"global"` 行の read/write・`CLAUDE_MODELS` ホワイトリスト廃止 → 形式検証〔trim 済み 1..200 文字〕・解決ヘルパ `resolveTuning(role)` = ロール別 > global > コード既定）/ `app/server/routes/llm-settings.ts`（roles 一括 PUT で global を受理・検証）/ `app/server/converse.ts`（`CLAUDE_DEFAULT_TUNING` の手前に global 行を挟む・codex の effort/serviceTier 既定も global 経由に）/ Test

- [ ] TDD（解決順・global のみ設定時の5ロール反映・形式検証・既存3エイリアスの後方互換〔保存済み "sonnet" 等がそのまま動く〕）→ 3ゲート → Commit `feat: Claudeモデル/Codex既定チューニングのグローバル設定（llm_role_tuningのglobal行・ホワイトリスト廃止）`

### Task 4: TTS プロバイダ明示選択 + env 層削除

**Files:** `app/server/tts-provider-store.ts` 新設（`tts_provider_settings` 単一行・`auto`|`say`|`openai-compat`）/ `app/server/db.ts`（ensure 1行）/ `app/server/tts.ts`（`resolveTtsConfig` から env 層削除・provider 強制ロジック: say=HTTP スキップ / openai-compat=暗黙判定スキップで常に HTTP 試行・失敗時 say フォールバック維持+ログ / auto=現行同一）/ `app/server/routes/tts-settings.ts`（provider の GET/PUT）/ Test

- [ ] TDD（3モードの試行順・env が効かないこと・auto の回帰〔既存テストケースが緑のまま〕）→ 3ゲート → Commit `feat: TTSプロバイダの明示選択（自動/say固定/OpenAI互換固定）とenvフォールバック廃止`

### Task 5: クライアント（設定 UI・型・i18n）

**Files:** `app/client/src/api/llm-settings.ts`（`"env"` 削除・global tuning 型・`CLAUDE_MODEL_OPTIONS` 廃止）/ `app/client/src/api/tts-settings.ts`（provider）/ `app/client/src/lib/llm-assignments.ts`（env 写像削除・global tuning・Claude カタログ行の select 化〔失敗時自由入力〕）/ `app/client/src/screens/SettingsScreen.tsx`（接続タブ: Claude グローバルモデル select + TTS プロバイダ select / 用途タブ: Claude モデルのカタログ select 化〔既定=「globalに従う」〕）/ `app/client/src/i18n.ts`（dead strings `optEnv`/`envNote` 削除・新文言 EN/JA）

- [ ] クライアント純ロジック（llm-assignments）のテスト更新 → typecheck + build → 実機で設定画面の保存・実効表示を確認 → Commit `feat: 設定UIにClaudeグローバルモデル選択とTTSプロバイダ選択を追加（env選択肢を削除）`

### Task 6: docs・CHANGELOG

**Files:** `README.md`（「LLM プロバイダの切替」節を UI 前提に書き換え・env 変数表から廃止7変数を削除・TTS 節・CLI 専用変数の注記）/ `app/.env.example`（API キー5種 + インフラ系のみへ）/ `CHANGELOG.md`（未リリースの [0.29.0] 節へ追記: Changed に UI 一元化・**Breaking** として env 廃止を明記）

- [ ] README 差分チェック（できること含む）→ 3ゲート → Commit `docs: 設定のUI一元化に伴うREADME/.env.example/CHANGELOG更新（env廃止はbreakingとして明記）`

### Task 7: 最終検証・レビュー・マージ

- [ ] 検証ゲート3種 + 全テスト・実機スモーク（デーモン再起動 → 設定画面で provider/モデル/TTS を一巡）
- [ ] whole-branch 多角レビュー（Workflow・確定指摘は修正）→ merge → 台帳・メモリ更新
