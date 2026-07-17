# UI刷新（静かなフォーカス系） Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全画面を「静かなフォーカス系」デザイン（デザイントークン＋共有コンポーネント6個・依存追加ゼロ）に移行し、機能・API・イベント記録を1行も変えずに見た目だけを刷新する。

**Architecture:** `src/styles/tokens.css`（CSSカスタムプロパティ、light/dark）と `src/styles/app.css`（リセット＋コンポーネントクラス）を追加し、`src/ui/` の6コンポーネント（Button/Card/Screen/TimerChip/ChunkList/Banner）で全画面の見た目を組み立てる。各画面はロジック行を一切動かさず、JSX の見た目部分（インラインstyle・生button・生p）だけを差し替える。

**Tech Stack:** React + Vite + TypeScript（既存のまま）。CSS はバニラ（ビルド追加なし）。外部フォント/CDN不使用。

## Global Constraints

- スペック: `docs/superpowers/specs/2026-07-06-ui-refresh-design.md` が正（配色・コンポーネント責務・画面別方針・不変条件）
- **機能・HTTP API・セッションイベント記録は完全不変**。各タスクの「変えてはいけない行」リストに列挙された式・関数・呼び出しは文字どおり温存する（JSXの入れ物だけ変える）
- ゲーミフィケーション制約継続: カレンダー・進捗はドット等の情報表示のみ。演出・連続日数・比較要素を追加しない
- 依存追加ゼロ。`package.json` に触らない
- コンポーネント内の `style={{...}}` は原則禁止。例外は動的な値のみ（現状の設計では例外ゼロで実装できる）
- 色・サイズのリテラルは tokens.css / app.css にのみ書く。TSX内の色リテラル（`crimson` `#666` 等）はTask 3完了時点でゼロ
- ゲート: `cd app/client && bun run build`（tsc＋vite）。サーバは無変更（`cd app && bun test` が 125 のまま）
- コミットは Conventional Commits（日本語）

## File Structure

```
app/client/src/
  styles/
    tokens.css      # カスタムプロパティ（light/dark）のみ
    app.css         # リセット + コンポーネントクラス（.btn .card .screen-header .timer-chip .chunk-list .banner .chat 等）
  ui/
    Button.tsx      # variant/size/loading
    Card.tsx
    Screen.tsx      # 画面ヘッダ（タイトル + meta スロット）+ ProgressDots
    TimerChip.tsx
    ChunkList.tsx
    Banner.tsx
  main.tsx          # CSS import 追加
  App.tsx           # シェル/ヘッダ/健全性 Banner（Task 2）
  screens/*.tsx     # Task 2-3 で見た目のみ移行
```

---

### Task 1: デザイントークンと共有UIコンポーネント

**Files:**
- Create: `app/client/src/styles/tokens.css`
- Create: `app/client/src/styles/app.css`
- Create: `app/client/src/ui/Button.tsx`, `app/client/src/ui/Card.tsx`, `app/client/src/ui/Screen.tsx`, `app/client/src/ui/TimerChip.tsx`, `app/client/src/ui/ChunkList.tsx`, `app/client/src/ui/Banner.tsx`
- Modify: `app/client/src/main.tsx`（import 2行追加のみ）

**Interfaces:**
- Consumes: `formatMmSs`（`../useCountdown`、TimerChip が使用）
- Produces（Task 2/3 が依存 — シグネチャ厳守）:
  - `Button`: `{ variant?: "primary"|"secondary"|"ghost"|"danger"; size?: "md"|"lg"; loading?: boolean; disabled?: boolean; onClick?: () => void; children: ReactNode; ariaLabel?: string; title?: string }`
  - `Card`: `{ header?: ReactNode; children: ReactNode; className?: string }`
  - `Screen`: `{ title?: ReactNode; meta?: ReactNode; children: ReactNode }` / `ProgressDots`: `{ current: number; total: number }`（Screen.tsx から named export）
  - `TimerChip`: `{ remaining: number; expired: boolean; warnAt?: number; note?: string }`
  - `ChunkList`: `{ chunks: Array<{ en: string; ja?: string }>; playingIdx: number | null; onPlay?: (i: number, en: string) => void }`
  - `Banner`: `{ kind: "info"|"warn"|"error"; children: ReactNode; action?: ReactNode }`
- この時点で既存画面は未変更（新CSSはトークンとクラス定義のみなので既存表示は概ね素のまま。完全な見た目は Task 2/3 で切替わる）

- [ ] **Step 1: tokens.css を作成**

`app/client/src/styles/tokens.css`:

```css
/* デザイントークン — 静かなフォーカス系。値の変更はこのファイルでのみ行う */
:root {
  /* 配色: ウォームグレー3層 + テキスト2階調 + アクセント1色 + 情報色（彩度控えめ） */
  --bg: #faf9f7;
  --surface: #ffffff;
  --border: #e7e4df;
  --text: #1f1e1c;
  --text-muted: #6f6b64;
  --accent: #5558c8;
  --accent-soft: #ecedfa;
  --on-accent: #ffffff;
  --ok: #33683f;
  --ok-soft: #e7f2ea;
  --warn: #8a5d14;
  --warn-soft: #f7edd8;
  --danger: #a03d33;
  --danger-soft: #f7e5e2;

  /* タイポグラフィ（システムフォントのみ） */
  --font-sans: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif;
  --fs-sm: 13px;
  --fs-md: 15px;
  --fs-lg: 17px;   /* 英文チャンク・音読素材はこれ以上 */
  --fs-xl: 22px;
  --lh-reading: 1.7;

  /* スケール */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 24px; --sp-6: 32px; --sp-7: 48px;
  --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px;
  --shadow-1: 0 1px 2px rgba(28, 25, 20, 0.05), 0 1px 1px rgba(28, 25, 20, 0.03);
  --shadow-2: 0 4px 12px rgba(28, 25, 20, 0.07), 0 1px 3px rgba(28, 25, 20, 0.05);
  --ease: 150ms ease-out;
}

@media (prefers-color-scheme: dark) {
  :root {
    --bg: #181716;
    --surface: #201f1d;
    --border: #363330;
    --text: #edeae5;
    --text-muted: #a29d95;
    --accent: #8f93ee;
    --accent-soft: #2b2c49;
    --on-accent: #14142a;
    --ok: #86c295;
    --ok-soft: #22331f;
    --warn: #d9ab61;
    --warn-soft: #3a301b;
    --danger: #e08d81;
    --danger-soft: #3f2623;
    --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-2: 0 4px 12px rgba(0, 0, 0, 0.5);
  }
}
```

- [ ] **Step 2: app.css を作成**

`app/client/src/styles/app.css`:

```css
/* リセットとコンポーネントクラス。色・寸法は tokens.css の変数のみ参照する */
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: var(--fs-md);
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { font-weight: 650; margin: 0 0 var(--sp-3); }
p { margin: 0 0 var(--sp-3); }
ul, ol { margin: 0 0 var(--sp-3); padding-left: var(--sp-5); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--radius-sm); }

/* アプリシェル */
.app { max-width: 680px; margin: 0 auto; padding: var(--sp-5) var(--sp-4) var(--sp-7); }
.app-header { display: flex; align-items: center; gap: var(--sp-3); margin-bottom: var(--sp-5); }
.app-brand { font-size: var(--fs-lg); font-weight: 700; letter-spacing: -0.01em; }
.app-header-spacer { flex: 1; }

/* テキストユーティリティ */
.text-muted { color: var(--text-muted); }
.text-sm { font-size: var(--fs-sm); }
.reading-text { font-size: var(--fs-lg); line-height: var(--lh-reading); white-space: pre-wrap; }
.stack > * + * { margin-top: var(--sp-4); }

/* Button */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-2);
  font: inherit; font-size: var(--fs-md); font-weight: 550;
  padding: var(--sp-2) var(--sp-4); border-radius: var(--radius-sm);
  border: 1px solid transparent; cursor: pointer;
  transition: background var(--ease), border-color var(--ease), color var(--ease), box-shadow var(--ease);
}
.btn:disabled { opacity: 0.55; cursor: default; }
.btn-lg { font-size: var(--fs-lg); padding: var(--sp-3) var(--sp-5); border-radius: var(--radius-md); }
.btn-primary { background: var(--accent); color: var(--on-accent); box-shadow: var(--shadow-1); }
.btn-primary:not(:disabled):hover { filter: brightness(1.06); }
.btn-secondary { background: var(--surface); color: var(--text); border-color: var(--border); box-shadow: var(--shadow-1); }
.btn-secondary:not(:disabled):hover { border-color: var(--text-muted); }
.btn-ghost { background: transparent; color: var(--text-muted); }
.btn-ghost:not(:disabled):hover { color: var(--text); background: var(--surface); }
.btn-danger { background: var(--danger-soft); color: var(--danger); }
.spinner {
  width: 1em; height: 1em; border-radius: 50%;
  border: 2px solid currentColor; border-top-color: transparent;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Card */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--sp-4); box-shadow: var(--shadow-1); }
.card + .card { margin-top: var(--sp-4); }
.card-header { font-size: var(--fs-md); font-weight: 650; margin-bottom: var(--sp-3); }

/* Screen（画面ヘッダ） */
.screen-header { display: flex; align-items: baseline; gap: var(--sp-3); margin-bottom: var(--sp-4); }
.screen-title { font-size: var(--fs-xl); letter-spacing: -0.01em; margin: 0; }
.screen-meta { margin-left: auto; display: flex; align-items: center; gap: var(--sp-3); }
.progress-dots { display: inline-flex; gap: var(--sp-1); }
.progress-dots .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--border); }
.progress-dots .dot.is-done { background: var(--text-muted); }
.progress-dots .dot.is-active { background: var(--accent); }

/* TimerChip */
.timer-chip {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  font-variant-numeric: tabular-nums; font-size: var(--fs-sm); font-weight: 600;
  padding: 2px var(--sp-2); border-radius: 999px;
  background: var(--surface); border: 1px solid var(--border); color: var(--text-muted);
}
.timer-chip.is-warn { color: var(--warn); border-color: var(--warn); }
.timer-chip.is-expired { color: var(--text-muted); background: var(--bg); }

/* Banner */
.banner { display: flex; align-items: baseline; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border-radius: var(--radius-sm); margin-bottom: var(--sp-3); font-size: var(--fs-md); }
.banner-info { background: var(--accent-soft); color: var(--text); }
.banner-warn { background: var(--warn-soft); color: var(--warn); }
.banner-error { background: var(--danger-soft); color: var(--danger); }

/* ChunkList（音読素材 — 英文は大きく行間広く） */
.chunk-list { list-style: none; padding: 0; margin: 0 0 var(--sp-3); }
.chunk-list li { display: grid; grid-template-columns: auto 1fr; gap: var(--sp-2) var(--sp-3); padding: var(--sp-2) 0; align-items: start; }
.chunk-list li + li { border-top: 1px solid var(--border); }
.chunk-en { font-size: var(--fs-lg); line-height: var(--lh-reading); font-weight: 600; }
.chunk-ja { grid-column: 2; color: var(--text-muted); font-size: var(--fs-sm); }
.chunk-list.no-audio li { grid-template-columns: 1fr; }
.chunk-list.no-audio .chunk-ja { grid-column: 1; }

/* スタート画面 */
.drill-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); margin-bottom: var(--sp-5); }
.drill-card {
  display: flex; flex-direction: column; align-items: flex-start; gap: var(--sp-1);
  background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: var(--sp-4); cursor: pointer; font: inherit; text-align: left;
  box-shadow: var(--shadow-1); transition: border-color var(--ease), box-shadow var(--ease);
}
.drill-card:hover { border-color: var(--accent); box-shadow: var(--shadow-2); }
.drill-title { font-size: var(--fs-md); font-weight: 650; }
.drill-min { font-size: var(--fs-sm); color: var(--text-muted); }
.start-row { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.dot-grid { display: grid; grid-template-columns: repeat(7, 16px); gap: 3px; }
.dot-grid .day { width: 14px; height: 14px; border-radius: 4px; background: var(--border); }
.dot-grid .day.is-done { background: var(--ok); }
.dot-grid .day.is-today { outline: 2px solid var(--text-muted); outline-offset: 1px; }
.anchor-row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; color: var(--text-muted); }
.anchor-input { font: inherit; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); flex: 1; min-width: 200px; }

/* 会話（チャットバブル） */
.chat { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-4); }
.chat-row { display: flex; }
.chat-row.you { justify-content: flex-end; }
.bubble { max-width: 85%; padding: var(--sp-2) var(--sp-3); border-radius: var(--radius-md); white-space: pre-wrap; line-height: 1.55; }
.bubble-you { background: var(--accent-soft); border-bottom-right-radius: var(--radius-sm); }
.bubble-ai { background: var(--surface); border: 1px solid var(--border); border-bottom-left-radius: var(--radius-sm); }

/* 4/3/2 ラウンド */
.round-stage { text-align: center; padding: var(--sp-5) 0; }
.round-timer { font-size: 48px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: 0.02em; margin: var(--sp-3) 0; }
.round-timer.is-expired { color: var(--danger); }
.round-actions { display: flex; justify-content: center; gap: var(--sp-3); margin-top: var(--sp-3); }
.record-btn.is-recording { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--accent-soft); }
  50% { box-shadow: 0 0 0 10px transparent; }
}

/* AEフィードバック */
.ae-item { padding: var(--sp-3) 0; }
.ae-item + .ae-item { border-top: 1px solid var(--border); }
.ae-why { color: var(--text-muted); font-size: var(--fs-sm); margin-top: var(--sp-1); }

/* フェード（ブロック切替） */
.fade-in { animation: fadein var(--ease); }
@keyframes fadein { from { opacity: 0; } to { opacity: 1; } }

/* motion配慮 */
@media (prefers-reduced-motion: reduce) {
  .fade-in, .record-btn.is-recording, .spinner { animation: none; }
  .btn, .drill-card, .timer-chip { transition: none; }
}
```

- [ ] **Step 3: main.tsx に CSS を取り込む**

`app/client/src/main.tsx` の import 群に以下の2行を追加（他は不変）:

```tsx
import "./styles/tokens.css";
import "./styles/app.css";
```

- [ ] **Step 4: Button.tsx を作成**

`app/client/src/ui/Button.tsx`:

```tsx
import type { ReactNode } from "react";

type Props = {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "md" | "lg";
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  ariaLabel?: string;
  title?: string;
};

/** 共有ボタン。loading 中はスピナーを出して自動 disabled */
export function Button({ variant = "secondary", size = "md", loading, disabled, onClick, children, ariaLabel, title }: Props) {
  return (
    <button
      className={`btn btn-${variant}${size === "lg" ? " btn-lg" : ""}`}
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={ariaLabel}
      title={title}
    >
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}
```

- [ ] **Step 5: Card.tsx / Banner.tsx を作成**

`app/client/src/ui/Card.tsx`:

```tsx
import type { ReactNode } from "react";

export function Card({ header, children, className }: { header?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card${className ? ` ${className}` : ""}`}>
      {header && <div className="card-header">{header}</div>}
      {children}
    </section>
  );
}
```

`app/client/src/ui/Banner.tsx`:

```tsx
import type { ReactNode } from "react";

/** 情報/警告/エラーの通知帯。crimson テキストの後継 */
export function Banner({ kind, children, action }: { kind: "info" | "warn" | "error"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {action}
    </div>
  );
}
```

- [ ] **Step 6: Screen.tsx（ProgressDots 同居）を作成**

`app/client/src/ui/Screen.tsx`:

```tsx
import type { ReactNode } from "react";

/** ブロック進捗ドット（情報表示のみ） */
export function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <span className="progress-dots" aria-label={`ブロック ${current + 1}/${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`dot${i < current ? " is-done" : i === current ? " is-active" : ""}`} />
      ))}
    </span>
  );
}

/** 画面シェル: タイトル行 + 右側 meta スロット（進捗ドット・タイマーチップ等） */
export function Screen({ title, meta, children }: { title?: ReactNode; meta?: ReactNode; children: ReactNode }) {
  return (
    <div>
      {(title || meta) && (
        <div className="screen-header">
          {title && <h2 className="screen-title">{title}</h2>}
          {meta && <span className="screen-meta">{meta}</span>}
        </div>
      )}
      {children}
    </div>
  );
}
```

- [ ] **Step 7: TimerChip.tsx を作成**

`app/client/src/ui/TimerChip.tsx`:

```tsx
import { formatMmSs } from "../useCountdown";

/** 等幅数字のカウントダウンチップ。残りわずかで色が変わる（情報として） */
export function TimerChip({ remaining, expired, warnAt = 30, note }: { remaining: number; expired: boolean; warnAt?: number; note?: string }) {
  const cls = expired ? " is-expired" : remaining <= warnAt ? " is-warn" : "";
  return (
    <span className={`timer-chip${cls}`}>
      ⏱ {formatMmSs(remaining)}
      {expired && note && <span> — {note}</span>}
    </span>
  );
}
```

- [ ] **Step 8: ChunkList.tsx を作成**

`app/client/src/ui/ChunkList.tsx`:

```tsx
import { Button } from "./Button";

type Chunk = { en: string; ja?: string };

/** 英文太字＋日本語gloss＋🔊スロット。onPlay 省略時は再生ボタンなし */
export function ChunkList({ chunks, playingIdx, onPlay }: { chunks: Chunk[]; playingIdx: number | null; onPlay?: (i: number, en: string) => void }) {
  return (
    <ul className={`chunk-list${onPlay ? "" : " no-audio"}`}>
      {chunks.map((c, i) => (
        <li key={i}>
          {onPlay && (
            <Button variant="ghost" onClick={() => onPlay(i, c.en)} disabled={playingIdx !== null} ariaLabel={`「${c.en}」を再生`}>
              {playingIdx === i ? "…" : "🔊"}
            </Button>
          )}
          <span className="chunk-en">{c.en}</span>
          {c.ja && <span className="chunk-ja">{c.ja}</span>}
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 9: ビルド確認**

Run: `cd app/client && bun run build`
Expected: PASS（新規ファイルは未参照でも tsc の対象。エラーゼロ）

- [ ] **Step 10: コミット**

```bash
git add app/client/src/styles app/client/src/ui app/client/src/main.tsx
git commit -m "feat: デザイントークンと共有UIコンポーネントを追加"
```

---

### Task 2: スタート・進行・ライブラリ系画面の移行

**Files:**
- Modify: `app/client/src/App.tsx`, `app/client/src/screens/StartScreen.tsx`, `app/client/src/screens/SessionRunner.tsx`, `app/client/src/screens/LibraryScreen.tsx`, `app/client/src/screens/ChunkPlaceholderScreen.tsx`, `app/client/src/screens/ReflectionScreen.tsx`

**Interfaces:**
- Consumes: Task 1 の全コンポーネント
- Produces: 変更なし（各画面の props・export は不変）

**このタスク全体の方針:** 各ファイルは下記の完成形へ「見た目部分だけ」置き換える。ロジック（hooks、ref、fetch、イベント送信、分岐条件）は元コードから文字どおりコピーすること。以下の「変えてはいけない行」を実装後に必ず目視照合する。

- [ ] **Step 1: App.tsx を移行**

変えてはいけない行（元コードから逐語コピー）:
- `const [sessionId] = useState(() => crypto.randomUUID());` と `startedRef` ガード一式
- `useEffect` 本体（getHealth / sessionStart / pagehide / cleanup の sessionEnd）
- `onSelect` の分岐4行、`Mode` 型、各 mode の画面レンダリング分岐

完成形 `app/client/src/App.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { getHealth, sessionEnd, sessionEndKeepalive, sessionStart, type Health } from "./api";
import { FreeTalkScreen } from "./screens/FreeTalkScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { SessionRunner, type MenuSource } from "./screens/SessionRunner";
import { StartScreen, type StartSelection } from "./screens/StartScreen";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";

type Mode = { kind: "start" } | { kind: "free" } | { kind: "session"; source: MenuSource } | { kind: "library" };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "start" });
  // このタブのセッションを識別するUUID。ライフサイクル/ブロック/ラウンドイベントは
  // モードに関わらずすべてこのIDで記録する（converse() が返す会話用sessionIdとは別概念。そちらは変更しない）
  const [sessionId] = useState(() => crypto.randomUUID());
  // StrictMode の開発時二重マウントで session_start が重複記録されないようにする冪等ガード
  const startedRef = useRef(false);

  useEffect(() => {
    getHealth()
      .then((h) => { setHealth(h); setServerDown(false); })
      .catch(() => { setHealth(null); setServerDown(true); });
    if (!startedRef.current) {
      startedRef.current = true;
      sessionStart(sessionId);
    }
    const onPageHide = () => sessionEndKeepalive(sessionId);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      sessionEnd(sessionId);
    };
  }, [sessionId]);

  function onSelect(sel: StartSelection) {
    if (sel.type === "free") setMode({ kind: "free" });
    else if (sel.type === "library") setMode({ kind: "library" });
    else if (sel.type === "daily") setMode({ kind: "session", source: { type: "daily", minutes: sel.minutes } });
    else setMode({ kind: "session", source: { type: "quick", drill: sel.drill } });
  }

  return (
    <main className="app">
      <div className="app-header">
        <span className="app-brand">learn-english</span>
        <span className="app-header-spacer" />
        {mode.kind !== "start" && (
          <Button variant="ghost" onClick={() => setMode({ kind: "start" })}>← メニューに戻る</Button>
        )}
      </div>
      {serverDown && (
        <Banner kind="error">APIサーバに接続できません — `cd app && bun run dev` で起動してください</Banner>
      )}
      {!serverDown && health && !health.ok && (
        <Banner kind="error">依存が不足しています: {JSON.stringify(health)} — `scripts/setup.sh` を実行してください</Banner>
      )}
      {!serverDown && health && health.ok && !health.ttsKey && (
        <Banner kind="warn">OPENAI_API_KEY 未設定のため TTS は say フォールバックです</Banner>
      )}
      {mode.kind === "start" && <StartScreen onSelect={onSelect} />}
      {mode.kind === "session" && (
        <SessionRunner source={mode.source} sessionId={sessionId} onExit={() => setMode({ kind: "start" })} />
      )}
      {mode.kind === "free" && <FreeTalkScreen />}
      {mode.kind === "library" && <LibraryScreen />}
    </main>
  );
}
```

- [ ] **Step 2: StartScreen.tsx を移行**

変えてはいけない行:
- `localYmd`、`PracticeCalendar` のセル計算ループ（55→0、`set.has(ymd)`、`isToday`）
- `aliveRef`/`fetchedRef` の効果本体、`fetchPracticeDays`/`fetchSettings` の失敗黙殺
- `onSaveAnchor` 全体、`maxLength={200}`、`StartSelection` 型と `QUICK_BUTTONS` の drill 値

完成形（見た目差分の要点: クイックドリルを `.drill-grid` の `.drill-card` ×4、強化セッション/自由会話/ライブラリを `.start-row` の `Button`、カレンダーを 7列 `.dot-grid`、アンカーを `.anchor-row` に）:

```tsx
import { useEffect, useRef, useState } from "react";
import { fetchPracticeDays, fetchSettings, saveSettings, type QuickDrillKind } from "../api";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";

export type StartSelection =
  | { type: "quick"; drill: QuickDrillKind }
  | { type: "daily"; minutes: 60 | 30 }
  | { type: "free" }
  | { type: "library" };

const QUICK_BUTTONS: Array<{ drill: QuickDrillKind; title: string; minutes: string }> = [
  { drill: "warmup", title: "🔊 音読ウォームアップ", minutes: "6分" },
  { drill: "ftt-mini", title: "🗣 4/3/2ミニ", minutes: "8分・2ラウンド" },
  { drill: "roleplay", title: "💼 実務ロールプレイ", minutes: "10分" },
  { drill: "shadowing", title: "🎧 シャドーイング", minutes: "5分" },
];

/** ローカル日付の YYYY-MM-DD（カレンダー表示用） */
function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 直近8週（56日）の練習日カレンダー。実施日のドット表示のみ（情報的フィードバック — 演出・連続日数なし） */
function PracticeCalendar({ days }: { days: string[] }) {
  const set = new Set(days);
  const today = new Date();
  const cells: Array<{ ymd: string; done: boolean; isToday: boolean }> = [];
  for (let i = 55; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const ymd = localYmd(d);
    cells.push({ ymd, done: set.has(ymd), isToday: i === 0 });
  }
  return (
    <div>
      <h3 className="text-sm text-muted">練習日（直近8週）</h3>
      <div className="dot-grid">
        {cells.map((c) => (
          <div key={c.ymd} title={c.ymd} className={`day${c.done ? " is-done" : ""}${c.isToday ? " is-today" : ""}`} />
        ))}
      </div>
    </div>
  );
}

export function StartScreen(props: { onSelect: (sel: StartSelection) => void }) {
  const [days, setDays] = useState<string[]>([]);
  const [anchor, setAnchor] = useState("");
  const [anchorDraft, setAnchorDraft] = useState("");
  const [editingAnchor, setEditingAnchor] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      // カレンダー/アンカーは補助情報 — 取得失敗でスタート画面を壊さない
      fetchPracticeDays().then((d) => { if (aliveRef.current) setDays(d); }).catch(() => {});
      fetchSettings().then((s) => {
        if (aliveRef.current) { setAnchor(s.anchor); setAnchorDraft(s.anchor); }
      }).catch(() => {});
    }
    return () => { aliveRef.current = false; };
  }, []);

  async function onSaveAnchor() {
    setSaveMsg("");
    try {
      await saveSettings({ anchor: anchorDraft });
      if (!aliveRef.current) return;
      setAnchor(anchorDraft);
      setEditingAnchor(false);
    } catch (err) {
      if (!aliveRef.current) return;
      setSaveMsg(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="stack">
      <div>
        <h3>クイックドリル（5〜10分）</h3>
        <div className="drill-grid">
          {QUICK_BUTTONS.map((q) => (
            <button key={q.drill} className="drill-card" onClick={() => props.onSelect({ type: "quick", drill: q.drill })}>
              <span className="drill-title">{q.title}</span>
              <span className="drill-min">{q.minutes}</span>
            </button>
          ))}
        </div>
        <h3>強化セッション <span className="text-sm text-muted">週1〜2回おすすめ</span></h3>
        <div className="start-row">
          <Button onClick={() => props.onSelect({ type: "daily", minutes: 60 })}>📋 通しセッション（60分）</Button>
          <Button onClick={() => props.onSelect({ type: "daily", minutes: 30 })}>📋 30分・短縮版</Button>
        </div>
        <div className="start-row">
          <Button variant="ghost" onClick={() => props.onSelect({ type: "free" })}>💬 自由会話のみ</Button>
          <Button variant="ghost" onClick={() => props.onSelect({ type: "library" })}>📚 ライブラリ</Button>
        </div>
      </div>

      <PracticeCalendar days={days} />

      <div>
        {!editingAnchor && anchor && (
          <p className="anchor-row">
            📌 {anchor}
            <Button variant="ghost" onClick={() => setEditingAnchor(true)}>編集</Button>
          </p>
        )}
        {!editingAnchor && !anchor && (
          <p className="anchor-row">
            続けるコツ: 既にある日課に紐づけると忘れません（例: 朝コーヒーを淹れたら1ドリル）
            <Button variant="ghost" onClick={() => setEditingAnchor(true)}>設定する</Button>
          </p>
        )}
        {editingAnchor && (
          <div className="anchor-row">
            <input
              className="anchor-input"
              value={anchorDraft}
              onChange={(e) => setAnchorDraft(e.target.value)}
              placeholder="朝コーヒーを淹れたら1ドリル"
              maxLength={200}
            />
            <Button variant="primary" onClick={onSaveAnchor}>保存</Button>
            <Button variant="ghost" onClick={() => { setEditingAnchor(false); setAnchorDraft(anchor); setSaveMsg(""); }}>やめる</Button>
          </div>
        )}
        {saveMsg && <Banner kind="error">{saveMsg}</Banner>}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: SessionRunner.tsx を移行**

変えてはいけない行:
- `loadMenu` 本体（fetch分岐・`timer.reset/start`・`openBlockRef` 設定・`sendSessionEvent("block_start", ...)`）
- `initedRef` ガード effect、アンマウント時 aborted `block_end` effect（両方逐語）
- `nextBlock` 本体、`isLast` 判定、`BlockBody` の switch 全体（props含め不変）

見た目差分: エラー表示→`Banner`＋`Button`、ヘッダ→`Screen` に `title={block.title}`・`meta={<ProgressDots/>+<TimerChip/>}`、ブロック本文を `<div key={block.id} className="fade-in">` で包む、フッターボタンを `Button variant="primary" size="lg"`。

完成形（ロジック部は元コードと同一。JSX 返却部のみ提示 — 実装時は元ファイルの return より上を無変更で残し、以下で return 部分と import を差し替える）:

```tsx
// import に追加:
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { ProgressDots, Screen } from "../ui/Screen";
import { TimerChip } from "../ui/TimerChip";
// formatMmSs の import は不要になる（TimerChip 内で使用）。useCountdown は引き続き使用

  if (errorMsg) {
    return (
      <div>
        <Banner kind="error" action={<Button onClick={loadMenu}>再試行</Button>}>{errorMsg}</Banner>
      </div>
    );
  }
  if (!menu) return <p className="text-muted">今日のメニューを組んでいます…</p>;

  const block = menu.blocks[index];
  const isLast = index === menu.blocks.length - 1;

  function nextBlock() { /* 元コードと同一（逐語コピー） */ }

  return (
    <Screen
      title={block.title}
      meta={
        <>
          <ProgressDots current={index} total={menu.blocks.length} />
          <TimerChip remaining={timer.remaining} expired={timer.expired} note="キリのいいところで次へ" />
        </>
      }
    >
      <div key={block.id} className="fade-in">
        <BlockBody block={block} sessionId={props.sessionId} />
      </div>
      <div className="round-actions">
        <Button variant="primary" size="lg" onClick={nextBlock}>
          {isLast ? "✅ セッションを終える" : "次のブロックへ →"}
        </Button>
      </div>
    </Screen>
  );
```

（`nextBlock` の中身は元ファイルの同名関数を1文字も変えずに残す。`<hr>` は廃止し、`.round-actions` の余白で区切る）

- [ ] **Step 4: LibraryScreen.tsx / ChunkPlaceholderScreen.tsx / ReflectionScreen.tsx を移行**

変えてはいけない行: 各画面の state/fetch/alive/retry ロジック全て。`playTtsCached(entry.text)`、`playingId` の disabled 条件、Reflection の `loadReflection`。

- LibraryScreen: 各エントリを `Card` に（header = ▶ `Button variant="ghost"`＋`topicTitle`＋日付 `.text-sm .text-muted`、本文は `details`＋`.reading-text`）。エラーは `Banner`＋再試行 `Button`。空状態は `.text-muted`
- ChunkPlaceholderScreen: `Card` に包み、本文 `.text-muted`
- ReflectionScreen: 「👏 良かった表現」「✏️ 直したい表現」「📝 明日へ」を3つの `Card`（header付き）に。エラーは `Banner`＋`Button`

- [ ] **Step 5: ビルドと部分grep検証**

Run: `cd app/client && bun run build`
Expected: PASS

Run: `grep -rnE "crimson|darkorange" src/App.tsx src/screens/StartScreen.tsx src/screens/SessionRunner.tsx src/screens/LibraryScreen.tsx src/screens/ChunkPlaceholderScreen.tsx src/screens/ReflectionScreen.tsx`
Expected: 0件

- [ ] **Step 6: コミット**

```bash
git add app/client/src
git commit -m "feat: スタート・セッション進行・ライブラリ系画面を新デザインに移行"
```

---

### Task 3: 練習画面の移行と横断確認

**Files:**
- Modify: `app/client/src/screens/WarmupReadingScreen.tsx`, `app/client/src/screens/FourThreeTwoScreen.tsx`, `app/client/src/screens/FreeTalkScreen.tsx`, `app/client/src/screens/RoleplayScreen.tsx`, `app/client/src/screens/ShadowingScreen.tsx`

**Interfaces:**
- Consumes: Task 1 の全コンポーネント
- Produces: 変更なし（props・export 不変）

- [ ] **Step 1: WarmupReadingScreen.tsx を移行**

変えてはいけない行: `load`/`playChunk` 本体、`aliveRef`/`fetchedRef` effect（`stopPlayback()` cleanup 含む）、`chunks` のフィルタ式、フォールバック時のヒント表示分岐。

見た目差分: 導入文 `.text-muted`、チャンクは `ChunkList`（`onPlay={playChunk}` `playingIdx={playingIdx}`）、フォールバックのヒントは `ChunkList` に `{en: h}` を map（onPlay なし）、骨組みは `Card header="今日の話の骨組み"` 内の `ol`、エラーは `Banner`＋再試行 `Button`、`playErr` も `Banner kind="error"`。

- [ ] **Step 2: FourThreeTwoScreen.tsx を移行（このタスクの最重要ファイル）**

変えてはいけない行（実装後に1行ずつ照合すること）:
- `DEFAULT_ROUNDS_SEC` / `PREP_SECONDS` / `LISTENERS` / `minLabel` / 型定義群
- `roundsSec` フォールバック式（`length >= 2 && every(s => s > 0)`）
- 全 state/ref 宣言と `roundIndexRef`/`remainingRef` の同期 effect
- マウント effect 全体（`prepFetchedRef` ガード、`loadPrep()`、`prepTimer.start()`、`prefetchModelTalkAudio(...)` の then/catch、クリーンアップの `recorderRef.current.cancel()`・`stopPlayback()`・aborted `round_end` 送信の meta 5項目）
- `loadPrep` / `playModelTalk` / `playChunk` / `toggleRecording` / `finishRound` / `startRound` の関数本体すべて（`stopPlayback()` の位置、`roundStartedRef` の遷移、`sendSessionEvent` の meta、AE スキップ分岐、`disabled` 条件を含む）

見た目差分（JSX のみ）:
- **prep**: `Card header={準備 — {props.topic.title}}` に titleJa `.text-muted`・説明文・`TimerChip`（prepTimer、note="そろそろ始めましょう"）。ヒント `ul` は `.text-muted`。チャンクは `ChunkList onPlay={playChunk} playingIdx={playingIdx}`（フィルタ式は既存のまま適用してから渡す）。骨組みは `Card header="話の骨組み"`。モデルトーク行は `Button`（disabled/ラベル分岐は既存のまま）＋ `Button variant="primary"` で Round 1 開始。`modelText` の `details` は `.reading-text`。エラーは `Banner`
- **round**: `.round-stage` — リスナー行 `.text-muted`、ヒント `ul` を `.text-sm .text-muted` で控えめに、`.round-timer`（`is-expired` で赤、`formatMmSs(timer.remaining)`、`timer.expired && "— 時間切れ！"` は `.text-sm`）、`.round-actions` に録音 `Button variant="primary" size="lg"`（`recording` 中は外側 `<span className="record-btn is-recording">` で包むのではなく、Button に `className` を渡せないため `.round-actions` 内の `<button className="btn btn-primary btn-lg record-btn is-recording">` を直接書いてよい — このボタンのみ例外として生 button 可、ラベル・onClick・disabled は既存のまま）＋「このラウンドを終える →」`Button`。トランスクリプトは `Card` に `.reading-text`
- **ae**: `Card header="フィードバック（読んだら Round 2 へ）"` — praise は `Banner kind="info"`、各 item は `.ae-item`（`<s>{quote}</s> → <strong>{better}</strong> <em>({issue})</em>` の構造は既存のまま、why_ja は `.ae-why`）、Round 2 `Button variant="primary"`（`disabled={aeLoading}` 既存のまま）
- **done**: `Card` に完了文

- [ ] **Step 3: FreeTalkScreen.tsx / RoleplayScreen.tsx を移行**

変えてはいけない行: `LABELS`、`onMainButton` 全体（aliveRef チェック位置、空テキスト分岐、`props.onSessionId?.(sessionId)`、`disabled` 条件）、unmount cleanup。RoleplayScreen の `scenarioId` 受け渡し。

見た目差分: メインボタンは `Button variant="primary" size="lg"`（`loading` は使わない — ラベル切替が状態表示なので既存のまま）。会話ログを `.chat` バブルに:

```tsx
<section className="chat">
  {turns.map((t, i) => (
    <div key={i} className={`chat-row ${t.role === "you" ? "you" : "ai"}`}>
      <div className={`bubble ${t.role === "you" ? "bubble-you" : "bubble-ai"}`}>{t.text}</div>
    </div>
  ))}
</section>
```

エラーは `Banner`。RoleplayScreen はシナリオ説明（titleJa `.text-muted`＋ヒント ul）を `Card` に包んでから `<FreeTalkScreen scenarioId={...} />`（props 不変）。

- [ ] **Step 4: ShadowingScreen.tsx を移行**

変えてはいけない行: `prepare`/`play` 本体、`fetchedRef`/`aliveRef` effect、`disabled={state === "playing"}`。

見た目差分: 段階メッセージ `.text-muted`、エラー `Banner`＋`Button` 再試行、再生 `Button variant="primary"`、本文は `Card` 内 `.reading-text`。

- [ ] **Step 5: 横断スイープ検証**

Run: `cd app/client && grep -rnE "crimson|darkorange" src/`
Expected: 0件

Run: `cd app/client && grep -rnE "#[0-9a-fA-F]{3,6}\b" src/ --include="*.tsx" --include="*.ts"`
Expected: 0件（色リテラルは styles/*.css のみ）

Run: `cd app/client && grep -rn "style={{" src/ --include="*.tsx" | grep -v "record-btn"`
Expected: 0件（インラインstyleゼロ。record-btn 例外も実際は className 運用なので通常0件）

Run: `cd app/client && bun run build`
Expected: PASS

Run: `cd ../app 2>/dev/null || cd app; bun test 2>&1 | tail -2`
Expected: 125 pass / 0 fail（サーバ無変更の確認）

- [ ] **Step 6: コミット**

```bash
git add app/client/src
git commit -m "feat: 練習画面を新デザインに移行しインラインスタイルを一掃"
```

---

## Self-Review 結果（プラン作成時に実施済み）

- スペック対応: §1トークン（3層配色/2階調/アクセント/情報色/dark/タイポ/スケール/AA配慮/reduced-motion）→ Task 1 Step 1-2。§2の6コンポーネント → Task 1 Step 4-8。§3の画面別方針 → Task 2-3（カードグリッド/ドットカレンダー/進捗ドット+TimerChip/フェード/大タイマー+録音パルス/階層AE/チャットバブル/カード化）。§4不変条件 → Global Constraints と各タスクの「変えてはいけない行」＋Step 5 の grep 検証
- 型整合: Button/Screen/TimerChip/ChunkList/Banner の props は Task 2/3 の使用箇所と一致（TimerChip の `note` は SessionRunner「キリのいいところで次へ」/ prep「そろそろ始めましょう」で使用。ChunkList の `onPlay` 省略 = 音声なし表示は Warmup フォールバックで使用）
- 留意: FourThreeTwoScreen の録音ボタンのみ、パルス用クラス合成のため生 `<button className="btn btn-primary btn-lg record-btn ...">` を許容（Button コンポーネントは className を受けない設計を維持するため）。プレースホルダなし。カレンダーは7列化（8週×7日の視覚に修正 — 台帳の既知Minorを解消）
