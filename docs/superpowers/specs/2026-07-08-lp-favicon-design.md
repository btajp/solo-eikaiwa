# LP刷新 + ファビコン統一 設計ドキュメント（フィードバック一括対応 B）

- Status: 承認済み（2026-07-08 ユーザー承認。spec レビューは省略指示・実装まで自走）
- 起点: ユーザーフィードバック — ヘッダーが画面最上部に密着 / 「完全ローカルで音声会話まで動く」強みが書かれていない / ファビコン未設定・アプリと不統一 / 全体にデザイン性がない
- 決定事項: URL は現状維持（`https://okash1n.github.io/solo-eikaiwa/`）。ファビコン案の事前選択は省略し、実装後の完了報告で代替案を提示（差し替えはファイル1枚）
- リリース: v0.22.0 に同梱。LP は `site/**` の main push で自動デプロイ（`pages.yml` 確認済み・ビルド工程なしの直配信）

> **2026-07-17 改訂注記**: 決定事項の「URL は現状維持（`https://okash1n.github.io/solo-eikaiwa/`）」は btajp org への移行（2026-07）で改訂済み。現行 URL は `https://btajp.github.io/solo-eikaiwa/`（canonical / OGP も同 URL・`site/index.html` 参照）。

## B-1. LP の修正・刷新（`site/index.html`）

### バグ修正（原因確定済み）

- ヘッダー余白: `.wrap { padding: 0 24px }`（詳細度 0,1,0）が `header { padding: 88px 0 56px }`（0,0,1）に勝ち上余白が消えている。`header.wrap { padding: 88px 24px 56px }`（0,1,1）等、**詳細度で勝つセレクタ**に変更（longhand 化だけでは負けるため不可）

### 訴求の再構成（ローカル完結を主役に）

- 現状は「フルローカル構成にすれば」が箇条書き3・5番目に埋没し、フロー図は既定のクラウド構成を先に見せている。以下に再構成:
  - ヒーロー直下に独立セクション「**マイクの音も会話も、Mac から一歩も出ない**」を新設。フルローカル構成図（whisper.cpp → Ollama → Kokoro/say）を主役として先に見せ、既定構成（Claude 併用）は「品質が欲しい用途だけワンタップでクラウドへ」という副次の書き方に反転
  - 正確性の担保: 工場既定は Claude 併用のため「完全ローカル**でも**音声会話まで完結できる」という表現を用いる（「デフォルトで完全ローカル」とは書かない）
  - 追加コストゼロ（フルローカル時）・データがマシンから出ない・API キー不要、の3点を明記

### メタ情報の整備（現状すべて欠落）

- `<link rel="icon" href="favicon.svg">` + `apple-touch-icon.png`
- OGP: `og:title` / `og:description` / `og:url`（`https://okash1n.github.io/solo-eikaiwa/`）/ `og:image`（`site/og.png` 1200×630 新規作成）+ `twitter:card=summary_large_image`
- `canonical` / `theme-color`（ライト・ダーク両方、アプリの `app/client/index.html` と同値に統一）

> **2026-07-17 改訂注記**: 上記 OGP / canonical の URL は btajp org 移行により現行では `https://btajp.github.io/solo-eikaiwa/`（冒頭の注記参照）。

### デザイン刷新（アプリと同じ世界観へ）

- 配色をアプリの実トークンへ統一: ライト accent `#1e9c5a`・ダーク accent `#4ec584`（現行 LP の `#16a34a` / `#4ade80` を置換）。小さい文字のアクセント使用箇所はコントラスト AA を満たす濃緑（ライト側 `#157a46` 系）に分離
- アプリの「静かなフォーカス系」（余白・カード・落ち着いた配色）に寄せ、タイポグラフィのメリハリ（見出しスケール・letter-spacing）とセクションリズムを再設計
- アイデンティティ要素: A-1 の草カレンダー（緑の濃淡グリッド）をヒーローの装飾モチーフとして薄く敷く（アプリの象徴との視覚的なつながり）
- 品質修正: フッターの横 padding 欠落 / `.btn` に `:focus-visible` / 装飾記号「◆」に `aria-hidden` / 英語サブタイトルに `lang="en"` / インライン style 属性5箇所をクラス化 / `prefers-reduced-motion` 配慮
- 既存の責務は維持: 単一 HTML・外部依存ゼロ（CDN/フォント読み込みなし）・ライト/ダーク両対応（`prefers-color-scheme`）
- README「はじめる」見出しへの CTA アンカー依存は維持（見出し改名しない）

## B-2. ファビコン刷新（アプリ・LP 統一）

### 採用デザイン

- コンセプト: **吹き出し × 音声波形**。「声に出して練習する」アプリの本質を1アイコンで表す
- 構成: 緑（`#1e9c5a`）の角丸スクエア + 白い吹き出し + 吹き出し内に緑の縦棒波形3〜4本（現行の「3点ドット（入力中）」を「波形（発話中）」へ意味替え）
- 16px で判別可能なこと（縦棒の太さ・間隔を 64 グリッドで整数設計）
- 代替案（完了報告で提示・差し替え自由）: (a) 大小2つの吹き出し重なり=ひとり二役 (b) 現行3点ドットの精緻化

### 展開先

| ファイル | 内容 |
| --- | --- |
| `app/client/public/favicon.svg` | 差し替え（アプリ本体） |
| `site/favicon.svg` | 同一ファイル（LP） |
| `site/apple-touch-icon.png` | 180×180 ラスタ |
| `site/og.png` | 1200×630。アイコン + アプリ名 + 一言（同系デザイン） |

- PNG 化は `bunx @resvg/resvg-js`（または同等 CLI）でローカル生成。不可の場合は Chrome ヘッドレスでのスクリーンショットにフォールバック。どちらも不可なら `og:image` タグ自体を出さない（壊れリンクを置かない）
- LP の `theme-color`・アクセント色をアイコンの緑と一致させ、アプリ（`app/client/index.html` の theme-color）とも整合させる

## 検証・リリース

- 検証: `cd app/client && bun run build`（favicon 参照の維持）+ LP はローカルでライト/ダーク・幅 375px/1280px の表示確認
- LP は main へ push で自動デプロイ（`site/**` パスフィルタ）。アプリ側 favicon は client build 反映（dist 直配信）
- CHANGELOG は v0.22.0 にパック A と合わせて記載
