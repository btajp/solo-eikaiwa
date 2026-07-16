# API キーの UI 設定（Keychain 保存）設計ドキュメント（v0.29 追補）

- 起点: ユーザー指示（2026-07-10）「全部 UI でやる案はどう？」→ 設定の UI 一元化（同日実装済み）の最終ピースとして、API キーも UI から設定できるようにする
- ユーザー確認済みの決定: 保存先は **macOS Keychain**（DB 平文は不採用）/ **Keychain > env の併存**（`app/.env` は開発者・CLI 向けフォールバックとして存続）
- 実測済み（2026-07-10）: `security -i` の stdin 経由で add/find/delete がプロンプトなしで成立（値が argv に露出しない）。LaunchAgent・Tauri sidecar とも「ログインセッション内でユーザー権限のプロセス」なので同一手法が使える

## 1. 解くべき問題

1. **配布 Tauri アプリは `app/.env` を読まない**（sidecar には `SOLO_EIKAIWA_*` しか注入されない）ため、配布形態では鍵必須機能（OpenAI TTS・api-key モードの Claude/Codex・鍵必須の OpenAI 互換）が構造的に使えない
2. ソース運用でも鍵だけ `.env` 手編集が必要で、「設定は UI」の一元化が完結していない

## 2. サーバ: `app/server/secrets.ts` 新設

- `security` CLI ラッパ。**呼び出しは `security -i` の stdin 経由**（鍵の値を argv に出さない＝`ps` 露出防止）。サービス名 `solo-eikaiwa`・アカウント名 = 変数名。spawn は注入シーム（`SpawnFn`）で TDD
- **対象4鍵（ホワイトリスト・binding）**: `ANTHROPIC_API_KEY` / `CODEX_API_KEY` / `OPENAI_COMPAT_API_KEY` / `TTS_API_KEY`。`OPENAI_API_KEY` は UI に出さず env のみ（TTS は `TTS_API_KEY` が優先解決されるため UI 上はこれで完結。CLI の音声生成用は従来どおり）
- **起動時と保存/削除後に Keychain の値をプロセス env（`process.env`）へ注入**する。「Keychain > env」は上書きで実現。既存の鍵消費点（`Bun.env` 直読み4箇所・`settingsToEnv` の API_KEY_ENV_VARS・codex-auth・tts.ts・health）は**一切変更不要**で効く。子プロセスへの露出は現状（Bun が `.env` をプロセス env に読み込む）と完全同等＝悪化しない
- 起動時に env 由来の元値をスナップショットし、DELETE 時は「Keychain から削除 → スナップショット値へ復元」（env にあれば env に戻る）。source 追跡（keychain | env | null）は注入時に in-memory で記録
- 起動時の Keychain 読み込み失敗（ロック等）は warn して env のみで継続（fail-open・起動をブロックしない）

> **2026-07-17 改訂注記（§2）**: 本節は後続決定で2点改訂済み。現行の正は `app/server/secrets.ts`。
>
> 1. **「Keychain の値を `process.env` へ注入」は廃止**（v0.29.0・#132「APIキーの継承と送信先を制限」）。現行は Keychain 値をマネージャ内だけに保持して消費点へ解決し、`process.env` へは展開しない（子プロセスへの継承・送信先を制限するため。README「仕組みとプライバシー」節参照）
> 2. **対象は4鍵 → 5鍵**（v0.29.1）。`OPENAI_API_KEY` を加え、OpenAI 公式（固定URL・専用キー）と OpenAI 互換（独自URL・接続先別キー）を別接続として分離し、APIキーと認証方式は専用タブへ集約された（`KEYCHAIN_SECRET_NAMES` 参照）

## 3. API（`routes/secrets.ts` 新設・write-only）

- `GET /api/secrets` → `{ [name]: { configured: boolean, source: "keychain" | "env" | null } }`。**値はいかなる応答・ログ・エラーメッセージにも含めない**
- `PUT /api/secrets` `{ name, value }` → 検証（4鍵ホワイトリスト・trim 後 1..500 文字）→ Keychain 保存 → env 再注入 → 再解決
- `DELETE /api/secrets/:name` → Keychain 削除 → env 復元 → 再解決
- **再解決（再起動なし反映・binding）**: 保存/削除後に `applyLlmSettings` 経路で5ロール runner を一括再解決し、`CODEX_API_KEY` 変更時は codex 常駐 app-server を kill（既存の認証モード変更時と同じ扱い）。TTS は毎リクエスト解決のため追加処理なし
- `security` CLI 失敗時は 500 + 情報的メッセージ（値を含めない）

## 4. クライアント（設定 → モデル接続設定）

- Claude 認証・ローカル LLM・Codex 認証・TTS の各セクションに **API キー欄**: `type=password` のマスク入力 + 状態表示 + 保存/削除ボタン。保存済みの値は表示・再取得不可（置換のみ）
- 状態表示は**ソースを必ず明示**（feedback-show-resolved-defaults 準拠）: 「設定済み（Keychain）」「設定済み（app/.env から検出）」「未設定」
- 既存の「app/.env に追記してください」系文言を全て置き換え（i18n 型 + EN + JA 3点同時）
- 認証モード `api-key` の選択可能条件（現在は env 検出のみ）を「Keychain or env に検出」へ拡張（`getAuthKeysConfigured` が注入後の env を見るため実装上は自然に成立するが、テストで明示する）

## 5. ドキュメント・規約改訂

- AGENTS.md の鍵規約を「API キー等の secrets は **Keychain（UI 設定）または `app/.env`** のみ。DB・API レスポンス・ログ・plist に出さない」へ改訂
- README: セットアップ節（.env 手編集を「任意」へ格下げ・UI 設定を正に）・機能マトリクス・デスクトップ節（配布アプリで鍵必須機能が使えるようになった）・CHANGELOG（[0.29.0] へ追記）

## 6. テスト・検証

- `secrets.ts`: fake spawn で TDD（stdin へ渡るコマンド列の検証＝値が argv に含まれないことの機械検証・失敗系）
- `routes/secrets.ts`: GET/PUT/DELETE の検証・**「GET とエラー応答に鍵の値が含まれない」を明示テスト**・ホワイトリスト外 400
- 実 Keychain 統合スモーク（手動 runbook）: 保存 → `security find-generic-password` で確認 → UI 状態表示 → 削除 → env 復元
- **security-reviewer によるレビューを必須工程**とする（鍵の取り扱い変更のため）
- 検証ゲート3種

## 7. スコープ外

- `OPENAI_API_KEY` の UI 化（TTS_API_KEY で代替・CLI 用は env）
- 鍵の DB 暗号化保存・macOS 以外の Keychain 相当（アプリ自体が macOS 専用）
- Keychain の ACL 厳格化（`security` CLI 経由は「このユーザーのプロセスなら読める」レベル。chmod 600 ファイル同等の脅威モデルだが、ディスク上の暗号化と data/ コピーへの非混入で従来より改善）

## 8. 残リスク

- `security` CLI の挙動は macOS バージョン依存の可能性（実測は macOS 15/Darwin 25）。統合スモークを初回リリース前に必ず実施
- ヘッドレス（GUI ログインなし）環境では login keychain がロックされ読めない — その場合 env フォールバックで動く（fail-open 設計で担保）
