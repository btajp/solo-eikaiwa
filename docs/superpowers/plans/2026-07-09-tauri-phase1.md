# Tauri Phase 1（薄いシェル + 録音PoC）実装計画（v0.27 候補）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** アタッチ方式のデスクトップシェル（Tauri v2）を出荷し、WKWebView での録音→STT の E2E 互換を実証する（メモリ desktop-app-backlog の Phase 1）

**Architecture:** サーバ（127.0.0.1:3111）が dist を直接配信できるようにし（Caddy 依存の解消・ブラウザ利用にも効く）、Tauri は「health を見て生きていればその URL を表示するだけ」の最薄シェルにする。sidecar・モデルDL・配布は Phase 2。録音は WKWebView の MediaRecorder（audio/mp4 系）が既存 `/api/stt`（ffmpeg がコンテナ非依存）で通るかを縦切り PoC で実証し、難があれば AudioWorklet 生PCM 案へ切替判断する。

**Tech Stack:** Tauri v2（Rust・cargo 1.96 確認済み）+ 既存 Bun サーバ + React dist（クライアントは相対 `/api` 呼び出しのため同一オリジン配信でそのまま動く）

## Global Constraints

- サーバ新ロジックは TDD・検証ゲート3種
- 既存のブラウザ/Caddy/LaunchAgent 運用と**併存**（挙動変更なし・アタッチ方式）。ポート 3111 単一所有は不変
- 配布は Phase 2（GitHub Releases・未署名 pkg/dmg）。Phase 1 はローカル `tauri build` の .app まで
- 研究制約・PUBLIC 衛生は全タスクに適用

---

### Task 1: サーバの静的配信（Caddy 依存の解消）

**Files:**
- Modify: `app/server/routes.ts` or `index.ts`（非 `/api/*` パスに `app/client/dist` を配信・SPA フォールバック=不明パスは index.html・`..` パストラバーサル拒否・mime 最低限 html/js/css/svg/png/mp3/json）
- Test: 既存の fetch handler テスト様式で（GET / → index.html、GET /assets/xxx.js → js、GET /api/health → 従来どおり、`/../` 拒否）

- [ ] TDD → 3ゲート → 手元確認: `curl http://127.0.0.1:3111/` が index.html を返す（デプロイ後）
- [ ] Commit `feat: サーバがクライアントdistを直接配信（Caddy無しでも http://127.0.0.1:3111 で完結）`

### Task 2: Tauri v2 薄シェル（アタッチ方式）

**Files:**
- Create: `desktop/`（`cargo tauri init` 相当の Tauri v2 プロジェクト。identifier: com.local.solo-eikaiwa.desktop）
- ウィンドウは起動時に `http://127.0.0.1:3111/api/health` をポーリング（数回リトライ）→ OK なら `http://127.0.0.1:3111/` をロード / NG なら同梱の案内ページ（デーモン未起動・`./scripts/install-daemon.sh` 案内・再試行ボタン。日本語+英語）
- macOS 権限: `NSMicrophoneUsageDescription`（Info.plist）+ wry/WKWebView の getUserMedia 有効化設定（Tauri v2 の macOS メディアキャプチャ許可 API を調査して適用）
- アイコン: 既存 favicon（吹き出し×音声波形）から生成
- `desktop/README.md`（dev 起動 `cargo tauri dev`・build 手順）

- [ ] `cargo tauri dev` でウィンドウが開きアプリが表示されること（デーモン稼働前提）
- [ ] `cargo tauri build` で .app が生成されること
- [ ] Commit `feat: Tauriデスクトップシェル（アタッチ方式・デーモン未起動時の案内ページ・マイク権限設定）`

### Task 3: 録音→STT 縦切り PoC（実機 E2E）

- [ ] クライアントに dev 専用の PoC 導線（例: `?poc=stt` クエリで自動実行: getUserMedia → MediaRecorder（対応 mimeType を実測列挙）→ 3秒録音 → `/api/stt` POST → 結果とサポート状況を画面表示 + `data/logs/` に記録）を追加（本番 UI 不変・クエリなしでは一切出ない）
- [ ] Tauri ウィンドウで PoC 実行。**マイクの TCC 許可ダイアログはユーザーの1クリックが必要な可能性**（自動化不可の場合はその1点だけユーザーへ報告し、他を先へ進める）
- [ ] 判定: mp4/m4a チャンクが STT を通る → PoC 合格（Phase 2 へ）。MediaRecorder 互換に難 → AudioWorklet 生PCM 案の設計メモを残して Phase 2 の課題化
- [ ] Commit `feat: 録音→STTのPoC導線（dev専用・WKWebView互換の実測）` + 結果を台帳へ

### Task 4: docs + リリース v0.27.0

- [ ] README: できること（デスクトップアプリ・Caddy 無し導線 http://127.0.0.1:3111）+ desktop 節（dev/build 手順・未署名 Gatekeeper 注意の予告）/ CHANGELOG v0.27.0
- [ ] 最終レビュー → merge → tag v0.27.0 → push → build+kickstart → health/https 200 + `curl http://127.0.0.1:3111/` 確認 → 台帳・メモリ更新 → リファクタリングへ
