# Tauri Phase 2（単体配布アプリ）実装計画（v0.28）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** GitHub Releases から dmg を DL するだけで動く単体デスクトップアプリ（サーバ sidecar 同梱・whisper 同梱・モデル初回DL）を出荷する

**Architecture:** compile 済みサーバ（64.7MB 実証済み）を Tauri externalBin として同梱。paths は env 二本立て（RESOURCES=読み取り専用同梱物 / DATA=Application Support）で dev/LaunchAgent 挙動は完全不変。STT 変換は sidecar では afconvert（mp4/m4a）に寄せ ffmpeg 同梱を回避（GPL 回避・録音は Tauri 内で mp4 優先）。whisper モデルは初回 DL（選択 UI・中断再開・checksum）。

**設計の正:** スパイク実証8件（台帳 2026-07-09）+ Codex 議論 r1（.superpowers/sdd/phase2-debate-r1-*.md）の裁定:
- mp4 変換は録音完了後の単一 Blob のみ（timeslice チャンク変換禁止）・blob.type 実値をログ・webm しか取れない環境では明示エラー
- attach-first は温存（2026-07-08 ユーザー承認設計・ブラウザと同一サーバ）だが **health の身元確認**（solo-eikaiwa 識別子+バージョンを health 応答に追加）と `SOLO_EIKAIWA_NO_ATTACH=1` の明示無効化を追加。配布ユーザーはデーモン不在なので実質 own-sidecar
- モデルは選択 UI: **large-v3-turbo（1.62GB・推奨・現行品質）/ small（約0.5GB・低スペック向け・品質注記）**。Range 中断再開・sha256 checksum・空き容量チェック・失敗リトライ。進捗はポーリング（SSE 不要）
- sidecar はアプリ終了で kill（常駐化・メニューバーは Phase 3）。自動更新なし（About に手動導線）
- 配布注意: 未署名(ad-hoc)・quarantine・App Translocation・更新時の再許可・マイクは Finder 起動・**Apple Silicon のみ**を明記

## Global Constraints

- サーバ新ロジック TDD・検証ゲート3種。dev/LaunchAgent の現行挙動はバイト等価（env 未設定時）
- 研究制約・PUBLIC 衛生・i18n type+EN/JA
- コード/生成物/docs のコミット分離

---

### Task 1: paths の env 二本立て + サーバ起動堅牢化

**Files:** `app/server/paths.ts`（SOLO_EIKAIWA_RESOURCES_DIR → content/dist/whisper 系, SOLO_EIKAIWA_DATA_DIR → data 系+models, 未設定時は従来の import.meta.dir 起点で完全不変）/ `app/server/index.ts`（PORT/HOSTNAME を env override 可能に・Bun.serve の EADDRINUSE を catch して明示メッセージ+exit 1・health 応答に `app:"solo-eikaiwa"` と `version`（package.json から）を additive 追加）/ Test

- [ ] TDD（env あり/なしの解決値・EADDRINUSE ハンドリング・health 身元フィールド）→ 3ゲート → Commit `feat: pathsのenv二本立てとサーバ起動堅牢化（sidecarモードの土台・dev挙動不変）`

### Task 2: STT の afconvert 経路 + Tauri 内 mp4 録音優先

**Files:** `app/server/stt.ts`（変換器選択: ffmpeg があれば従来 / 無ければ afconvert（mp4/m4a/mp3 のみ・webm は「この環境ではmp4録音が必要」の明示エラー）。blob の container 判定と実値ログ）/ クライアント録音（mimeType 交渉を「Tauri 実行時は audio/mp4 優先」に。判定方法は実装時に調査: Tauri UA 文字列 or シェルが付与するクエリ/ヘッダ。**変換は録音完了後の単一 Blob のみ**の現行動作を維持確認）/ desktop シェル（必要なら判定フラグの付与）/ Test（converter 選択・webm 拒否メッセージ）

- [ ] TDD → 3ゲート → 実機: Tauri ウィンドウで mp4 録音→afconvert→whisper の E2E（マイク許可済み前提・未許可なら PoC 手順で人間へ）→ Commit `feat: sidecar向けSTT変換のafconvert対応とTauri内mp4録音優先（ffmpeg同梱不要化）`

### Task 3: Claude SDK の外部 CLI 解決 + LLM 未導入時の説明

**Files:** `app/server/converse.ts`/`index.ts`（sidecar モード（env RESOURCES_DIR 設定時）では pathToClaudeCodeExecutable=Bun.which("claude") を SDK options に注入・見つからなければ claude ロールは既存の劣化系で「未導入」扱い）/ クライアント（health の部品別 readiness を使った初回一度だけの説明: 「Claude/Codex/ローカルLLM 未導入だと会話・添削系は動きません。例文・多聴・シャドーイング・録音の文字起こしはこのまま使えます」i18n EN/JA・情報的トーン）/ README 機能マトリクス表

- [ ] TDD（which 解決の注入・未導入時の応答）→ 3ゲート → Commit `feat: sidecarモードのclaude CLI解決とLLM未導入時の機能案内`

### Task 4: whisper モデルの初回 DL（選択・再開・検証）

**Files:** `app/server/routes/setup.ts` 新設（GET /api/setup/status = モデル有無/進捗/空き容量, POST /api/setup/whisper-model {model:"large-v3-turbo"|"small"} = DL 開始（HTTP Range 再開対応・一時ファイル→sha256 検証→原子 rename）, POST .../cancel）/ ダウンロード元は Hugging Face の ggerganov/whisper.cpp 公式（URL とチェックサムは実装時に確定しテストに固定）/ クライアント: health.modelFile=false のときのセットアップバナー+モデル選択+進捗（ポーリング）/ stt.ts のモデルパス解決を DATA_DIR/models 優先に

- [ ] TDD（fake fetch で進捗/再開/checksum不一致→available:false/容量不足）→ 3ゲート → 実機: small を実 DL して STT 1回（実キー不要）→ Commit `feat: whisperモデルの初回ダウンロード（選択UI・中断再開・checksum・容量チェック）`

### Task 5: Tauri sidecar 配線

**Files:** `desktop/src-tauri/`（externalBin にサーババイナリ・spawn 時 env 注入（RESOURCES=Resources 内・DATA=Application Support・PORT）・attach-first: health 身元確認つき（app!="solo-eikaiwa" なら不採用）→ 失敗で sidecar spawn → ポーリング → navigate。SOLO_EIKAIWA_NO_ATTACH=1 で常に own sidecar。sidecar stdout/err をログファイルへ（Application Support/logs）・アプリ終了で kill・ポート競合時の UX（別ポートで再試行））/ capabilities（sidecar 実行権限のみ・リモート origin への非公開は維持）/ ビルドスクリプト（サーバ compile → externalBin 配置 → Resources に content/dist/whisper-cli+dylibs コピー）

- [ ] cargo test + 実機: デーモン停止状態で .app 起動 → sidecar 起動 → アプリ表示 → 終了で sidecar 死亡確認。デーモン稼働状態では attach（身元確認ログ）→ Commit `feat: sidecar同梱と起動配線（attach-first身元確認つき・env注入・ログ採取・終了時kill）`

### Task 6: パッケージング・docs・リリース v0.28.0 + GitHub Release

- [ ] dmg ビルド（ad-hoc 署名・arm64）→ 実機受け入れ: dmg マウント→アプリコピー→Finder 起動→初回セットアップ→（モデル small DL）→ 例文再生+録音 STT の最小フロー（デーモン停止状態で = 純 sidecar 検証）
- [ ] README: デスクトップ節を Phase 2 内容へ全面更新（DL 手順・Gatekeeper 右クリック→開く・App Translocation 注意・arm64 のみ・機能マトリクス・LLM 導入ガイドへのリンク）+ CHANGELOG v0.28.0
- [ ] 最終 whole-branch レビュー（Fable）→ merge → tag v0.28.0 → push → デプロイ（既存デーモン系: build+kickstart）→ **GitHub Release 作成: dmg 添付 + リリースノート（CHANGELOG 転記・注意書き）** → 台帳・メモリ更新
