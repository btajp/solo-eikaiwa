# v0.24 プロバイダ大改修 Plan B（UI・認証・ドキュメント・リリース） Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan A のサーバ基盤の上に、ロール別チューニング UI・推奨チューニング適用・APIキー認証（隔離 CODEX_HOME）・ドキュメントを載せ、v0.24.0 をリリースする（spec §3-3・§4・§5・§6・§7）。

**Architecture:** UI は用途ごとのモデルタブに「詳細」ディスクロージャ（tuning）と推奨適用ボタン、接続タブに認証モード select を追加。認証は新テーブル `llm_auth`（モードのみ・キーは env）で、codex api-key は `DATA_DIR/codex-home` の隔離 CODEX_HOME に `codex login --with-api-key` で auth.json を作る。

**Tech Stack:** Plan A と同一。前提: Plan A 完了済み（5ロール・llm_role_tuning API・resolveClaudeRunner・per-thread パラメータ）。

## Global Constraints

- Plan A の Global Constraints をすべて継承（検証ゲート3種・挙動不変原則・TDD・i18n 3点同時・PUBLIC 衛生）
- **キーは UI/DB に絶対に保存しない**。UI は env のキー検出状態のみ表示（値・部分文字列も出さない）
- 認証モード語彙: `"subscription" | "api-key"`（行不在=subscription）。env キー名: claude=`ANTHROPIC_API_KEY` / codex=`CODEX_API_KEY`（OPENAI_API_KEY は codex 認証に使われない — 実測済み事実）
- 隔離 CODEX_HOME: `DATA_DIR/codex-home`（data/ は gitignore 済み）。**ユーザーの ~/.codex には一切触れない**
- 推奨マトリクス（spec §4 の表・逐語）: 会話 sonnet/low + GPT low/fast、支援 haiku/low + low/fast、コーチング sonnet/high + medium/fast、生成 sonnet/medium + medium/fast、測定 opus/xhigh + xhigh/standard
- リリース: v0.24.0（CHANGELOG・README「できること」・タグ・デプロイ・実機スモーク5項目）

---

### Task 1: チューニング UI（詳細ディスクロージャ + i18n）

**Files:**
- Modify: `app/client/src/screens/SettingsScreen.tsx`（roles タブの各ロール行）
- Modify: `app/client/src/api/llm-settings.ts`（LlmSettingsView/PUT payload に tuning 型追加）・`app/client/src/lib/llm-assignments.ts`（buildRolesPayload が tuning を常時含める）
- Modify: `app/client/src/i18n.ts`（settings に tuning 系キー・EN/JA）
- Test: `llm-assignments.test.ts`（payload に tuning が乗る・省略時全null）

**Interfaces:**
- Consumes: Plan A Task 7 の API（GET に tuning・PUT に tuning 受理）
- UI 仕様: 各ロール行に `<details>` ベースの「詳細設定」— claude 割当時のみ「モデル: 既定(sonnet)/haiku/sonnet/opus」、共通「effort: 既定/low/medium/high/xhigh」、codex 割当時のみ「配信: 既定(fast)/fast/standard」。tuning state は `Record<LlmRole, RoleTuning>` を SettingsScreen 親に保持（タブ切替で消えない）
- i18n 新キー（EN/JA・逐語で最終文言）: `tuningDetails`("Advanced"/「詳細設定」)、`tuningModel`("Model"/「モデル」)、`tuningEffort`("Effort"/「effort（思考の深さ）」)、`tuningTier`("Delivery"/「配信」)、`tuningDefault`("Default"/「既定」)、`tuningTierFast`("Fast (priority)"/「fast（優先配信）」)、`tuningTierStandard`("Standard"/「standard（標準・安価）」)

- [ ] Steps: 純ロジック（buildRolesPayload の tuning 直列化）テスト先行 → API 型 → UI → i18n → 3ゲート → Commit `feat: ロール別チューニング（モデル/effort/配信）の詳細設定UIを追加`

### Task 2: 推奨チューニング適用 + roleReason マトリクス整合

**Files:**
- Modify: `app/client/src/lib/llm-assignments.ts`（`RECOMMENDED_TUNING` 定数 + `applyRecommendedTuning(current, targets): Record<LlmRole, RoleTuning>`）+ Test
- Modify: `app/client/src/screens/SettingsScreen.tsx`（プリセット節の下に「推奨チューニングを適用」ボタン）
- Modify: `app/client/src/i18n.ts`（ボタン・説明・roleReason 5ロール分をマトリクス整合の文言へ EN/JA 更新）

**Interfaces:**
- `RECOMMENDED_TUNING: Record<LlmRole, { claude: RoleTuning; codex: RoleTuning }>`（spec §4 の表を逐語定数化。例 assessment: claude={claudeModel:"opus",effort:"xhigh",serviceTier:null} / codex={claudeModel:null,effort:"xhigh",serviceTier:"standard"}）
- `applyRecommendedTuning`: **クラウド割当（claude/codex）のロールにのみ**該当側の推奨を書き、local 割当ロールは現値維持
- roleReason 更新（JA・逐語）: 会話「推奨: ローカル — 応答が最も速いため。クラウドなら sonnet / low が目安。」支援「推奨: ローカル — 単純で即答が欲しいタスク。クラウドなら haiku / low で十分。」コーチング「推奨: Claude / Codex — 品質勝負（SRSに残る添削・恒久キャッシュされる解説）。sonnet / high が目安。」生成「推奨: ローカル — 定型的で要求低め。品質を上げるなら sonnet / medium。」測定「推奨: Claude / Codex — 月1未満で判断が全体に波及。opus / xhigh・急がないので standard 配信で十分。」（EN 対応文・コミット本文に文言変更列挙）

- [ ] Steps: applyRecommendedTuning テスト先行（クラウドのみ書換・local不変・全ロール網羅）→ 実装 → UI/i18n → 3ゲート → Commit `feat: 推奨チューニングのワンタップ適用と用途別推奨文言のマトリクス整合`

### Task 3: モデルカタログ API（`GET /api/llm-models`・TDD）

> 実行順: Task 2 とその追補（env 上書き廃止 — 2026-07-08 ユーザー指示）の承認後に着手。設計の正は spec §7（実効モデルの可視化・選択）。

**Files:**
- Create: `app/server/providers/model-catalog.ts`（型 + TTL キャッシュ + 実 fetcher 3種）
- Create: `app/server/routes/llm-models.ts`（`makeLlmModelsRoutes(deps)`）
- Test: `app/server/__tests__/llm-models.test.ts`
- Modify: `app/server/providers/codex-app-server.ts`（常駐プロセスへ `model/list` リクエストを投げる公開メソッド追加）、`app/server/routes.ts`（合成配列に1行）、`app/server/__tests__/helpers/route-deps.ts`（fake 1項）、`app/server/index.ts`（実依存配線）

**Interfaces（Produces）:**
- `GET /api/llm-models[?refresh=1]` → `{ claude: CatalogResult, codex: CatalogResult, local: CatalogResult }`
- `CatalogResult = { available: boolean; reason?: string; models: CatalogModel[]; fetchedAt: string }`
- `CatalogModel = { id: string; displayName: string; description: string; resolvedModel?: string; efforts?: { id: string; description?: string }[]; defaultEffort?: string; tiers?: { id: string; name: string; description?: string }[]; defaultTier?: string; isDefault?: boolean }`

- [ ] fetcher は注入（`deps.getModelCatalog(provider, refresh)` 相当）で TDD: 正常統一形 / ソース失敗→`available:false, reason`（HTTP 200 のまま）/ TTL キャッシュが2回目の fetcher 呼び出しを抑止 / `refresh=1` で強制再取得
- [ ] 実 fetcher: claude = Agent SDK `query()`（streaming 入力モード）で `supportedModels()` → 即 close（`value`/`resolvedModel`/`displayName`/`description`/`supportedEffortLevels` を CatalogModel へ写像・トークン消費なし）。codex = app-server `model/list`（`isDefault`/`defaultReasoningEffort`/`serviceTiers`/`defaultServiceTier` を写像）。local = `GET {baseUrl}/models`（OpenAI 互換）。全て失敗時 throw ではなく available:false
- [ ] 3ゲート → Commit `feat: モデルカタログAPI（claude supportedModels / codex model-list / local models・TTLキャッシュ・劣化パス）`

### Task 4: 実効モデルの可視化・選択 UI

> 設計の正は spec §7。要件（binding）: ①しっかり選択できる ②現在何が使われているか明確 ③既定・推奨が一目で分かる。

**実機カタログ所見（2026-07-08 コントローラ実測・Task 3 の実 fetcher で取得成功）— UI 実装はこの実形状を前提にする:**
- claude 行は id に装飾がある（`opus[1m]`・`claude-fable-5[1m]`・`default` 等）→ **エイリアス（haiku/sonnet/opus）→カタログ行の対応は displayName の小文字一致で解決**（id 一致に頼らない）。`default` 行（CLI 自身の推奨・現在 opus 実体）は DD 選択肢から**除外**（本アプリの既定は sonnet コード定数であり混同を招くため）。resolvedModel 実例: sonnet→`claude-sonnet-5`・haiku→`claude-haiku-4-5-20251001`
- **haiku は efforts フィールドなし**（effort 非対応）→ claude の effort DD はカタログに efforts が無いモデル選択中は「既定（SDK標準）」のみにする
- **claude に effort `max` が存在**（opus/sonnet/fable）→ `app/server/routes/llm-settings.ts` の effort whitelist に `max` を追加（+テスト）。UI の effort 選択肢はカタログ由来に絞るため codex に max が出ることはない
- **codex tier の実語彙**: カタログ serviceTiers は `["priority"]`（gpt-5.5 のみ・5.4-mini/5.3-spark は無し）。codex config の正式語彙は `fast`/`flex` で、`fast` の request 実体が `priority`。`standard` は正式値ではなく「指定なし」センチネルだが、codex-rs は未知値を `from_request_value` で黙って None（標準ルーティング）に倒すため現行の `standard` 送信は実害なし（実測・コード確認済み）。**保存語彙は {fast, standard} を維持**し、UI 表示: tiers を持つモデル =「標準」+「fast（優先配信）」、持たないモデル =「標準」のみ
- codex は gpt-5.5 が `isDefault:true`・defaultEffort `medium`（コード既定 medium と一致）。local は `/v1/models` から取得成功（qwen3:30b-instruct）

**Files:**
- Create: `app/client/src/api/llm-models.ts`（+ `api/index.ts` バレル1行）
- Modify: `app/client/src/screens/SettingsScreen.tsx`、`app/client/src/lib/llm-assignments.ts`（実効解決ヘルパ）、`app/client/src/i18n.ts`（EN/JA 同時）
- Test: `app/client/src/lib/llm-assignments.test.ts`（純ロジック: 実効解決・カタログ→選択肢変換）

- [ ] **選択**: claude ロール tuning のモデル DD をカタログ由来に（「Sonnet — claude-sonnet-4-5」形式で実体併記・**保存値はエイリアスのまま**）。codexModel（接続タブ）を自由記述→カタログ DD（isDefault に「CLI 既定」バッジ・カタログ不可時は自由記述フォールバック）。local model も `/models` 由来 DD + 自由記述フォールバック。effort DD は選択中モデルの supported efforts に絞り、codex は effort の description を併記
- [ ] **実効表示**: 用途タブ各ロール行に常時1行「実効: <プロバイダ> <具体モデルID> · effort <値> · 配信 <値>」（inherit 連鎖解決後・カタログ不可時は「実体未確認」）。純ロジック `resolveEffective(targets, tuning, catalog)` をテスト
- [ ] **既定の具体化**: 「既定（…）」ラベルをカタログ既定（isDefault/defaultEffort/defaultTier）優先・不可時コード定数（sonnet / SDK標準 / medium / fast）で表示。「モデル一覧を更新」ボタン（`?refresh=1`）
- [ ] i18n キー（実効/実体未確認/CLI既定/モデル一覧を更新 等）EN/JA 同時追加 → 3ゲート → Commit `feat: 実効モデルの可視化と選択 — カタログ由来DD・ロール別実効サマリ・既定の具体表示`

### Task 5: llm_auth テーブル + 認証モード配線（TDD）

**Files:**
- Create: `app/server/llm-auth-store.ts` / Test: `llm-auth-store.test.ts`
- Modify: `app/server/db.ts`・`app/server/routes/llm-settings.ts`（GET/PUT に authModes additive）・`helpers/route-deps.ts`
- Modify: `app/server/llm-provider.ts` + `providers/claude-print.ts` + `converse.ts` + `providers/codex-app-server.ts` + `providers/codex.ts`（spawn env 注入点）
- Create: `app/server/codex-auth.ts`（隔離 CODEX_HOME 準備）/ Test: `codex-auth.test.ts`（spawn seam フェイク）

**Interfaces:**
- `llm_auth(provider TEXT PRIMARY KEY, mode TEXT NOT NULL, updated_at TEXT NOT NULL)`・`LlmAuthStore { getAll(): { claude: AuthMode; codex: AuthMode }; set(provider, mode): void }`・`AuthMode = "subscription" | "api-key"`
- claude × api-key: SDK query の spawn env / claude-print exec に `ANTHROPIC_API_KEY`（`app/.env` 由来）を注入 + claude-print は `bare: true`。キー未設定でモード=api-key なら保存時 400（`anthropic api key not configured in app/.env`）
- codex × api-key: `codex-auth.ts` の `ensureCodexApiKeyHome(spawnFn?): Promise<string>` — `DATA_DIR/codex-home/auth.json` が無ければ `CODEX_HOME=<dir> codex login --with-api-key`（stdin=env.CODEX_API_KEY）を実行して作成し、dir を返す。exec/app-server の spawn env に `CODEX_HOME` を注入。**モード切替時は codex app-server registry のプロセスを kill**（認証環境変更のため・次回 lazy spawn）
- ルート: PUT body に `auth?: { claude?: AuthMode; codex?: AuthMode }`（2パス検証統合）。GET 応答に `authModes: { claude, codex }` と `authKeys: { anthropic: boolean; codex: boolean }`（env 検出のみ）

- [ ] Steps: store テスト先行 → routes テスト先行（モード往復・キー未設定 api-key は 400・既定 subscription）→ codex-auth テスト（フェイク spawn で login 呼び出し形・auth.json 既存ならスキップ）→ 配線（spawn env 注入・registry kill）→ 3ゲート → Commit `feat: Claude/CodexのAPIキー認証モード（隔離CODEX_HOME・キーはenvのみ）を追加`

### Task 6: 認証 UI（接続タブ）

**Files:**
- Modify: `app/client/src/screens/SettingsScreen.tsx`（接続タブ: Claude/Codex 各節に認証モード select + キー検出表示）・`app/client/src/api/llm-settings.ts`・`app/client/src/i18n.ts`

**Interfaces:**
- i18n 新キー（JA 逐語）: `authModeLabel`「認証」/ `authSubscription`「サブスクリプション（既定）」/ `authApiKey`「APIキー（従量課金）」/ `authKeyDetected`「APIキー: app/.env に設定済み」/ `authKeyMissing`「APIキー: 未設定（app/.env に追記してください）」/ `authApiKeyNote`「APIキーは api.openai.com / Anthropic API の従量課金です（サブスクの利用枠とは別）。キーは UI には保存されません。」（EN 対応文）
- 保存は既存の接続保存ボタンに同乗（PUT payload に auth を含める）

- [ ] Steps: UI + i18n → 3ゲート → Commit `feat: 認証モード（サブスク/APIキー）の選択UIを接続タブに追加`

### Task 7: README / CHANGELOG

**Files:**
- Modify: `README.md`（①ロール表を5行に（クイック支援行追加）②推奨マトリクス表（モデル/effort/配信・「未指定=CLI最新既定」の思想含む）③env 表を「UIで設定（サーバの唯一の真実=DB）/envのみ(secrets・CLI専用)」2区分へ再編 + 優先順位（tuning>コード既定・env中間層なし。チューニング系4変数は generate-content.ts のみが解釈）+ UI真実性の原則を一文で明記 ③b 実効モデルの可視化・選択（カタログDD・実効サマリ・既定の具体表示）を「できること」へ④認証モード節（従量課金の注意・隔離 CODEX_HOME・~/.codex 不干渉）⑤「できること」該当節 ⑥CLI 教材生成の推奨 `LLM_PROVIDER=claude CLAUDE_MODEL=opus CLAUDE_EFFORT=high` ⑦Claude フォールバック（claude -p・再起動をまたぐ resume）をセッション継続節へ追記）
- Modify: `CHANGELOG.md`（v0.24.0: クイック支援ロール / ロール別チューニング+推奨適用 / Claude フォールバックとタイムアウト統一 / APIキー認証 / env 整理）

- [ ] Steps: 実コードを読んで正確に記述（実装との齟齬禁止）→ `bun test` 回帰 → Commit `docs: v0.24.0（5ロール・ロール別チューニング・APIキー認証・claude -pフォールバック）をREADMEとCHANGELOGに反映`

### Task 8: 統合検証・手動スモーク・リリース v0.24.0

- [ ] 3ゲート + `./scripts/check-codex-protocol.sh`
- [ ] 最終 whole-branch レビュー（最上位モデル・spec 全節との照合・挙動不変の確認を重点）
- [ ] 手動スモーク（コントローラ実施・デーモン一時停止の合図後）:
  1. claude -p フォールバック: SDK を壊す shim（あるいは query 注入の一時 env）で会話 → フォールバック警告 + 応答 + 再起動後 `--resume` 継続
  2. assist 分離: 訳ボタンが assist 経路（ログ/割当で確認）
  3. ロール別 effort: 測定ロールに xhigh を設定し thread/start パラメータに乗ること（fake 検証済みのため実機は codex 1往復で config 反映をログ確認）
  4. 推奨チューニング適用: クラウド割当ロールにのみ書き込まれること
  5. codex api-key モード: `DATA_DIR/codex-home/auth.json` 生成・`~/.codex` の mtime 不変・subscription へ戻して復元
  6. 設定をバックアップ→復元（v0.23 スモークと同手順）
  7. モデルカタログ実機: claude の resolvedModel・codex の isDefault が UI に出ること / ソース停止（local URL 変更等）で「実体未確認」劣化になること / 「モデル一覧を更新」で再取得
- [ ] マージ `git merge --no-ff feat/provider-overhaul` → CHANGELOG 最終確認 → タグ v0.24.0 → push → `cd app/client && bun run build && launchctl kickstart -k gui/$(id -u)/com.local.solo-eikaiwa.server` → health/https 200 → 台帳・メモリ更新 → Tauri Phase 1 へ
