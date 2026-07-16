# 例文300の学習体験強化（ヒント非表示・歯抜け文・i18n）実装計画

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 暗記例文300の練習フローに「ヒント（note）を隠す設定」「答えの前段の歯抜け文（cloze）ステップ」を追加し、画面のUI文言をi18n（EN/JA）対応する。

**Architecture:** すべてクライアント側の変更。歯抜け生成は `app/client/src/cloze.ts` の純粋関数（文の no をシードにした決定的PRNGで内容語の約40%をマスク — 同じ文は毎回同じ歯抜け）。ヒント非表示は localStorage 設定。UI文言は既存 `i18n.ts` の辞書に `sentences` セクションを追加し、`App.tsx` から `lang` prop を渡す（StartScreen/PlacementScreen と同じパターン）。

**Tech Stack:** React + TypeScript（Vite）、bun test（`cd app && bun test` は `app/client/src/*.test.ts` も拾うことを実証済み — 現229テスト＋一時ファイル1件で230になることを確認済み）。

## Global Constraints

- サーバ・API・SRSロジックは一切変更しない（クライアントのみの変更）
- 例文コンテンツ（`en` / `ja` / `note`）自体は翻訳・変換の対象外（UI文言のみ辞書化）
- 情報的フィードバックのみ（喪失を煽る文言・演出の禁止）
- デフォルト挙動は現行互換: note はデフォルト表示、cloze はオプトインのステップ（従来どおり「答えを見る」へ直行できる）
- 同じ文（同じ `no`）の歯抜けは毎回同一（SRS の一貫性のため決定的に生成）
- コミットは Conventional Commits（日本語）
- ゲート: `cd app && bun test`（cloze テスト込みで全green）、`cd app && bun run typecheck`、`cd app/client && bun run build`
- ユーザーの dev サーバ（Vite HMR / bun --watch）は稼働中 — 殺さない

## File Structure

- Create: `app/client/src/cloze.ts` — 歯抜け生成の純粋ロジック（PRNG・ストップワード・clozeText）
- Create: `app/client/src/cloze.test.ts` — 決定性・最低1語・句読点保持・短文エッジのテスト
- Modify: `app/client/src/i18n.ts` — `Strings` 型と EN/JA 辞書に `sentences` セクション追加
- Modify: `app/client/src/screens/SentencesScreen.tsx` — cloze ステップ・ヒント非表示トグル・文言辞書化・`lang` prop
- Modify: `app/client/src/App.tsx` — `<SentencesScreen lang={lang} />`（1行）
- Modify: `app/client/src/styles/app.css` — トグル行の小さなスタイル追加

---

### Task 1: cloze.ts — 決定的歯抜け生成ロジック

**Files:**
- Create: `app/client/src/cloze.ts`
- Test: `app/client/src/cloze.test.ts`

**Interfaces:**
- Consumes: なし（純粋関数のみ・依存ゼロ）
- Produces: `clozeText(en: string, no: number): string` — Task 2 の PracticeTab が使用。`mulberry32(seed: number): () => number` と `STOPWORDS: Set<string>` も export（テスト用）

- [ ] **Step 1: 失敗するテストを書く**

`app/client/src/cloze.test.ts` を以下の内容で作成:

```ts
import { describe, expect, test } from "bun:test";
import { clozeText, STOPWORDS } from "./cloze";

describe("clozeText", () => {
  const SENT = "I usually skip breakfast and just grab coffee on my way out.";

  test("同じ no なら毎回同じ歯抜けになる（決定性）", () => {
    const a = clozeText(SENT, 42);
    const b = clozeText(SENT, 42);
    expect(a).toBe(b);
  });

  test("異なる no では（候補が複数ある文で）別の歯抜けになりうる", () => {
    // 内容語が十分ある文では、シードが違えばマスク位置が変わることを確認する。
    // 決定的なので、この2つのシードで同一になった場合はテストを見直す（フレークではない）
    const a = clozeText(SENT, 1);
    const b = clozeText(SENT, 2);
    expect(a).not.toBe(b);
  });

  test("最低1語はマスクされ、マスクはアンダースコア列で表現される", () => {
    const out = clozeText(SENT, 7);
    expect(out).toMatch(/_{3,}/);
  });

  test("ストップワードはマスクされない", () => {
    // 内容語が1つ（breakfast）だけの文 — 必ずそれがマスクされ、機能語は残る
    const out = clozeText("I have it for breakfast.", 3);
    expect(out).toContain("I have it for");
    expect(out).not.toContain("breakfast");
    expect(out).toMatch(/_{3,}/);
  });

  test("句読点・大文字小文字・語順は保持される", () => {
    const out = clozeText("Could you say that again, please?", 11);
    expect(out.endsWith("?")).toBe(true);
    expect(out).toContain(",");
    // マスク済み語以外の部分文字列は原文のまま
    const restored = out.replace(/_{3,}/g, "");
    for (const frag of restored.split(/\s+/).filter(Boolean)) {
      expect("Could you say that again, please?").toContain(frag.replace(/[,?]/g, ""));
    }
  });

  test("全部ストップワードの短文では最長の語がマスクされる（最低1語保証）", () => {
    const out = clozeText("It is what it is.", 5);
    expect(out).toMatch(/_{3,}/);
    // what（4文字・最長）がマスクされる
    expect(out.toLowerCase()).not.toContain("what");
  });

  test("マスク数は内容語の約40%（最低1語）", () => {
    // 内容語8語（Yesterday/morning/Tanaka/quickly/finished/writing/detailed/reports）→ round(8*0.4)=3語マスク
    const s = "Yesterday morning Tanaka quickly finished writing detailed reports.";
    const out = clozeText(s, 9);
    const masks = out.match(/_{3,}/g) ?? [];
    expect(masks.length).toBe(3);
  });

  test("STOPWORDS は小文字で管理されている", () => {
    for (const w of STOPWORDS) expect(w).toBe(w.toLowerCase());
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `cd app && bun test client/src/cloze.test.ts`
Expected: FAIL（`Cannot find module "./cloze"`）

- [ ] **Step 3: cloze.ts を実装する**

`app/client/src/cloze.ts` を以下の内容で作成:

```ts
/**
 * 歯抜け文（cloze）生成 — 純粋ロジック。
 * 文の no をシードにした決定的PRNGで内容語の約40%をマスクする。
 * 同じ文（同じ no）は毎回同じ歯抜けになる（SRSの一貫性のため）。
 */

/** 決定的PRNG（mulberry32）。同じ seed から同じ乱数列を生成する */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** マスク対象外の機能語（小文字）。冠詞・代名詞・be/have/do・助動詞・前置詞・接続詞・頻出縮約形 */
export const STOPWORDS: Set<string> = new Set([
  // 冠詞・限定詞
  "a", "an", "the", "this", "that", "these", "those", "some", "any", "no", "every", "each",
  // 代名詞
  "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
  "my", "your", "his", "its", "our", "their", "mine", "yours", "myself", "yourself",
  "who", "whom", "whose", "which", "what", "there",
  // be / have / do
  "am", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "having", "do", "does", "did", "doing", "done",
  // 助動詞
  "will", "would", "can", "could", "may", "might", "shall", "should", "must", "need",
  // 前置詞
  "of", "to", "in", "on", "at", "by", "for", "with", "from", "about", "as", "into",
  "over", "under", "up", "down", "off", "out", "than", "through", "between",
  // 接続詞・その他機能語
  "and", "or", "but", "so", "if", "because", "when", "while", "though", "although",
  "not", "too", "very", "just", "also", "then", "how", "why", "where",
  // 頻出縮約形（トークンはアポストロフィ込みで1語として扱う）
  "i'm", "i've", "i'll", "i'd", "you're", "you've", "you'll", "you'd",
  "he's", "she's", "it's", "we're", "we've", "we'll", "they're", "they've",
  "isn't", "aren't", "wasn't", "weren't", "don't", "doesn't", "didn't",
  "won't", "wouldn't", "can't", "couldn't", "shouldn't", "mustn't",
  "that's", "there's", "what's", "let's", "haven't", "hasn't", "hadn't",
]);

type Token = { text: string; isWord: boolean };

/** 英字とアポストロフィの連なりを1語トークンとし、それ以外（空白・句読点）を区切りトークンとして保持 */
function tokenize(en: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z']+/g;
  let last = 0;
  for (let m = re.exec(en); m !== null; m = re.exec(en)) {
    if (m.index > last) tokens.push({ text: en.slice(last, m.index), isWord: false });
    tokens.push({ text: m[0], isWord: true });
    last = m.index + m[0].length;
  }
  if (last < en.length) tokens.push({ text: en.slice(last), isWord: false });
  return tokens;
}

function maskFor(word: string): string {
  // 語長をヒントとして残す（3〜10文字にクランプしたアンダースコア列）
  return "_".repeat(Math.min(Math.max(word.length, 3), 10));
}

/**
 * en の内容語（ストップワード以外）の約40%を決定的にマスクした歯抜け文を返す。
 * 候補ゼロ（全部機能語）の文では最長の語を1つマスクする（最低1語保証）。
 */
export function clozeText(en: string, no: number): string {
  const tokens = tokenize(en);
  const candidates: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.isWord && t.text.length >= 2 && !STOPWORDS.has(t.text.toLowerCase())) {
      candidates.push(i);
    }
  }

  let picked: number[];
  if (candidates.length === 0) {
    // 全部機能語 → 最長の語を1つ（同長なら先頭側）
    let best = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].isWord && (best < 0 || tokens[i].text.length > tokens[best].text.length)) {
        best = i;
      }
    }
    picked = best >= 0 ? [best] : [];
  } else {
    const target = Math.max(1, Math.round(candidates.length * 0.4));
    // Fisher–Yates を PRNG で決定的にシャッフルし、先頭 target 件を採用
    const rand = mulberry32(no);
    const pool = [...candidates];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    picked = pool.slice(0, target);
  }

  const pickedSet = new Set(picked);
  return tokens
    .map((t, i) => (pickedSet.has(i) ? maskFor(t.text) : t.text))
    .join("");
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `cd app && bun test client/src/cloze.test.ts`
Expected: PASS（8 tests）

注意: Step 1 の「異なる no では別の歯抜け」テストは決定的な固定値比較なので、万一 `no=1` と `no=2` が偶然同じマスク位置を選んだ場合はフレークではなく恒常的失敗になる。その場合はテスト側のシード値を（例: 1 と 5 に）変えてよい — 実装のバグではない。

- [ ] **Step 5: 全ゲートを確認**

Run: `cd app && bun test`（クライアント分を含めた全テスト。既存229＋新規8で237前後）
Run: `cd app && bun run typecheck`
Expected: 全PASS・0 errors

- [ ] **Step 6: コミット**

```bash
git add app/client/src/cloze.ts app/client/src/cloze.test.ts
git commit -m "feat: 例文の歯抜け文を決定的に生成するclozeロジックを追加"
```

---

### Task 2: SentencesScreen 改修 — clozeステップ・ヒント非表示・i18n

**Files:**
- Modify: `app/client/src/i18n.ts`
- Modify: `app/client/src/screens/SentencesScreen.tsx`
- Modify: `app/client/src/App.tsx`（1行）
- Modify: `app/client/src/styles/app.css`

**Interfaces:**
- Consumes: Task 1 の `clozeText(en, no)`、既存 `STR`/`Lang`（i18n.ts）、既存 API ヘルパ（変更なし）
- Produces: `SentencesScreen` の props が `{ lang: Lang }` になる（App.tsx 側の呼び出しを同時に更新）

- [ ] **Step 1: i18n.ts に sentences セクションを追加**

`Strings` 型の `placement: {...};` ブロックの直後（型定義の閉じ `};` の前）に追加:

```ts
  sentences: {
    heroTitle: string; heroDesc: string;
    tabPractice: string; tabBrowse: string;
    hideNoteLabel: string;
    loading: string; retry: string;
    remaining: (left: number, graded: number) => string;
    sayItFirst: string;
    showCloze: string; showAnswer: string;
    clozeHint: string;
    playAgain: string;
    gradeGood: string; gradeSoso: string; gradeBad: string;
    doneTitle: (n: number) => string;
    dueTomorrow: (n: number) => string;
    doneBody: string;
    filterAll: string;
    domain: { daily: string; business: string; it: string };
    srsNew: string;
    playAria: (no: number) => string;
  };
```

`en` 辞書の `placement: {...},` ブロックの直後に追加:

```ts
    sentences: {
      heroTitle: "300 Sentences",
      heroDesc: "Read the Japanese, say it out loud first — recalling is what builds memory",
      tabPractice: "Today's practice", tabBrowse: "Browse",
      hideNoteLabel: "Hide hints",
      loading: "Loading…", retry: "Retry",
      remaining: (left, graded) => `${left} left (${graded} graded)`,
      sayItFirst: "↑ Say it in English out loud first",
      showCloze: "Show gaps", showAnswer: "Show answer",
      clozeHint: "Fill the gaps out loud, then check the answer",
      playAgain: "🔊 Play again",
      gradeGood: "✅ Got it", gradeSoso: "😕 Shaky", gradeBad: "❌ Didn't come out",
      doneTitle: (n) => `Done for today (${n} sentences)`,
      dueTomorrow: (n) => `Due tomorrow: ${n}. `,
      doneBody: "Recalling out loud is the shortest path to retention. See you tomorrow.",
      filterAll: "All",
      domain: { daily: "Daily", business: "Business", it: "IT" },
      srsNew: "New",
      playAria: (no) => `Play No.${no}`,
    },
```

`ja` 辞書の `placement: {...},` ブロックの直後に追加:

```ts
    sentences: {
      heroTitle: "暗記例文300",
      heroDesc: "日本語を見て、まず声に出す — 思い出す練習が記憶を作ります",
      tabPractice: "今日の練習", tabBrowse: "一覧",
      hideNoteLabel: "ヒントを隠す",
      loading: "読み込み中…", retry: "再試行",
      remaining: (left, graded) => `残り ${left} 文（うち評価済み ${graded}）`,
      sayItFirst: "↑ を英語で、まず声に出して言ってみる",
      showCloze: "歯抜けを見る", showAnswer: "答えを見る",
      clozeHint: "空欄を埋めながらもう一度声に出して、答え合わせへ",
      playAgain: "🔊 もう一度聞く",
      gradeGood: "✅ 言えた", gradeSoso: "😕 あいまい", gradeBad: "❌ 出てこない",
      doneTitle: (n) => `今日の分は完了です（${n}文）`,
      dueTomorrow: (n) => `明日の復習予定: ${n}文。`,
      doneBody: "思い出して声に出すことが定着の近道です。また明日。",
      filterAll: "すべて",
      domain: { daily: "日常", business: "ビジネス", it: "IT" },
      srsNew: "未学習",
      playAria: (no) => `No.${no} を再生`,
    },
```

- [ ] **Step 2: SentencesScreen.tsx を全面改修**

`app/client/src/screens/SentencesScreen.tsx` を以下の内容で置き換える:

```tsx
import { useEffect, useRef, useState } from "react";
import {
  fetchSentenceQueue, fetchSentences, gradeSentence, playTtsCached,
  type SentenceItem,
} from "../api";
import { stopPlayback } from "../audio";
import { clozeText } from "../cloze";
import { STR, type Lang } from "../i18n";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

const NEW_PER_DAY = 10;
const HIDE_NOTE_KEY = "sentences.hideNote";

type Tab = "practice" | "browse";
type Phase = "prompt" | "cloze" | "answer";
type LoadState = "loading" | "ready" | "error";

function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadHideNote(): boolean {
  return localStorage.getItem(HIDE_NOTE_KEY) === "1";
}

function saveHideNote(v: boolean): void {
  localStorage.setItem(HIDE_NOTE_KEY, v ? "1" : "0");
}

/** 練習タブ: ja→（声に出す）→[歯抜け]→答えを見る→自動再生→自己評価、の産出リトリーバルフロー */
function PracticeTab({ lang, hideNote }: { lang: Lang; hideNote: boolean }) {
  const t = STR[lang].sentences;
  const [state, setState] = useState<LoadState>("loading");
  const [queue, setQueue] = useState<SentenceItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("prompt");
  const [gradedCount, setGradedCount] = useState(0);
  const [dueTomorrow, setDueTomorrow] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      load();
    }
    return () => {
      aliveRef.current = false;
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setState("loading");
    setErrorMsg("");
    try {
      const q = await fetchSentenceQueue(NEW_PER_DAY);
      if (!aliveRef.current) return;
      setQueue(q);
      setIdx(0);
      setPhase("prompt");
      setState("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  const current = queue[idx];
  const done = state === "ready" && !current;

  useEffect(() => {
    // 完了画面で「明日の復習予定数」を出す（情報表示のみ・失敗は無視）
    if (!done || dueTomorrow !== null) return;
    fetchSentences()
      .then((all) => {
        if (!aliveRef.current) return;
        const tmr = new Date();
        tmr.setDate(tmr.getDate() + 1);
        const tomorrow = localYmd(tmr);
        setDueTomorrow(all.filter((s) => s.srs && s.srs.due <= tomorrow).length);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  async function reveal() {
    setPhase("answer");
    try {
      await playTtsCached(current.en);
    } catch {
      // 音声は補助 — 再生失敗でフローを止めない（🔊で再試行できる）
    }
  }

  async function grade(g: "good" | "soso" | "bad") {
    setBusy(true);
    setErrorMsg("");
    try {
      await gradeSentence(current.no, g);
      if (!aliveRef.current) return;
      stopPlayback();
      setGradedCount((n) => n + 1);
      setIdx((i) => i + 1);
      setPhase("prompt");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  if (state === "loading") return <p className="text-muted">{t.loading}</p>;
  if (state === "error") {
    return <Banner kind="error" action={<Button onClick={load}>{t.retry}</Button>}>{errorMsg}</Banner>;
  }
  if (done) {
    return (
      <Card>
        <p className="sentence-done">{t.doneTitle(gradedCount)}</p>
        <p className="text-muted">
          {dueTomorrow === null ? "" : t.dueTomorrow(dueTomorrow)}
          {t.doneBody}
        </p>
      </Card>
    );
  }
  return (
    <div className="stack">
      <p className="text-sm text-muted">{t.remaining(queue.length - idx, gradedCount)}</p>
      <Card>
        <p className="sentence-ja">{current.ja}</p>
        {!hideNote && <p className="text-sm text-muted">{current.note}</p>}
        {phase === "prompt" && (
          <>
            <p className="text-muted">{t.sayItFirst}</p>
            <div className="round-actions">
              <Button variant="secondary" onClick={() => setPhase("cloze")}>{t.showCloze}</Button>
              <Button variant="primary" size="lg" onClick={reveal}>{t.showAnswer}</Button>
            </div>
          </>
        )}
        {phase === "cloze" && (
          <>
            <p className="sentence-cloze">{clozeText(current.en, current.no)}</p>
            <p className="text-muted">{t.clozeHint}</p>
            <div className="round-actions">
              <Button variant="primary" size="lg" onClick={reveal}>{t.showAnswer}</Button>
            </div>
          </>
        )}
        {phase === "answer" && (
          <>
            <p className="sentence-en">{current.en}</p>
            <div className="round-actions">
              <Button variant="ghost" onClick={() => playTtsCached(current.en).catch(() => {})} ariaLabel={t.playAgain}>
                {t.playAgain}
              </Button>
            </div>
            <div className="grade-row">
              <Button onClick={() => grade("good")} disabled={busy}>{t.gradeGood}</Button>
              <Button onClick={() => grade("soso")} disabled={busy}>{t.gradeSoso}</Button>
              <Button onClick={() => grade("bad")} disabled={busy}>{t.gradeBad}</Button>
            </div>
          </>
        )}
        {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      </Card>
    </div>
  );
}

/** 一覧タブ: domainフィルタ + カテゴリ見出しでのブラウズ。SRS状態は情報表示のみ */
function BrowseTab({ lang }: { lang: Lang }) {
  const t = STR[lang].sentences;
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<SentenceItem[]>([]);
  const [filter, setFilter] = useState<"all" | SentenceItem["domain"]>("all");
  const [playingNo, setPlayingNo] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      load();
    }
    return () => {
      aliveRef.current = false;
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setState("loading");
    setErrorMsg("");
    try {
      const all = await fetchSentences();
      if (!aliveRef.current) return;
      setItems(all);
      setState("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  async function play(s: SentenceItem) {
    setPlayingNo(s.no);
    try {
      await playTtsCached(s.en);
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setPlayingNo(null);
    }
  }

  if (state === "loading") return <p className="text-muted">{t.loading}</p>;
  if (state === "error") {
    return <Banner kind="error" action={<Button onClick={load}>{t.retry}</Button>}>{errorMsg}</Banner>;
  }
  const shown = filter === "all" ? items : items.filter((s) => s.domain === filter);
  const categories = [...new Map(shown.map((s) => [s.category_no, s.category])).entries()]
    .sort((a, b) => a[0] - b[0]);
  return (
    <div className="stack">
      <div className="filter-row">
        {(["all", "daily", "business", "it"] as const).map((f) => (
          <button
            key={f}
            className={`filter-chip${filter === f ? " is-active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? t.filterAll : t.domain[f]}
          </button>
        ))}
      </div>
      {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      {categories.map(([catNo, catName]) => (
        <Card key={catNo} header={`${catNo}. ${catName}`}>
          {shown.filter((s) => s.category_no === catNo).map((s) => (
            <div key={s.no} className="sentence-row">
              <Button
                variant="ghost"
                onClick={() => play(s)}
                disabled={playingNo !== null}
                ariaLabel={t.playAria(s.no)}
              >
                {playingNo === s.no ? "🔊" : "▶"}
              </Button>
              <div className="sentence-body">
                <span className="sentence-en">{s.en}</span>
                <span className="sentence-ja-sub">{s.ja}</span>
                <span className="text-sm text-muted">{s.note}</span>
              </div>
              <span className="sentence-srs text-sm text-muted">
                {s.srs ? `st${s.srs.stage} ・ ${s.srs.due.slice(5)}` : t.srsNew}
              </span>
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

export function SentencesScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].sentences;
  const [tab, setTab] = useState<Tab>("practice");
  const [hideNote, setHideNote] = useState(() => loadHideNote());

  function toggleHideNote() {
    setHideNote((v) => {
      saveHideNote(!v);
      return !v;
    });
  }

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{t.heroTitle}</h2>
        <p className="hero-date">{t.heroDesc}</p>
      </div>
      <div className="filter-row sentences-toolbar">
        <button className={`filter-chip${tab === "practice" ? " is-active" : ""}`} onClick={() => setTab("practice")}>
          {t.tabPractice}
        </button>
        <button className={`filter-chip${tab === "browse" ? " is-active" : ""}`} onClick={() => setTab("browse")}>
          {t.tabBrowse}
        </button>
        <label className="hide-note-toggle text-sm text-muted">
          <input type="checkbox" checked={hideNote} onChange={toggleHideNote} />
          {t.hideNoteLabel}
        </label>
      </div>
      {tab === "practice" ? <PracticeTab lang={lang} hideNote={hideNote} /> : <BrowseTab lang={lang} />}
    </div>
  );
}
```

実装メモ:
- `DOMAIN_LABEL` 定数は削除（辞書 `t.domain` に置き換え）
- ヒント非表示は**練習タブのみ**に適用（一覧タブは参照モードなので note は常に表示）
- cloze ステップはスキップ可能（prompt に「答えを見る」を残す）。cloze→answer の遷移も従来と同じ `reveal()` で音声自動再生
- `phase` の初期化は既存どおり `grade()` 成功時と `load()` で "prompt" に戻る — cloze 状態が次のカードに持ち越されないことをこの2箇所が保証する

- [ ] **Step 3: App.tsx の呼び出しを更新（1行）**

`app/client/src/App.tsx` の

```tsx
      {mode.kind === "sentences" && <SentencesScreen />}
```

を

```tsx
      {mode.kind === "sentences" && <SentencesScreen lang={lang} />}
```

に変更（`lang` は既にスコープ内にある。他の行は触らない）。

- [ ] **Step 4: app.css にスタイルを追加**

`/* 暗記例文 */` セクション（`.sentence-ja` などの既存ルール群）の末尾に追加:

```css
.sentence-cloze { font-size: var(--fs-lg); line-height: var(--lh-reading); font-weight: 600; letter-spacing: 0.02em; }
.sentences-toolbar { align-items: center; }
.hide-note-toggle { display: inline-flex; align-items: center; gap: var(--sp-1); margin-left: auto; cursor: pointer; user-select: none; }
.hide-note-toggle input { accent-color: var(--accent); }
```

（既存の暗記例文セクションが見つからない場合は、`.sentence-row` 等を grep して同じ塊の直後に置く。）

- [ ] **Step 5: 全ゲートを確認**

Run: `cd app && bun test`（Task 1 の cloze テスト込みで全green・サーバテスト不変）
Run: `cd app && bun run typecheck`
Run: `cd app/client && bun run build`
Expected: 全PASS・0 errors

- [ ] **Step 6: コミット**

```bash
git add app/client/src
git commit -m "feat: 例文練習に歯抜けステップとヒント非表示設定を追加しUI文言をi18n対応"
```

---

## Self-Review チェックリスト（計画執筆時に実施済み）

1. **要件カバレッジ**: ①ヒント非表示（Task 2: HIDE_NOTE_KEY・練習タブのみ・デフォルト表示）②歯抜け文（Task 1 ロジック + Task 2 の cloze フェーズ・スキップ可能・決定的）③i18n（Task 2: sentences セクション EN/JA・例文コンテンツは対象外）— 3点すべてタスクに対応づく
2. **bun test の探索範囲**: `cd app && bun test` が `app/client/src/*.test.ts` を拾うことを一時ファイルで実証済み（229→230）。Task 1 Step 5 のゲートに含めた
3. **型整合**: `SentencesScreen({ lang }: { lang: Lang })` と App.tsx の呼び出し・`STR[lang].sentences` のキーは Strings 型追加と一致。`clozeText(en: string, no: number)` は SentenceItem の `en`/`no` と一致
4. **プレースホルダ**: なし（全ステップ完全なコード）
