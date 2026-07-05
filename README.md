# learn-english

俺専用の英会話学習システム。設計と根拠は
[docs/superpowers/specs/2026-07-05-learn-english-system-design.md](docs/superpowers/specs/2026-07-05-learn-english-system-design.md) を参照。

## 前提条件

- Bun ≥1.3
- Homebrew
- `claude` CLI（Maxサブスクでログイン済み）
- Chrome系ブラウザ推奨（録音は audio/webm 固定のため。Safari 非対応）

## セットアップ（初回のみ）

```bash
./scripts/setup.sh          # brew 依存・whisperモデルDL・bun install
# 任意: app/.env に OPENAI_API_KEY を設定（未設定なら say フォールバック）
```

## 起動

```bash
cd app && bun run dev        # APIサーバ :3111（127.0.0.1 のみ、外部非公開）
cd app/client && bun run dev # UI :5173（/api をプロキシ）
```

ブラウザで http://localhost:5173 を開き、ボタンをクリックして英語で話す。

## 使い方

ブラウザで http://localhost:5173 を開くと3つのモードを選べます:

- **今日のセッション（60分）** — 研究ベースの5ブロック構成: チャンク(8分・M3で本実装) → 4/3/2 流暢性トレーニング(16分) → 実務ロールプレイ(20分) → シャドーイング(8分) → 振り返り(5分)
- **今日のセッション（30分・短縮版）** — チャンク(6分) → 4/3/2(12分) → ロールプレイ(10分) → 振り返り(2分)
- **自由会話のみ** — M1 の会話ループ

トピックは `content/topics/*.md`、ロールプレイのシナリオは `content/scenarios/*.md` にあり、
Markdown ファイルを追加するだけでローテーションに入ります（frontmatter: id / kind / title / title_ja、本文の `- ` 行がヒント）。
選択は least-recently-used で自動ローテーションされ、`data/progress/` に使用履歴と当日メニューが記録されます。

方法論の根拠は [設計ドキュメント](docs/superpowers/specs/2026-07-05-learn-english-system-design.md) §5 を参照。

## テスト

```bash
cd app && bun test           # ユニットテスト
./scripts/smoke-stt.sh       # STT 実機スモーク
```

## データ

- `data/sessions/*.jsonl` — セッションログ（コミット対象）
- `data/recordings/` `data/tts-cache/` `models/` — gitignore
