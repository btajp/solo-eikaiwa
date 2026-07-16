# v0.24.0 プロバイダ大改修 設計ドキュメント（対称化・5ロール再編・ロール別チューニング・APIキー認証・env最小化）

- Status: 承認済み（2026-07-08 ユーザー承認。設計対話で確定: GPT=全ロール GPT-5.5 統一 / Claude=エイリアス haiku・sonnet・opus で常に最新 / 5ロール再編込み / spec レビュー省略・実装まで自走）
- 起点: バックログ4件（memory/provider-architecture-principles・優先順 ①対称化→④env最小化→③ロール別チューニング→②APIキー認証）+ ユーザー指示「用途ごとの最適を深く再検討」
- 調査根拠: claude CLI 2.1.204 実測（`-p`/`--resume`/`--effort`/`--tools ""`/`--bare` 動作確認）/ codex 0.142.5 認証実測 + codex-rs ソース / 全13 LLM呼び出し箇所の棚卸し（2026-07-08・本文§3）

## 1. 対称アーキテクチャ

### 1-1. Claude フォールバック（SDK → `claude -p` ワンショット）

- 新規 `app/server/providers/claude-print.ts`: `makeClaudePrintRunner(cfg)` — `ClaudeRunner` 適合
- spawn 形（実測に基づく・binding）: `claude -p --output-format json --tools "" --max-turns 1 --model <alias> [--effort <effort>] --system-prompt <sys> [--resume <sessionId>]`、プロンプトは stdin、応答は stdout の単一 JSON（`result` / `session_id` / `is_error` / `subtype`）
- **cwd は固定の中立ディレクトリ**（`DATA_DIR/claude-print/`・ensureDirs で作成）: セッション保存が cwd にキーされるため毎回 mkdtemp 不可（実測で確認済みの制約）。`--no-session-persistence` は付けない（resume が壊れる）
- ネイティブ resume がディスク永続 → フォールバック側も再起動をまたぐ継続が効く（インメモリ畳み込み不要 = codex exec より単純）
- エラー契約: exit≠0 → stderr 末尾付き throw / `is_error:true` or `subtype!=="success"` → throw / 空 result → `"Claude returned empty result"`

### 1-2. 型付きエラーの中立化と2相分類

- `TransportError` を `app/server/providers/errors.ts` へ移設（codex-app-server.ts から import 方向を反転）
- `makeClaudeRunner`（SDK 経路）を2相分類: **SDK の最初のメッセージ到達前の throw**（CLI 不在・spawn 失敗・接続不能）= `TransportError` / **result subtype エラー・空応答** = plain Error（モデル起因・フォールバックしない）。メッセージ文字列 sniffing はしない

### 1-3. 共通デコレータと重複解消

- `withFallback(primary, fallback)`: `TransportError` のときのみ fallback を同一引数で実行し warn ログ（codex の既存実装をこの形に抽出・claude が第2利用者）。codex 側の「フォールバック直前の threads.clear()」は runner 側に残す（掃除して TransportError を rethrow → 委譲判断はラッパ）
- `withTimeout(runner, ms=180_000)`: 全経路（claude SDK / claude -p / openai-compat / codex exec）に適用し「codex app-server だけ 180 秒・他は無限」の非対称を解消。タイムアウトは `TransportError` 扱い（プライマリ側で発火時はフォールバックが受ける）
- `providers/transcript.ts`: `{role, content}` 型・`appendTurn`・`resolveSessionId` を抽出（openai-compat / codex exec / codex app-server の三重複解消）。`composeCodexPrompt` のフォーマットは codex 規約に結合しているため共通化しない
- **やらないこと**: openai-compat へのフォールバック（ローカル停止は見せるべきエラー）/ 汎用 JSON-RPC 化 / Claude 側 registry・世代管理（SDK がプロセス寿命を持ち対称物の基盤が無い）

## 2. 5ロール再編（assist 新設）

- `LlmRole` を `conversation | assist | coaching | generation | assessment` の5値へ（server: llm-provider.ts / client: api/llm-settings.ts）
- **assist（クイック支援）** = 発話1文翻訳（generateUtteranceTranslation）・言い方ヒント（generatePhraseHints）・訂正のちょい解説（generateFixExplanation）。coaching に残るもの = AE添削・振り返り・例文解説・トーク解説（恒久キャッシュ系は初回品質勝負のため品質側に残す）
- **後方互換のフォールバック連鎖（binding・マイグレーション不要の核）**: assist のロール行/チューニング行が無ければ **coaching の設定を継承**し、coaching も無ければ global へ。既存ユーザーは無設定なら挙動完全不変
- プリセット: assist スロットを追加 — オールローカル=local / バランス=**local**（軽量タスクはローカルで十分・速い）/ 最高品質=優先クラウド。`presetTargets`/`matchPreset` は5ロールで再定義（テスト先行）
- CLI（恒久教材生成 content-gen）は UI ロールにしない: env 運用のまま、既定推奨を opus/high 相当へ（§4・README 明記）

## 3. ロール別チューニング（model / effort / service tier）

### 3-1. 永続化（マイグレーション禁止規約適合）

新テーブル（llm_role_settings 追加時の先例踏襲・`ensureLlmRoleTuningSchema` + `makeLlmRoleTuningStore` + db.ts 1行）:

```sql
CREATE TABLE IF NOT EXISTS llm_role_tuning (
  role TEXT PRIMARY KEY,
  claude_model TEXT,      -- "haiku" | "sonnet" | "opus"（エイリアス・常に最新へ解決）| NULL=既定
  effort TEXT,            -- "low" | "medium" | "high" | "xhigh" | NULL=既定（claude/codex共通語彙）
  service_tier TEXT,      -- "fast" | "standard" | NULL=既定（codexのみ有効）
  updated_at TEXT NOT NULL
)
```

- 行不在 = 既定継承センチネル（assist→coaching 連鎖は §2 と同一規則）
- 優先順位（binding・2026-07-08 ユーザー指示で改定）: **ロール tuning > コード既定（claude: sonnet+SDK既定 / codex: medium+fast）**。~~env 中間層（CODEX_REASONING_EFFORT/CODEX_SERVICE_TIER/CLAUDE_MODEL/CLAUDE_EFFORT）~~ は**サーバでは読まない**（UI に見えない裏設定の禁止 — UI の「既定」表示が常に真実であること）。CLI（generate-content.ts）のみ自エントリポイントで env を明示解釈してランナーへ渡す（CLI プロセスの env はその CLI のインターフェースであり、UI が説明責任を負う対象外）

### 3-2. 配線

- claude: `makeClaudeRunner` を `{model, effort}` パラメータ化（SDK Options の `model`/`effort` に直結・実在確認済み）。**tuning 未指定時は既存の module-level 単一インスタンスを返す**（「claude/env に戻すと同一参照」回帰基準の維持）
- codex: **単一常駐プロセスのまま per-thread パラメータで渡す**（model/effort/tier は spawn 引数ではなく thread/start・thread/resume のリクエストパラメータであることを確認済み）。registry の connectionKey から model/effort/tier を外しプロセスは1本に（eviction ping-pong の構造的解消）。runner cfg はロールごとに threadParams へ反映。exec フォールバックは呼び出しごとの `-c` フラグで自明に per-role 成立
- GPT のモデルは接続レベル codexModel のまま（**全ロール単一モデルのユーザー方針**・ロール別 GPT モデルは作らない）。**推奨既定は「未指定 = codex CLI の既定に追従」**（Claude のエイリアス方式と同思想。GPT-5.6 等が出れば CLI 更新で自動追従・固定したい場合のみ codexModel に明示。2026-07-08 ユーザー確認「5.6が出たらまた話変わる」への対応）

### 3-3. API / UI

- `PUT /api/llm-settings/roles` の body に `tuning?: Record<LlmRole, { claudeModel?: string|null; effort?: string|null; serviceTier?: string|null }>` を追加（2パス all-or-nothing の原子性維持・応答 roles は additive で後方互換・値はホワイトリスト検証）
- クライアント: `buildRolesPayload` が tuning を常に含めて全量再構築（UI state に tuning を持ち保存でのクロバー防止）。プリセット適用は tuning を**変更しない**
- UI（用途ごとのモデルタブ）: 各ロール行に「詳細」ディスクロージャ — モデル（claude 割当時のみ・既定/haiku/sonnet/opus）・effort（既定/low/medium/high/xhigh）・tier（codex 割当時のみ・既定/fast/standard）

## 4. 推奨マトリクス（棚卸し§に基づく・「推奨チューニングを適用」ワンタップ）

| ロール | Claude 推奨 | GPT 推奨（モデルは全ロール共通・未指定=CLI最新既定） | 根拠（棚卸し結果） |
|---|---|---|---|
| 会話 | sonnet / low | low / fast | テンポ最優先・短出力・最頻 |
| クイック支援 | **haiku / —（effort 指定なし）** | low / fast | 訳=最単純タスク・即答・誤り実害小。haiku は effort 非対応（実測 2026-07-08: `--effort` は黙って無視される）— 無視される値を書き込む/表示するのは UI 真実性違反のため effort は null |
| コーチング | sonnet / high | medium / fast | SRS 直結（AE/振り返り）+ 恒久キャッシュ解説は初回勝負 |
| 教材生成 | sonnet / medium | medium / fast | 背景先読みで猶予・セッション使い捨て |
| 測定 | **opus / xhigh** | xhigh / **standard** | 月1未満・レベル判定は判断タスクで xhigh が効く・待てるので priority 不要 |

- 精査メモ: 月次レビュー単体なら effort=medium で足りる可能性が高い（定型日本語化）が、頻度からコスト差は誤差のため測定ロールごと opus/xhigh に单純化
- 適用方式: **既定は変えない**。用途タブに「推奨チューニングを適用」ボタン（クラウド割当のロールにのみ上表を書き込む・ローカル割当ロールは対象外）。roleReason 文言をマトリクス整合に更新（EN/JA）
- CLI content-gen: README のカスタマイズ節に「恒久教材の生成は `LLM_PROVIDER=claude CLAUDE_MODEL=opus CLAUDE_EFFORT=high` 推奨」を明記。これらの env は **generate-content.ts が自エントリポイントで明示解釈**してランナーへ渡す（whitelist 検証つき・サーバ本体は読まない — §3-1 の改定に整合）

## 5. APIキー認証の選択

- 新テーブル `llm_auth(provider TEXT PRIMARY KEY, mode TEXT NOT NULL)`（provider: "claude"|"codex" / mode: "subscription"|"api-key"・行不在=subscription）+ store + ルート拡張（GET/PUT llm-settings に authModes を additive 追加）
- **キーは UI/DB に保存しない**（従来原則）: `app/.env` の `ANTHROPIC_API_KEY` / `CODEX_API_KEY`。UI は env のキー検出状態のみ表示（値は出さない）
- claude × api-key: SDK 経路は spawn env に `ANTHROPIC_API_KEY` を注入（SDK は env を継承）。`claude -p` 経路は同 env + `--bare`（OAuth/keychain を読まない厳格モード・実測確認済み）
- codex × api-key（2026-07-08 実装時に統一へ改訂）: **exec / app-server の両経路とも隔離 `CODEX_HOME`（`DATA_DIR/codex-home`・gitignore 領域）に統一**。モード適用時にサーバが `CODEX_HOME=… codex login --with-api-key`（stdin でキー・argv に載せない）を1回実行して auth.json を作り、以後の全 codex spawn がこの CODEX_HOME を env で指す。当初案は exec=`CODEX_API_KEY` 直接注入（実測確認済み）だったが、認証面を1つに統一する方が単純で、**exec が CODEX_HOME の隔離を尊重し空なら 401 になる（~/.codex へ黙ってフォールバックしない）ことを実測確認**（2026-07-08・`codex login status`=Not logged in / `codex exec`=401）したため統一を採用。standalone app-server では env のキーが無効（codex-rs 実測）という前提は不変。**ユーザー本体の ~/.codex（ChatGPT ログイン）には一切触れない**。手動スモーク④は app-server に加え **exec 経路の api-key 動作も個別確認**する（実キー投入はスモーク時のみ）
- subscription モード（既定）: 現行どおり（ユーザーの CLI ログインに相乗り・CODEX_HOME 指定なし）
- モード切替時: codex app-server の常駐プロセスは kill して次回 lazy spawn（認証環境が変わるため）。認証状態の表示は `codex login status`（exit code）/ app-server v2 `account/read` を将来候補とし、v0.24 では env キー検出 + モード表示に留める
- ドキュメント明記: APIキー = api.openai.com / Anthropic API の**従量課金**（サブスク枠と別）・Codex はモデル一覧配信が無くなる等の可用性差

> **2026-07-17 改訂注記**: 本節の「キーは UI/DB に保存しない（`app/.env` のみ・UI は env のキー検出状態表示のみ）」は改訂済み。v0.29.0 で API キーの UI 設定（macOS Keychain 保存・write-only・値は UI にもサーバ応答にも返さない）が導入され、v0.29.1 で専用タブへ集約・対象5鍵（`ANTHROPIC_API_KEY` / `CODEX_API_KEY` / `OPENAI_API_KEY` / `OPENAI_COMPAT_API_KEY` / `TTS_API_KEY`）となった。現行は `app/server/secrets.ts` と [2026-07-10-api-keys-keychain-design.md](2026-07-10-api-keys-keychain-design.md) を参照。

## 6. env 最小化

- UI 化されていない非 secret 設定は CODEX_REASONING_EFFORT / CODEX_SERVICE_TIER の2つだけ（棚卸し確定）→ §3 で UI 化され、**サーバはチューニング系 env（CLAUDE_MODEL/CLAUDE_EFFORT/CODEX_REASONING_EFFORT/CODEX_SERVICE_TIER）を読まない**（2026-07-08 ユーザー指示: UI に見えない裏設定の禁止）。env の役割は **secrets（OPENAI_API_KEY / OPENAI_COMPAT_API_KEY / TTS_API_KEY / ANTHROPIC_API_KEY / CODEX_API_KEY）+ ヘッドレス/CLI ブートストラップ（LLM_PROVIDER・OPENAI_COMPAT_*・TTS_*、チューニング系4変数は CLI エントリポイントのみが解釈）** に純化
- README の env 表を「UI で設定（サーバの唯一の真実 = DB）/ env のみ（secrets・CLI 専用）」の2区分で再編。優先順位（tuning > コード既定・env 中間層なし）を明文化
- **UI 真実性の原則（binding）**: 画面に見える設定と実際の挙動は常に一致する。UI が「既定」と表示するものの実体はコード定数であり、env や隠れた設定で変わらない。§7 の実効モデル可視化もこの原則の適用

> **2026-07-17 改訂注記**: 「secrets は env のみ」という本節の前提は v0.29.0〜v0.29.1（API キーの UI 設定・Keychain 保存）で改訂済み。現行の解決優先順位は **Keychain > `app/.env`**（env は Keychain 未設定時のフォールバック兼ヘッドレス/CLI ブートストラップ）。詳細は `app/server/secrets.ts` と [2026-07-10-api-keys-keychain-design.md](2026-07-10-api-keys-keychain-design.md) を参照。

## 7. 実効モデルの可視化・選択（2026-07-08 ユーザー要件追加）

要件（binding・ユーザー指示逐語ベース）: **①ユーザーがしっかり選択できる ②現在何が使われているかが明確に分かる**（Codex が GPT-5.5 か 5.4 か Codex 5.3 か / Claude の sonnet の実体がバージョン何か）**③既定・推奨の設定がすべて一目で分かる**。

- **モデルカタログ API（新設 `GET /api/llm-models`）**: 3ソースを統一形 `{ provider, available, reason?, models: [...], fetchedAt }` で返す。models 要素: `{ id, displayName, description, resolvedModel?, efforts?, defaultEffort?, tiers?, defaultTier?, isDefault? }`
  - claude: Agent SDK `query().supportedModels()` — ModelInfo に `value` / **`resolvedModel`**（'sonnet'→'claude-sonnet-5' 形式の canonical wire id）/ `displayName` / `description` / `supportedEffortLevels`（sdk.d.ts 実在確認済み）。CLI メタデータでありトークン消費なし・spawn 1回のコスト
  - codex: app-server v2 **`model/list`** — `Model` に `id` / `model` / `displayName` / `description` / `supportedReasoningEfforts`（各 effort に description つき）/ `defaultReasoningEffort` / `serviceTiers`（id/name/description）/ `defaultServiceTier` / **`isDefault`**（codex-rs protocol 実在確認済み・非 experimental）。常駐プロセスへの追加リクエスト1本
  - local: OpenAI 互換 `GET {baseUrl}/models`（Ollama / LM Studio 標準エンドポイント）
  - サーバ内 TTL キャッシュ（1h 目安）+ `?refresh=1` 強制再取得。**取得失敗は `{available:false, reason}`** — UI は現行の静的選択肢へ劣化し「実体未確認」を明示（**嘘の表示をしない**）
- **選択（要件①）**: claude ロール tuning のモデル DD = カタログ由来選択肢（「Sonnet — claude-sonnet-4-5」形式で実体併記・**保存値はエイリアスのまま** = 最新自動追従の維持）。codexModel（接続タブ）= 自由記述 → カタログ DD 化（isDefault 行に「CLI 既定」バッジ・カタログ不可時は自由記述フォールバック）。local model = /models 由来 DD + 自由記述フォールバック。effort DD の選択肢は選択中モデルの supported efforts に絞る
- **実効表示（要件②）**: 用途タブの各ロール行に常時「実効」サマリ1行 = 実効プロバイダ + 具体モデル ID（カタログ解決値）+ effort + tier。inherit 連鎖（assist→coaching）も解決後の値で表示。カタログ不可時は「未確認」明示
- **既定・推奨（要件③）**: 「既定（…）」ラベルはコード定数とカタログ既定（isDefault / defaultReasoningEffort / defaultServiceTier）で具体化。codex effort 選択肢にカタログの description を併記。推奨は §4 の適用ボタン + roleReason（既存）で提示
- §5 との関係: codex api-key モードではモデル一覧配信が無くなる可能性 → available:false 劣化パスで吸収

## 8. 不変条件・検証

- `ClaudeRunner` 型・消費側ドメインモジュールの呼び出し形: 不変（runnerFor の引数に "assist" が増えるのみ）
- **設定を変えなければ挙動完全同一**（5ロール連鎖・tuning センチネル・authMode 既定 subscription がこれを保証）。工場既定の Claude モデルは sonnet のまま
- サーバ新ロジック TDD / 検証ゲート3種 / PUBLIC 衛生 / 研究制約 / i18n EN・JA 同時
- 手動スモーク: ①claude -p フォールバック発火（SDK を壊す shim）と resume 継続 ②ロール別 effort が thread/start パラメータに乗ること（fake 検証+実機1回）③assist 分離後の訳ボタンが assist 経路で動くこと ④codex api-key モードの隔離 CODEX_HOME 作成と ~/.codex 不干渉 ⑤「推奨チューニングを適用」の書き込み内容 ⑥モデルカタログ実機（claude supportedModels の resolvedModel / codex model/list の isDefault が UI に出ること・ソース停止時の「実体未確認」劣化）
- リリース: v0.24.0（CHANGELOG・README「できること」・タグ・デプロイ）。完了後 Tauri Phase 1 へ

## 9. 将来課題（本改修で作らないもの）

- Claude の thinking 予算 UI（SDK 既定 adaptive のまま）/ GPT のロール別モデル（ユーザー方針で不要）/ openai-compat へのフォールバック / 認証状態のリッチ表示（account/read 連携）
