# AGENTS.md — AI エージェント向け開発規約

このリポジトリで作業する AI エージェント（Claude Code / Codex 等）への標準指示。人間のコントリビュータにも有効な規約集。

## プロジェクト概要

macOS ローカルで完結する英会話練習アプリ。Bun + TypeScript サーバ（`app/server`・127.0.0.1:3111）、React + Vite クライアント（`app/client`・ビルド済み dist を Caddy が配信）、whisper.cpp ローカル STT、LLM は既定 Claude Agent SDK（`LLM_PROVIDER` で切替可）。

## 検証ゲート（変更の種類を問わず必須）

```bash
./scripts/verify.sh pr  # client build → 型 → shellcheck → 全test → 教材検証
```

デスクトップ変更は`./scripts/verify.sh desktop`も必須。リリースは`./scripts/verify.sh release`を使い、依存監査まで通す。

## ドキュメント規約（コード完了 ≠ タスク完了）

- **ユーザーに見える機能の追加・変更は、同じブランチで README の該当節（特に「できること」）を更新する。** 実装計画を書く場合は docs タスクを必ず含める。
- リリース手順: CHANGELOG 追記 → **README 差分チェック**（新機能が「できること」に載っているか・古くなった節はないか）→ バージョンタグ → デプロイ。
- CHANGELOG は Keep a Changelog 形式・日本語・ユーザー視点で書く。

## サーバ規約（`app/server`）

- ルートは機能別ドメインモジュール `routes/<domain>.ts` + `makeXRoutes(deps)`。`routes.ts` の合成配列に1行、`RouteDeps` 交差型に1項、`index.ts` で実依存を配線。
- 永続化は `ensureXSchema(db)`（`CREATE TABLE IF NOT EXISTS` のみ。マイグレーション機構は作らない）+ `makeXStore(db)`。`db.ts` の `openDb` に ensure を1行足す。
- LLM 呼び出しは `converse.ts` の `defaultRunner`（`ClaudeRunner` 型）を注入で受ける。プロンプトは各ドメインモジュールに置く。
- **サーバの新ロジックは TDD（赤→緑）**。テストは `__tests__/`、フェイクは `__tests__/helpers/route-deps.ts` の `satisfies` パターン、HTTP は `postJson`/`getReq` ヘルパで `makeFetchHandler(deps)` を直接叩く（ソケットを開かない）。
- 日付は `dates.ts` の `localYmd` 等を使う（`toISOString().slice` 禁止）。

## クライアント規約（`app/client`）

- API 呼び出しは `src/api/` にドメイン別モジュール + `api/index.ts` バレル再エクスポート。
- **i18n は named 型辞書（`src/i18n.ts`）**: 型 + `STR.en` + `STR.ja` の3点を同時に追加・変更する。文言は利用者のわかりやすさ優先で改善してよいが、**EN/JA を必ず同時に更新**し、ユーザーに見える文言変更はコミットメッセージで明示する。文字列の直書き禁止。
- データ取得は `useLoad`、解説系は `useExplain`、行の音声再生は `usePlayRow`。
- React コンポーネントの単体テスト基盤は無い（typecheck + build + 純ロジックのテストで担保）。

## プロダクト制約（研究根拠つき・binding）

- **情報的フィードバックのみ**: ノルマ・判定・警告・叱責調・喪失演出（ストリーク切れ等）を導入しない。
- **XP は決して減らない。自動降格しない**（レベル変更は提案 + ユーザー承認のみ）。
- **ユーザーデータを削除する機能を作らない**（表示制御のみ）。
- 解説・訳などの支援は明示のユーザー操作でのみ表示する。

## コンテンツ・secrets

- 教材（`content/`）は frontmatter 付き Markdown / JSON。**AI 生成コンテンツの手修正は禁止**（検証 NG なら再生成）。
- `data/` はローカル専用（gitignore 済み）。コミットしない。
- API キー等の secrets は **macOS Keychain（設定 UI 経由・`security` CLI）または `app/.env`** のみ（優先順位: Keychain > env）。`.env.local`等の派生ファイルはランタイムが読んでも運用には使わない（全階層でgitignore済み）。DB・API レスポンス・ログ・plist・argv に出さない（`/api/secrets` は write-only・値を返さない）。
- このリポジトリは PUBLIC。個人情報・私有パス・転載素材をコミットしない。

## デプロイ（LaunchAgent 常駐運用）

- クライアントのみの変更: `cd app/client && bun run build`（dist 直配信のため即反映）。
- サーバ変更あり: 上記 + `launchctl kickstart -k gui/$(id -u)/com.local.solo-eikaiwa.server`。
- `scripts/install-daemon.sh` は初回導入用（稼働中は自分のデーモンを検出して拒否する）。

## Apple・デスクトップ公開

- Apple Storeで利用者に表示される組織名・開発元・販売元は、既存iOSアプリと同じ正式表記
  `Business Technology Association Japan` に統一する。`BTAJP` はアプリ内・Web等の短縮ブランドに限り、
  `BTA-JP` など別表記を新設しない。
- Copyrightは `© <YEAR> Business Technology Association Japan` を基準とする。人物名が必要な連絡先欄では
  `Shintaro Okamura` を使用できるが、Appleがmembershipの法人名を表示する欄を人物名へ置き換えない。
- GitHub Releases版はDeveloper ID Applicationで署名し、Apple公証とstapleを完了してから公開する。
  Mac App Store版は別のStore専用設定でApp Sandboxを有効にし、self-updaterを無効化して提出する。
- GitHub Releasesのdmg生成は標準スクリプトのCI経路を使い、Finder AppleScriptへ依存させない。
  `desktop/src-tauri/target/` は生成物であり、ShellCheckやコミットの対象に含めない。
- 公開前に `CHANGELOG.md`、README、`app/package.json`、Tauri config、Cargo manifest/lockのversionを揃え、
  `./scripts/verify.sh release` を通したpush済み・cleanな`main`から標準リリーススクリプトを実行する。
- 証明書の実名、Team ID、API Key ID / Issuer ID、秘密鍵、ローカルの秘密情報パスを、コード、文書、
  Issue、PR、コミット、ログへ記録しない。必要な値はKeychainまたはリポジトリ外のrelease環境だけで扱う。
