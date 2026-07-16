# 設定の UI 一元化（env は API キーのみ）設計ドキュメント（v0.30 候補）

- 起点: ユーザー指示（2026-07-10）「環境変数で設定できるのは API キーだけにしてほしい。残りは全て UI での設定にしてほしい。例えば GPT であれば GPT-5.5 を選ぶのか codex-5.3 を選ぶのかとかも全部 UI 上でできてほしい。Claude も同様」
- 事前調査: 3並列の被覆調査（2026-07-10 Workflow）で env・DB・UI の現状を全数把握済み
- ユーザー確認済みの決定: **env 値の DB 取り込みはしない**（即廃止・未設定は既定の Claude スタート）/ **TTS はフルスコープ**（env 層廃止 + プロバイダ明示選択の新設）

## 1. 現状（調査確定所見）

1. LLM 系の env フォールバックは4変数が全数: `LLM_PROVIDER` / `OPENAI_COMPAT_BASE_URL` / `OPENAI_COMPAT_MODEL` / `CODEX_MODEL`。`llm_settings.provider="env"` センチネル（または行不在）のときだけ生きる（`llm-provider.ts settingsToEnv`）。`OPENAI_COMPAT_BASE_URL` はモデルカタログの local fetcher（`index.ts:68`）と warmup（`providers/openai-compat.ts`）でも読まれる
2. TTS は `resolveTtsConfig`（`tts.ts`）が DB（tts_settings）> env（`TTS_BASE_URL`/`TTS_MODEL`/`TTS_VOICE`）> コード既定 の3層。プロバイダ（macOS say / OpenAI 互換 HTTP）は「鍵の有無 + baseUrl が既定か」の**暗黙決定**で、say を強制する UI が無い
3. Claude のモデルはグローバル設定が存在せずコード定数 `sonnet` 固定（`converse.ts CLAUDE_DEFAULT_TUNING`）。ロール別（`llm_role_tuning.claude_model`）のみ変更可能で、選択肢は haiku|sonnet|opus の3エイリアス固定ホワイトリスト。一方カタログ API（`GET /api/llm-models`）は SDK `supportedModels()` で完全な一覧を取得済みなのに保存側が消費していない
4. Codex のモデルは**既に要望を満たしている**: グローバル・ロール別とも UI の動的 select（codex app-server `model/list` 由来。gpt-5.5 / codex-5.3 等）+ 取得失敗時自由入力
5. サーバが読む env の全数は「API キー5種 + LLM 4変数 + TTS 3変数 + インフラ系 `SOLO_EIKAIWA_*`」。`CLAUDE_MODEL` 等は CLI スクリプト専用（サーバは読まない・v0.24 で廃止済み）
6. `llm_role_tuning` の role 列に CHECK 制約は無く、`"global"` 行の追加はスキーマ変更なしで可能。ADD COLUMN の前例は無い（規約: ensure は CREATE TABLE IF NOT EXISTS のみ・マイグレーション機構を作らない）

## 2. 変更内容

### 2a. env フォールバックの全廃（サーバ）

- `LlmProvider` から `"env"` センチネルを削除。`settingsToEnv` は「DB 設定だけから selectRunner 用の合成 env を作る純関数」に再設計（API キーだけは実 env から引き継ぐ）
- DB 行不在時の既定は `{ provider: "claude", baseUrl: null, model: null, codexModel: null }`（コード定数）。既存 DB に `"env"` が保存済みの場合は **store の読み込み時に `"claude"` として解釈**（行は削除しない・書き戻しもしない）
- `LLM_PROVIDER`/`OPENAI_COMPAT_*`/`CODEX_MODEL` の読み取りを全箇所から削除（llm-provider.ts・index.ts の health/catalog fetcher・openai-compat.ts の warmup）
- `resolveTtsConfig` から env 層を削除（DB > コード既定 の2層に）
- 残る env: **API キー5種のみ**（`ANTHROPIC_API_KEY`/`CODEX_API_KEY`/`OPENAI_API_KEY`/`OPENAI_COMPAT_API_KEY`/`TTS_API_KEY`）+ インフラ系 `SOLO_EIKAIWA_*`（ポート・パス。アプリ設定ではないため対象外）

### 2b. グローバルチューニング（Claude モデル + Codex effort/serviceTier）

- `llm_role_tuning` に **`role="global"` 行**を導入（スキーマ変更なし）。解決順: **ロール別 > global > コード既定**（claude_model=sonnet / effort=ロール既定 / codex は medium/fast）
- ルート検証（`PUT /api/llm-settings/roles`）で role="global" を許可し、既存5ロールと同じ検証を適用
- Claude モデルの保存検証は3エイリアスホワイトリストを廃止し、codexModel と同じ形式検証（トリム済み・200文字以内の自由文字列）に統一。選択肢の提示はカタログ（`supportedModels()`）が担う（「UI 真実性」方式: カタログ失敗時は自由入力に劣化）

### 2c. TTS プロバイダ明示選択

- 新単一行テーブル `tts_provider_settings`（id=1・`provider TEXT NOT NULL`・値は `auto`|`say`|`openai-compat`）+ `ensureTtsProviderSchema`（CREATE TABLE IF NOT EXISTS のみ）+ `makeTtsProviderStore`
- 解決（いずれも同梱音声ヒットは従来どおり最優先）: `say` = HTTP を試さず常に macOS say / `openai-compat` = 常に HTTP を試す（鍵・baseUrl の暗黙判定をスキップ）。ただし **HTTP 失敗時の say フォールバックは維持**する — 「固定」は試行順の固定であり、音声が出ないより劣化再生のほうが学習体験を壊さないため（フォールバック発生はログで判別可能にする）/ `auto`（既定）= 現行の暗黙決定と完全同一（回帰基準）
- `PUT /api/tts-settings` の入力に provider を追加（別テーブルへ保存・既存フィールドと一括更新）

> **2026-07-17 改訂注記（§2c）**: TTS プロバイダの `auto`（暗黙決定）と HTTP 失敗時の say フォールバックは v0.29.1 で廃止済み。現行は **`say` / `openai`（公式）/ `openai-compat` の明示3値選択（既定 `say`）**で、明示選択したプロバイダの HTTP 合成失敗時は別エンジンへ黙って切り替えず失敗をユーザーに提示する（旧 `auto`・行不在は移行 resolver で明示値へ正規化）。現行の正は `app/server/tts-provider-store.ts`・`app/server/tts.ts`。

### 2d. クライアント UI（`SettingsScreen.tsx` + `lib/llm-assignments.ts`）

- 接続タブ: Claude セクションに**グローバルモデル select**（カタログ由来・先頭に「既定（sonnet）」・失敗時自由入力）/ TTS セクションに**プロバイダ select**（自動・macOS say・OpenAI 互換）
- 用途タブ: ロール別 Claude モデル select をカタログ由来に変更（「global に従う」= null が既定選択肢）
- `"env"`（環境変数に従う）系の選択肢と dead strings（`optEnv`/`envNote`）を削除。新規文言は型 + EN + JA の3点同時追加
- 保存 API は既存の一括 PUT（`/api/llm-settings/roles`）に global tuning を同乗させる

### 2e. ドキュメント

- README「LLM プロバイダの切替」節: env 直接運用（`LLM_PROVIDER` 等）の記述を削除し「設定は UI・env は API キーのみ」に書き換え。TTS 節（プロバイダ選択の追加・「app/.env でのみ切替可能」記述の更新）
- `app/.env.example`: API キー5種 + インフラ系のみに整理（廃止した7変数を削除）
- CHANGELOG（Changed: env 廃止は**破壊的変更**として明記 — env のみで設定していた環境は更新後に UI での再設定が必要）

## 3. スコープ外（明記）

- ヘッドレス CLI（`scripts/generate-content.ts` / `generate-topic-assets.ts` 等）は開発者ツールとして env/フラグ駆動のまま（`CLAUDE_MODEL`/`CODEX_*` は CLI 専用として存続・README の該当節にその旨明記）
- API キーの UI 入力化はしない（ユーザー方針: キーは env のみ。配布 Tauri アプリが `app/.env` を読まない既知の構造も今回は据え置き）

> **2026-07-17 改訂注記（§3）**: 「API キーの UI 入力化はしない」は同日の後続決定で改訂済み。v0.29.0 で API キーの UI 設定（macOS Keychain 保存・write-only）が導入された。現行の正は [2026-07-10-api-keys-keychain-design.md](2026-07-10-api-keys-keychain-design.md)（同spec §2 の改訂注記含む）と `app/server/secrets.ts`。
- `POST /api/tts` のリクエスト単位 voice 上書きは現状維持（同梱音声のテキスト単位一致に必要）。優先順位は「リクエスト > DB > 既定」と仕様として明記
- モデルカタログの取得機構自体の変更はしない（既存の 1h TTL キャッシュ・fail-quiet を踏襲）

## 4. テスト・検証

- サーバは全て TDD: settingsToEnv 再設計・"env" 正規化・global tuning 解決順・TTS プロバイダ解決（say 固定/openai 固定/auto 回帰）・route 検証（role="global"・claude_model 形式）
- `"env"` センチネルに依存する既存テストの棚卸しと更新（フェイクは `__tests__/helpers/route-deps.ts` の satisfies パターン踏襲）
- 検証ゲート3種 + クライアントは typecheck/build で担保（規約どおり）

## 5. 互換性・残リスク

- **破壊的変更**: env のみで openai-compat / codex を運用していた環境は、更新後の初回に UI で再設定するまで既定（Claude）で動く（ユーザー決定: 取り込みなし）。CHANGELOG とリリースノートで明示する
- `provider="env"` を保存済みの既存 DB は "claude" 解釈になる（UI 上も Claude 表示・実挙動と一致）
- TTS「openai-compat 固定」でも HTTP 失敗時は say へ劣化する設計（音声無しを避ける）。「固定なのに say が鳴る」ケースはログで判別可能にする
