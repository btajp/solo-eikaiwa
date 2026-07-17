# API キーの UI 設定（Keychain 保存）実装計画（v0.29 追補）

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API キー4種（ANTHROPIC/CODEX/OPENAI_COMPAT/TTS）を設定 UI から macOS Keychain へ保存・削除でき、再起動なしで反映される（Keychain > env の優先・write-only）

**Architecture:** spec `docs/superpowers/specs/2026-07-10-api-keys-keychain-design.md` が正。`secrets.ts` が `security -i`（stdin 経由・値を argv に出さない）で Keychain を読み書きし、起動時と保存/削除後にプロセス env へ注入する（既存の鍵消費点は全て無変更で効く）。API は値を一切返さない write-only。削除は起動時スナップショットの env 元値へ復元。

**Tech Stack:** 既存構成のみ（`security` は macOS 標準・新依存なし）。

## Global Constraints

- サーバ新ロジックは TDD（fake spawn・実 Keychain 非依存）。検証ゲート3種 + 全テスト緑を各コミット前に確認
- **鍵の値をレスポンス・ログ・エラーメッセージ・argv に一切出さない**（テストで機械検証）
- i18n は型 + EN + JA 3点同時
- security-reviewer レビューを merge 前に必須実施

---

### Task 1: `secrets.ts`（Keychain ラッパ + env 注入・TDD）

**Files:** Create `app/server/secrets.ts` / Test `app/server/__tests__/secrets.test.ts`

- 専用 spawn シーム `SecretsSpawnFn = (cmd, stdin?) => Promise<{exitCode, stdout, stderr}>`（既存 SpawnFn は stdin/stdout 非対応のため別定義）
- `KEYCHAIN_SECRET_NAMES`（4鍵ホワイトリスト）/ `isValidSecretValue`（printable ASCII・空白と `"` `\` `'` を含まない・1..500字）/ save・delete・load・status
- 注入規則: Keychain にあれば `process.env` を上書き（元値はスナップショット）。delete は Keychain 削除 + スナップショット復元。source（keychain|env|null）を in-memory 追跡
- [ ] TDD（stdin にのみ値が現れ argv に出ない・find の stdout 解釈・delete 復元・不正値拒否・security 失敗の fail-open）→ 3ゲート → Commit `feat: KeychainラッパとAPIキーのプロセスenv注入（security -i・値をargvに出さない）`

### Task 2: `routes/secrets.ts`（write-only API・TDD）

**Files:** Create `app/server/routes/secrets.ts` / Modify `app/server/routes.ts`（合成+RouteDeps）・`app/server/index.ts`（実配線 + 起動時 `loadKeychainSecretsIntoEnv()` を startup apply より前に実行）/ Test

- GET `{[name]: {configured, source}}` / PUT `{name, value}` / DELETE `/api/secrets/:name`。保存/削除後は env 再注入 → `applyLlmSettings` 経路で再解決 + `CODEX_API_KEY` 変更時は codex app-server kill
- [ ] TDD（**応答・エラーの JSON 文字列に値が含まれないことを機械検証**・ホワイトリスト外/不正値 400・再解決とkillの呼び出し）→ 3ゲート → Commit `feat: APIキーのwrite-only設定API（GET=有無とソースのみ・PUT/DELETEで再起動なし反映）`

### Task 3: クライアント（設定 UI・i18n）

**Files:** Create `app/client/src/api/secrets.ts` / Modify `app/client/src/screens/SettingsScreen.tsx`（Claude 認証・ローカル LLM・Codex 認証・TTS の各セクションに API キー欄: password 入力 + 状態「設定済み（Keychain）/ 設定済み（app/.env から検出）/ 未設定」+ 保存/削除。保存後は secrets/llm-settings/tts-settings を再取得）/ `app/client/src/i18n.ts`（「app/.env に追記」系文言の置換・新文言 EN/JA）

- [ ] typecheck + build + 実機確認（保存 → 状態表示 → api-key モードが選択可能になる → 削除で env 検出へ戻る）→ Commit `feat: 設定UIからAPIキーを保存/削除できるように（Keychain・マスク入力・ソース明示）`

### Task 4: docs・規約改訂

**Files:** `AGENTS.md`（鍵規約を「Keychain（UI）または app/.env」へ）/ `README.md`（セットアップ節・機能マトリクス・デスクトップ節）/ `CHANGELOG.md`（[0.29.0] へ追記）

- [ ] README 差分チェック → 3ゲート → Commit `docs: APIキーのUI設定に伴う規約・README・CHANGELOG更新`

### Task 5: 検証・レビュー・マージ

- [ ] 実 Keychain 統合スモーク（save → `security find-generic-password` で確認 → GET status → delete → env 復元）
- [ ] security-reviewer レビュー + whole-branch 多角レビュー → 確定指摘修正 → merge → デプロイ（build + kickstart）→ メモリ更新
