# LP刷新 + ファビコン統一（フィードバック一括対応 B） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LP のヘッダー余白バグ・メタ情報欠落・訴求不足・デザイン不足を解消し、ファビコンを刷新してアプリと LP のブランドを統一する（spec: `docs/superpowers/specs/2026-07-08-lp-favicon-design.md`）。完了後に v0.22.0 をリリース（パックAと一括）。

**Architecture:** LP は単一 HTML + インライン CSS のまま全面書き直し（外部依存ゼロ・`site/` 直配信）。配色はアプリの `tokens.css` 実値（ライト `#1e9c5a` / ダーク `#4ec584`）に統一。ファビコンは 64 グリッドの SVG 1枚を正とし、アプリ・LP・OG 画像へ展開する。

**Tech Stack:** 素の HTML/CSS。PNG 化のみ `bunx @resvg/resvg-cli`（フォールバック: Chrome ヘッドレス → 省略）。

## Global Constraints

- LP は**単一 HTML・外部リクエストゼロ**（CDN・Webフォント・外部画像なし）を維持。`prefers-color-scheme` でライト/ダーク両対応
- 正確性: 工場既定の LLM は Claude。「完全ローカル**でも**動く」と書き、「デフォルトで完全ローカル」とは書かない
- 研究制約の文言トーン維持: ノルマ・煽り・喪失演出の表現を入れない（現行 LP の「ノルマなし」「連続日数を煽る演出は不採用」の路線を維持）
- リポジトリは PUBLIC。個人情報・私有パスを含めない
- URL は `https://okash1n.github.io/solo-eikaiwa/`（決定済み・org 移行しない）
- ブランチ: `feat/lp-favicon`。`site/**` は main への push で自動デプロイされる（`.github/workflows/pages.yml`）ため、**マージ = LP 公開**

> **2026-07-17 改訂注記**: 「URL は `https://okash1n.github.io/solo-eikaiwa/`（決定済み・org 移行しない）」は btajp org への移行（2026-07）で改訂済み。現行 URL は `https://btajp.github.io/solo-eikaiwa/`。本計画内の URL 記載（Task 3 の canonical / OGP 例・Task 4 の事後確認）も同様に読み替える（現行の正は `site/index.html`）。

---

### Task 1: 新ファビコン SVG（アプリ + LP）

**Files:**
- Modify: `app/client/public/favicon.svg`（全置換）
- Create: `site/favicon.svg`（同一内容）

**Interfaces:**
- Produces: 「吹き出し×音声波形」アイコン。Task 2（PNG/OG）・Task 3（LP の link/theme-color）が使用

- [ ] **Step 1: SVG を作成** — 両ファイルに同一内容を書く:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <!-- solo-eikaiwa: 吹き出し（会話）× 音声波形（声に出す練習）。緑はアプリの --accent (#1e9c5a) -->
  <rect width="64" height="64" rx="14" fill="#1e9c5a"/>
  <rect x="10" y="14" width="44" height="28" rx="9" fill="#ffffff"/>
  <path d="M20 42 L20 54 L33 42 Z" fill="#ffffff"/>
  <rect x="20" y="24" width="6" height="9" rx="3" fill="#1e9c5a"/>
  <rect x="29" y="19" width="6" height="18" rx="3" fill="#1e9c5a"/>
  <rect x="38" y="22" width="6" height="12" rx="3" fill="#1e9c5a"/>
</svg>
```

- [ ] **Step 2: 16px 判読性を確認** — ブラウザで `app/client/public/favicon.svg` を開き縮小表示（またはタブアイコンで確認）。波形3本が判別できること
- [ ] **Step 3: アプリへ反映** — `cd app/client && bun run build`（dist に favicon がコピーされる）
- [ ] **Step 4: Commit** — `git commit -m "feat: ファビコンを吹き出し×音声波形の新デザインに刷新（アプリ/LP共通）"`

### Task 2: PNG アセット生成（apple-touch-icon / OG 画像）

**Files:**
- Create: `site/apple-touch-icon.png`（180×180）
- Create: `site/og.svg`（OG 画像ソース・1200×630）+ `site/og.png`

- [ ] **Step 1: OG ソース SVG を作成** — `site/og.svg`（アイコン + アプリ名 + 一言。フォントはシステム依存を避け形状最小限に）:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#0f1512"/>
  <rect x="80" y="175" width="280" height="280" rx="61" fill="#1e9c5a"/>
  <rect x="124" y="236" width="192" height="123" rx="39" fill="#ffffff"/>
  <path d="M168 359 L168 411 L225 359 Z" fill="#ffffff"/>
  <rect x="168" y="280" width="26" height="39" rx="13" fill="#1e9c5a"/>
  <rect x="207" y="258" width="26" height="79" rx="13" fill="#1e9c5a"/>
  <rect x="246" y="271" width="26" height="53" rx="13" fill="#1e9c5a"/>
  <text x="420" y="315" font-family="Hiragino Sans, sans-serif" font-size="72" font-weight="700" fill="#e6efe9">solo-eikaiwa</text>
  <text x="422" y="390" font-family="Hiragino Sans, sans-serif" font-size="34" fill="#93a89b">ひとりで回す、自分専用の英会話ジム — macOS ローカル</text>
</svg>
```

- [ ] **Step 2: PNG 化** — Run:

```bash
bunx @resvg/resvg-cli --width 180 --height 180 app/client/public/favicon.svg site/apple-touch-icon.png
bunx @resvg/resvg-cli --width 1200 --height 630 site/og.svg site/og.png
```

  Expected: 2ファイル生成。**フォールバック**: resvg が使えない場合は Chrome ヘッドレス（`/Applications/Google Chrome.app/.../Google Chrome --headless --screenshot=... --window-size=1200,630 file://.../og.svg`）。それも不可なら `og.png`/`apple-touch-icon.png` を諦め、Task 3 で該当タグを**出さない**（壊れリンク禁止）
- [ ] **Step 3: 出力確認** — `Read` で PNG を開き、アイコン・文字が描画されていること（resvg はシステムフォント解決に失敗すると文字が消えるため要目視）。テキストが欠けた場合は Chrome フォールバックに切替
- [ ] **Step 4: Commit** — `git commit -m "feat: apple-touch-icon と OG 画像を追加"`

### Task 3: LP 全面改修（`site/index.html`）

**Files:**
- Modify: `site/index.html`（全面書き直し・単一ファイル完結は維持）

**Interfaces:**
- Consumes: `site/favicon.svg` / `site/apple-touch-icon.png` / `site/og.png`（Task 1–2）

- [ ] **Step 1: `<head>` のメタ整備** — 以下をすべて含める（PNG が無い場合は og:image / apple-touch-icon 行を省略）:

```html
<title>solo-eikaiwa — ひとりで回す、自分専用の英会話ジム</title>
<meta name="description" content="毎日5分から回せる、研究ベースの英会話セルフトレーニングアプリ。録音・文字起こし・AI会話・音声合成まで、すべて自分の Mac の上で。完全ローカル構成にも対応。">
<link rel="canonical" href="https://okash1n.github.io/solo-eikaiwa/">
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<link rel="apple-touch-icon" href="apple-touch-icon.png">
<meta name="theme-color" media="(prefers-color-scheme: light)" content="#f4f2ee">
<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#181716">
<meta property="og:type" content="website">
<meta property="og:title" content="solo-eikaiwa — ひとりで回す、自分専用の英会話ジム">
<meta property="og:description" content="録音・文字起こし・AI会話・音声合成まで、すべて自分の Mac の上で。完全ローカル構成にも対応する研究ベースの英会話セルフトレーニング。">
<meta property="og:url" content="https://okash1n.github.io/solo-eikaiwa/">
<meta property="og:image" content="https://okash1n.github.io/solo-eikaiwa/og.png">
<meta name="twitter:card" content="summary_large_image">
```

- [ ] **Step 2: 配色トークンをアプリと統一** — CSS 変数をアプリ `tokens.css` の実値に置換（ライト既定 + ダーク対応。theme-color と同値）:

```css
:root {
  --bg: #f4f2ee; --surface: #ffffff; --surface2: #eef5f0; --border: #e5e1da;
  --text: #1f1e1c; --muted: #6f6b64;
  --accent: #1e9c5a; --accent-deep: #157a46; /* 小さい文字は必ず --accent-deep（AA確保） */
  --accent-soft: #e4f4ea; --radius: 14px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #181716; --surface: #201f1d; --surface2: #1d3527; --border: #363330;
    --text: #edeae5; --muted: #a29d95;
    --accent: #4ec584; --accent-deep: #6fd49c; --accent-soft: #1d3527;
  }
}
```

- [ ] **Step 3: ヘッダーバグ修正 + 構成再編** — `<header class="wrap hero">` とし `.hero { padding: 96px 0 64px; }` を **`.wrap` 定義より後**に記述（詳細度同点は後勝ち。`padding: 0 24px` を上書きするため4辺指定にするか、`.wrap` の横 padding を `.hero` にも含めて `padding: 96px 24px 64px` とする）。セクション順:
  1. **ヒーロー**: バッジ（favicon と同じ吹き出しSVGをインライン表示 + 「macOS · local-first · MIT License」）→ H1「ひとりで回す、自分専用の英会話ジム。」→ 英語サブ（`<span class="en" lang="en">`）→ リード → CTA×2（現行文言維持）。背景に**草カレンダー風の緑濃淡グリッド**を装飾として薄く敷く（CSS グラデーション or 生成した div グリッド・`aria-hidden="true"`・`prefers-reduced-motion` でアニメなし）
  2. **NEW「マイクの音も会話も、Mac から一歩も出ない」**（ローカル完結の主役セクション）:

```html
<section>
  <h2>マイクの音も会話も、Mac から一歩も出ない</h2>
  <div class="flow"><b>ブラウザ録音</b> → <b>whisper.cpp</b>（ローカルSTT） → <b>Ollama などローカルLLM</b>（会話相手・コーチ） → <b>Kokoro / macOS say</b>（音声合成）</div>
  <ul class="plain">
    <li><b>完全ローカル構成なら、音声もテキストも外部に出ません。</b>STT・LLM・TTS のすべてをローカルで完結でき、API キー不要・追加コストゼロ</li>
    <li><b>音声で喋るところまで動きます。</b>マイクで話し、AI の返事を音声で聞く — その全部が自分の Mac の中</li>
    <li><b>品質が欲しい用途だけクラウドへ。</b>既定は Claude 併用。コーチングや月次レビューだけ Claude、会話はローカル、のような用途別切替が設定画面からワンタップ</li>
  </ul>
</section>
```

  3. 毎日のメニュー6カード（現行コピー維持）→ 4. データとプライバシー（現行「音声とデータは〜」の残り要素を統合: 127.0.0.1 バインド・ローカルファイル・既定構成で出るのはテキストのみ）→ 5. 研究ベース（現行維持）→ 6. はじめる（現行維持）→ 7. フッター
- [ ] **Step 4: 品質修正一式** — (a) 小さい文字のアクセントは `--accent-deep`（バッジ・h2 マーカー・フッターリンク）(b) フッターに `.wrap` を適用（横 padding 欠落修正）(c) `.btn:focus-visible { outline: 2px solid var(--accent-deep); outline-offset: 2px; }` (d) 装飾 `◆` は `aria-hidden="true"` を付与するか装飾ボーダーに置換 (e) インライン `style=` 5箇所をクラス化 (f) 見出し `text-wrap: balance`
- [ ] **Step 5: 表示確認** — ブラウザで `file://` 直開き or `python3 -m http.server` で確認: ライト/ダーク両テーマ・幅 375px / 1280px・ヘッダー上余白が空いていること・横スクロールが出ないこと（フロー図はコンテナ内スクロール）
- [ ] **Step 6: Commit** — `git commit -m "feat: LPを刷新 — ヘッダー余白修正・ローカル完結の訴求を主役化・OGP/favicon整備・アプリと配色統一"`

### Task 4: リリース v0.22.0（パックA+B 一括）

**Files:**
- Modify: `CHANGELOG.md`（v0.22.0 追記）
- Modify: `README.md`（「できること」整合の最終チェック）

- [ ] **Step 1: マージ** — `git checkout main && git merge --no-ff feat/lp-favicon -m "Merge branch 'feat/lp-favicon': LP刷新とファビコン統一"`
- [ ] **Step 2: CHANGELOG** — Keep a Changelog 形式・日本語・ユーザー視点で v0.22.0 を追記。含める項目: 練習カレンダーのXP濃淡（SRSのみの日も表示）/ 設定タブ化（モデル接続設定[LLM+Codex+音声] / 用途ごとのモデル / 表示）/ サイドバーの言語・文字サイズ切替 / プリセットのドロップダウン化と現在値表示 / 用途別推奨理由の表示 / メニュー文言改善 / LP刷新 / ファビコン刷新。（バランスプリセットの定義は v0.21.0 から変更なし — 記載不要）
- [ ] **Step 3: README 差分チェック** — 「できること」に濃淡カレンダー・設定タブ・推奨理由の記述が反映されているか確認（パックA Task 7 の更新と重複しない範囲で追記）
- [ ] **Step 4: タグ + デプロイ** — `git tag v0.22.0 && git push origin main --tags`。アプリ: `cd app/client && bun run build && launchctl kickstart -k gui/$(id -u)/com.local.solo-eikaiwa.server`。LP: push により Pages が自動デプロイ（Actions の完了を `gh run list --workflow=pages.yml -L 1` で確認）
- [ ] **Step 5: 事後確認** — `https://solo-eikaiwa/` でアプリ新機能、`https://okash1n.github.io/solo-eikaiwa/` で LP（メタタグは `curl -s | grep og:` で確認）
