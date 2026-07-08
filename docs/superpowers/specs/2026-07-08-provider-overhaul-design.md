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
- 優先順位（binding）: **ロール tuning > env（CODEX_REASONING_EFFORT/CODEX_SERVICE_TIER・新設 CLAUDE_MODEL/CLAUDE_EFFORT）> コード既定（claude: sonnet+SDK既定 / codex: medium+fast）**

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
| クイック支援 | **haiku / low** | low / fast | 訳=最単純タスク・即答・誤り実害小 |
| コーチング | sonnet / high | medium / fast | SRS 直結（AE/振り返り）+ 恒久キャッシュ解説は初回勝負 |
| 教材生成 | sonnet / medium | medium / fast | 背景先読みで猶予・セッション使い捨て |
| 測定 | **opus / xhigh** | xhigh / **standard** | 月1未満・レベル判定は判断タスクで xhigh が効く・待てるので priority 不要 |

- 精査メモ: 月次レビュー単体なら effort=medium で足りる可能性が高い（定型日本語化）が、頻度からコスト差は誤差のため測定ロールごと opus/xhigh に单純化
- 適用方式: **既定は変えない**。用途タブに「推奨チューニングを適用」ボタン（クラウド割当のロールにのみ上表を書き込む・ローカル割当ロールは対象外）。roleReason 文言をマトリクス整合に更新（EN/JA）
- CLI content-gen: README のカスタマイズ節に「恒久教材の生成は `LLM_PROVIDER=claude CLAUDE_MODEL=opus CLAUDE_EFFORT=high` 推奨」を明記（env は CLI/ヘッドレスのブートストラップ用途として正当）

## 5. APIキー認証の選択

- 新テーブル `llm_auth(provider TEXT PRIMARY KEY, mode TEXT NOT NULL)`（provider: "claude"|"codex" / mode: "subscription"|"api-key"・行不在=subscription）+ store + ルート拡張（GET/PUT llm-settings に authModes を additive 追加）
- **キーは UI/DB に保存しない**（従来原則）: `app/.env` の `ANTHROPIC_API_KEY` / `CODEX_API_KEY`。UI は env のキー検出状態のみ表示（値は出さない）
- claude × api-key: SDK 経路は spawn env に `ANTHROPIC_API_KEY` を注入（SDK は env を継承）。`claude -p` 経路は同 env + `--bare`（OAuth/keychain を読まない厳格モード・実測確認済み）
- codex × api-key: exec 経路 = spawn env `CODEX_API_KEY`（auth.json より優先・永続化なし・実測確認済み。OPENAI_API_KEY では認証されない点に注意）。app-server 経路 = **standalone app-server では env が無効**（codex-rs 実測）ため、**アプリ専用の隔離 `CODEX_HOME`（`DATA_DIR/codex-home`・gitignore 領域）** を使い、モード適用時にサーバが `CODEX_HOME=… codex login --with-api-key`（stdin でキー）を1回実行して auth.json を作る。以後の app-server/exec spawn は常にこの CODEX_HOME を env で指す。**ユーザー本体の ~/.codex（ChatGPT ログイン）には一切触れない**
- subscription モード（既定）: 現行どおり（ユーザーの CLI ログインに相乗り・CODEX_HOME 指定なし）
- モード切替時: codex app-server の常駐プロセスは kill して次回 lazy spawn（認証環境が変わるため）。認証状態の表示は `codex login status`（exit code）/ app-server v2 `account/read` を将来候補とし、v0.24 では env キー検出 + モード表示に留める
- ドキュメント明記: APIキー = api.openai.com / Anthropic API の**従量課金**（サブスク枠と別）・Codex はモデル一覧配信が無くなる等の可用性差

## 6. env 最小化

- UI 化されていない非 secret 設定は CODEX_REASONING_EFFORT / CODEX_SERVICE_TIER の2つだけ（棚卸し確定）→ §3 で UI 化され、env の役割は **secrets（OPENAI_API_KEY / OPENAI_COMPAT_API_KEY / TTS_API_KEY / ANTHROPIC_API_KEY / CODEX_API_KEY）+ ヘッドレス/CLI ブートストラップ（LLM_PROVIDER・OPENAI_COMPAT_*・CODEX_*・CLAUDE_*・TTS_*）** に純化
- README の env 表を「UI で設定可（DB が env を上書き）/ env のみ（secrets・CLI）」の2区分で再編。優先順位（tuning > env > 既定）を明文化

## 7. 不変条件・検証

- `ClaudeRunner` 型・消費側ドメインモジュールの呼び出し形: 不変（runnerFor の引数に "assist" が増えるのみ）
- **設定を変えなければ挙動完全同一**（5ロール連鎖・tuning センチネル・authMode 既定 subscription がこれを保証）。工場既定の Claude モデルは sonnet のまま
- サーバ新ロジック TDD / 検証ゲート3種 / PUBLIC 衛生 / 研究制約 / i18n EN・JA 同時
- 手動スモーク: ①claude -p フォールバック発火（SDK を壊す shim）と resume 継続 ②ロール別 effort が thread/start パラメータに乗ること（fake 検証+実機1回）③assist 分離後の訳ボタンが assist 経路で動くこと ④codex api-key モードの隔離 CODEX_HOME 作成と ~/.codex 不干渉 ⑤「推奨チューニングを適用」の書き込み内容
- リリース: v0.24.0（CHANGELOG・README「できること」・タグ・デプロイ）。完了後 Tauri Phase 1 へ

## 8. 将来課題（本改修で作らないもの）

- Claude の thinking 予算 UI（SDK 既定 adaptive のまま）/ GPT のロール別モデル（ユーザー方針で不要）/ openai-compat へのフォールバック / 認証状態のリッチ表示（account/read 連携）
