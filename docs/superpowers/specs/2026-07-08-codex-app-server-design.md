# Codex App Server 統合 + 優先クラウド設定 設計ドキュメント（v0.23.0）

- Status: 承認済み（2026-07-08 ユーザー承認。spec レビューは省略指示・実装まで自走）
- 起点: ユーザー方針「クラウド LLM は Claude / Codex を同等に扱う」（memory: codex-parity-policy）。判断1（`docs/superpowers/plans/2026-07-07-multi-provider-runner.md`）の正式な再訪。「experimental/ベータであることだけを理由に外さない」
- 目的: ①Codex のセッション永続化を Claude Agent SDK と同等に（サーバ再起動をまたぐ会話復元）②プリセットのクラウド枠をユーザーの課金先（Claude/Codex）で選べるように
- 調査根拠: codex-cli **0.142.5** での実地プロトコル確認（2026-07-08・4視点並列調査）

## 1. スコープ

| # | 内容 | 対象 |
| --- | --- | --- |
| A | app-server 常駐アダプタ（exec 自動フォールバック付き） | `app/server/providers/` |
| B | 優先クラウド設定（クライアント専用・localStorage） | `app/client/` |
| C | ドキュメント（README 3節書き換え・CHANGELOG・できること） | docs |

判断1の却下理由4点への回答: (1)不安定性→スナップショット+版チェック+exec フォールバックで緩和 (2)出力取得→`turn/completed`/`item/completed` の agentMessage 収集で単純 (3)セッション写像→ネイティブ threadId で簡素化+再起動復元 (4)寿命管理→復活するが接続設定単位の singleton（`llm-warmup.ts` の setTarget 前例）で管理。

## 2. プロトコル事実（0.142.5 実測・実装の前提）

- トランスポート: **stdio 上の改行区切り JSON-RPC**。Content-Length ヘッダなし。**レスポンス/通知に `jsonrpc` フィールドが無い**ため既製 JSON-RPC ライブラリは使わず自前の薄いクライアントを書く。未知の通知メソッドは必ず無視する
- ハンドシェイク: `initialize {clientInfo, capabilities}` → 応答受領後にクライアントから通知 `initialized`。`capabilities.optOutNotificationMethods` で不要通知を抑制可
- 会話 API は **v2 thread/turn 系**（v1 の newConversation/sendUserMessage は 0.142.5 で消滅済み — 破壊的変更は現実に起きる）:
  - `thread/start`（model?, approvalPolicy?, sandbox?, config?, developerInstructions? 等）→ `{thread: {id: ThreadId(UUID), ...}}`
  - `turn/start`（threadId, input: [{type:"text", text}], ターン単位 override 可）
  - `thread/resume`（threadId 必須 + override）— **ディスク上の rollout からの復元。サーバ再起動後も再開可**（thread_id 指定が推奨と doc 明記）
  - 応答収集: `item/completed`（`item.type=agentMessage` の text）と `turn/completed`（`turn.status: completed|failed|...`、失敗時 `turn.error`）。ストリーミング delta は本アプリでは不使用
- 安全指定は**プロトコルレベルで完結**: `thread/start` に `sandbox: "read-only"` + `approvalPolicy: "never"`（config.toml の danger-full-access に依存しない）。承認系 ServerRequest（commandExecution/fileChange/permissions 等）には防御的に decline を返す実装を置く
- プロセス: stdio モードは **stdin close で即・正常終了**（親死亡時の道連れ確保）。`app-server daemon` モードは CLI と server の版ズレリスクがあるため**使わない**
- reasoning effort / service tier: 現行既定（medium / fast）を踏襲。`thread/start` の `config` で `model_reasoning_effort` / `service_tier` を渡す（生成型で正確なキー名を確認して実装。渡せない場合は `-c` 相当の起動時指定にフォールバック）

## 3. A: app-server アダプタ設計

新規 `app/server/providers/codex-app-server.ts`。**`ClaudeRunner` 型は不変**（消費側6ファイル無変更）。生成点は `llm-provider.ts` の `selectRunner` codex 分岐のみ差し替え。

### 構成（テスト可能な3層）

1. **transport 層**（注入 seam）: `spawn → 行分割 → id 対応付け → 通知ディスパッチ` を関数型 seam `CodexAppServerTransport` として切り出し、テストはスクリプト化したフェイク（現行 `CodexExec` seam と同じ流儀）。実プロセス部分は単体テスト対象外・手動スモーク
2. **client 層**: initialize ハンドシェイク・`thread/start`/`turn/start`/`thread/resume`・応答収集（agentMessage 連結）・承認 decline・タイムアウト
3. **runner 層**: `ClaudeRunner` 適合。`sessionId = threadId` をそのまま採用

### セッション解決の階梯（1呼び出し内で上から順に試す）

1. 既知の threadId（プロセス生存中）→ `turn/start`
2. 未知の threadId（サーバ再起動後など）→ `thread/resume(threadId)` → 成功なら `turn/start`（**パリティ達成点**）
3. resume 失敗 → 新スレッド作成 + **保険のインメモリ・トランスクリプトを初回入力に畳んで再投入**（現行 `composeCodexPrompt` の履歴畳み込みを保険層として温存。Map は app-server 経由でも並行維持する）
4. transport 層の失敗（spawn 失敗・ハンドシェイク不成立・プロセス死亡・プロトコルエラー）→ **その呼び出しを現行 exec アダプタで実行**（warn ログ + 再 spawn は次回 lazy）。モデル起因の失敗（`turn.status=failed`・空応答）はフォールバックせず現行同様 throw

### systemPrompt の扱い

現行契約は毎呼び出し `opts.systemPrompt`。スレッド作成時に `developerInstructions` として固定し、スレッドごとに採用した systemPrompt を記録。**同一 sessionId で systemPrompt が変わったら**新スレッド + 履歴畳み込み（会話ロールでは実際には変わらない。防御的挙動）。

### 寿命管理

- モジュールレベルの **接続設定キー（model/effort/tier）付き singleton**。`applyLlmRoleSettings` が設定保存のたびに runner を再生成しても、キー同一なら常駐プロセスを再利用（**プロセスリーク防止・ロール4割当でも常駐1本**）。キー変化時は旧プロセスを kill してから新設定で lazy spawn
- lazy spawn（初回呼び出し時）・exit 監視・指数 backoff 付き再 spawn（連続失敗时は exec フォールバックが実質の運転継続を担う）
- 明示 dispose 経路: `generate-content` CLI 等の短命プロセスでも stdin パイプの解放（親 exit）で子が終了するため特別対応不要

### 版固定と破壊的変更検出

- `app/server/providers/codex-protocol.snapshot.json`: `codex app-server generate-json-schema` の出力をコミット。再生成 diff スクリプト `scripts/check-codex-protocol.sh`（手動/リリース前実行・CI 非依存）
- アダプタに検証済みバージョン定数（`0.142.5`）を持ち、初回 spawn 時に `codex --version` 照合。不一致は warn ログのみ（動作は継続・壊れたら exec フォールバック）

## 4. B: 優先クラウド設定

- **クライアント専用概念**。サーバ変更ゼロ（`buildRolesPayload` が常に全ロール明示 provider で PUT するため、書き込む値が変わるだけ）。永続化は localStorage キー `llm.preferredCloud`（`"claude" | "codex"`・既定 `claude`。`ui.scale`/`lang` と同パターン）
- `llm-assignments.ts`:
  - `presetTargets(id: PresetId, cloud: CloudTarget): RoleTargets` — PRESETS（claude 基準の定数として維持）の claude 枠を cloud で置換。`type CloudTarget = "claude" | "codex"`
  - `matchPreset(targets): { id: PresetId; cloud: CloudTarget } | "custom"` — **両クラウドを試す緩い一致**（クラウド枠が一様に claude または codex ならそのプリセット。混在は custom）。シグネチャ変更に伴い呼び出し側・テストを追随
  - ローカル未定義時のフォールバック先を `"claude"` 固定 → **優先クラウド**に変更（Codex のみ契約ユーザーへの配慮。codexModel 未設定でもサーバは許容し CLI 既定へ解決）
- UI（用途ごとのモデルタブ・プリセット select の直上）: 「優先クラウド」セグメント（Claude / Codex・`.lang-toggle`）+ 説明1行。優先クラウド変更は**既存割当を書き換えない**（次のプリセット適用から効く。matchPreset が緩い一致なので表示は落ちない）
- i18n: 断定文3箇所を出し分け — `presetHighQualityDesc`・`presetBalancedDesc` を `(cloud: string) => string` の関数値エントリへ（先例: `notApplied`/`envNote`）。`llm.help` の「既定（Claude）が動作確認済みの基準」は「Claude は動作確認済みの基準」の中立表現へ調整。新キー: `preferredCloudLabel`・`preferredCloudNote`。EN/JA 同時・コミットで明示
- 「動作確認済みの基準」の扱い: Claude にのみ成立する主張のため、優先クラウド=Codex の説明文では言わない（クラウド名の差し込みのみ）

## 5. C: ドキュメント

- README: セッション継続節（Claude=SDK ディスク永続 / **Codex=app-server ネイティブ継続（再起動復元・exec フォールバック時はインメモリ）** / openai-compat=インメモリ の3分化）・安全設定節（プロトコルレベル指定へ書き換え）・優先クラウドの説明追加・「できること」更新・プロバイダ表（env に変更なし）
- CHANGELOG v0.23.0（Keep a Changelog・日本語・ユーザー視点）
- 過去の CHANGELOG エントリは修正しない

## 6. テスト戦略・検証

- transport フェイク（スクリプト化した要求→応答/通知列）で client/runner 層を TDD: セッション再利用・resume 経路・畳み込みフォールバック・exec フォールバック発火・承認 decline・systemPrompt 変化時の新スレッド
- `presetTargets`/`matchPreset`/フォールバック先変更は既存 `llm-assignments.test.ts` をテスト先行で改修
- 検証ゲート: `cd app && bun test` / `bun run typecheck` / `cd app/client && bun run build`
- 手動スモーク（リリース前）: 実 codex で自由会話1往復 → サーバ再起動 → 同一セッション継続（resume 復元）→ codex 停止状態で exec フォールバック動作
- リリース: v0.23.0（CHANGELOG → README 差分チェック → タグ → デプロイ: client build + kickstart）

## 7. 将来課題（バックログ・2026-07-08 ユーザー指示。今回の実装はこれらを妨げない形にする。**優先順: 1 → 4 → 3 → 2**）

1. **プロバイダ対称アーキテクチャ**: Claude/Codex で共通化できる部分は共通化する。例: Codex に exec フォールバックを置くなら Claude にも `claude -p`（print モード）フォールバックを対称に用意する。アダプタの層構造（transport/client/runner/フォールバック）を両者で揃える方向へ
2. **認証方式の選択**: Claude SDK / Codex App Server とも、サブスクに加えて API キー認証も選べるように（サブスク基本のため優先度低）
3. **用途（ロール）ごとの effort / service tier 設定**: 現在はグローバル（env/既定）のみ。測定だけ effort=high 等、ロール単位で細かく設定できる UI へ
4. **環境変数の最小化**: UI で設定できるものと env でしか設定できないものの区別がユーザーに分かりにくい。設定は原則 UI（DB）へ寄せ、env は初期ブートストラップと secrets に限定する方向へ

## 8. 不変条件

- `ClaudeRunner` 型・消費側6ファイル・サーバ API 形状・DB スキーマ: 無変更
- APIキー衛生（`app/.env` のみ）・研究制約（情報的フィードバックのみ）・PUBLIC リポジトリ衛生: 維持
- 既定プロバイダは Claude のまま（設定を変えなければ挙動完全同一）。exec アダプタは削除しない（フォールバック層として恒久維持）
