# P6-3 聴覚起点リトリーバルモード（音から）Implementation Plan

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 例文練習（PracticeTab）に、画面ローカルで切替できる「音から」モード（TTS を先に聞き、英文・日本語とも非表示のまま意味を想起 → 表示して答え合わせ → 既存の3段階自己評価）を追加する。

**Architecture:** 初期フェーズ決定ロジックを純関数 `initialPhase(audioFirst, clozeDefault)` として `screens/practicePhase.ts` に切り出し（`blockTitle.ts` の前例に倣う）、PracticeTab の初期 state と grade 後リセットの2箇所で共有する（DRY）。`Phase` union に `"listen"` を追加し、listen フェーズでは現状 phase 非依存で常時レンダリングされている ja/promptText ブロックと note ブロックを gating で隠す。トグルは SentencesScreen の画面ローカル state（localStorage `sentences.audioFirst`）として `hideNote` と同型に配線し、`audioFirst` prop で PracticeTab に渡す。

**Tech Stack:** React 18 + TypeScript、Vite（クライアント）、bun:test（純ロジックの単体テスト）、既存 `playTtsCached`（テキスト単位 TTS Blob キャッシュ再生）。

## Global Constraints

- **挙動契約（回帰基準）**: `audioFirst=false`（既定）のとき、練習フローは v0.11.0 と完全同一。grade / SRS / XP 経路は一切変更しない（`grade()` 内の `gradeChunk`/`gradeSentence` 呼び出しと後続処理は不変）。
- **研究制約**: 情報的トーンのみ。ノルマ・強制・自動表示は入れない。listen フェーズでも「答えを見る」ボタンでいつでも表示できる（隠しは表示制御であって剥奪ではない）。
- **i18n 規約**: 画面文言は `app/client/src/i18n.ts` の named 型サブ辞書（`SentencesStrings`）に EN/JA 両方を追加する。片方だけの追加は型エラーになる。
- **トグルは画面ローカル**: サポート設定（`support.ts`）には足さない。localStorage キー `sentences.audioFirst`、値は `"1"`/`"0"`、`hideNote`（キー `sentences.hideNote`）と完全同型の直読み。
- **TTS**: listen フェーズの再生は既存 `playTtsCached(current.en)` で足りる（多聴 ListeningScreen のトークン方式は単発再生には過剰なので使わない）。`current.en` は `SentenceQueueItem` / `ChunkQueueItem` 双方に存在する（`api/sentences.ts:16`,`:7`）ので分岐不要。
- **検証ゲート（各タスク末尾で全て green）**: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`。`cd app && bun test` は client の `*.test.ts`（`blockTitle.test.ts` 等）も再帰的に拾う（確認済み: 405 pass）。

---

## File Structure

- `app/client/src/screens/practicePhase.ts` — **新規**。`Phase` 型と純関数 `initialPhase()` の唯一の定義。React 非依存で単体テスト可能。
- `app/client/src/screens/practicePhase.test.ts` — **新規**。`initialPhase()` の bun:test（`blockTitle.test.ts` と同型）。
- `app/client/src/screens/PracticeTab.tsx` — **改修**。ローカル `Phase` 型を削除して `practicePhase.ts` から import、`audioFirst` prop 追加、listen フェーズの描画・gating・自動再生 effect を追加。
- `app/client/src/screens/SentencesScreen.tsx` — **改修**。`sentences.audioFirst` の load/save・state・トグル・チェックボックス・`audioFirst` prop 受け渡し。
- `app/client/src/i18n.ts` — **改修**。`SentencesStrings` に `listenPrompt`（Task 1）と `audioFirstLabel`（Task 2）を EN/JA 両方追加。

---

## Task 1: PracticeTab に「音から」フェーズと initialPhase ヘルパを追加（TDD）

`initialPhase` を純関数として切り出して単体テストし、PracticeTab に listen フェーズを実装する。`audioFirst` は optional prop（既定 `false`）とし、このタスクでは SentencesScreen を変更しない。SentencesScreen は `audioFirst` を渡さない → 既定 `false` → 練習フローは v0.11.0 と完全同一（このタスク単体が回帰ゼロでマージ可能）。

**Files:**
- Create: `app/client/src/screens/practicePhase.ts`
- Test: `app/client/src/screens/practicePhase.test.ts`
- Modify: `app/client/src/i18n.ts`（`SentencesStrings` 型 + EN 辞書 + JA 辞書に `listenPrompt`）
- Modify: `app/client/src/screens/PracticeTab.tsx`

**Interfaces:**
- Produces: `export type Phase = "listen" | "prompt" | "cloze" | "answer"`（`practicePhase.ts`）
- Produces: `export function initialPhase(audioFirst: boolean, clozeDefault: boolean): Phase` — `audioFirst` 最優先で `"listen"`、次に `clozeDefault ? "cloze" : "prompt"`。排他適用。
- Produces: `PracticeTab` の props に optional `audioFirst?: boolean`（既定 `false`）を追加。Task 2 がこれを consume する。

- [ ] **Step 1: 失敗するテストを書く**

`app/client/src/screens/practicePhase.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { initialPhase } from "./practicePhase";

describe("initialPhase", () => {
  test("audioFirst が最優先で listen を返す（clozeDefault に関わらず）", () => {
    expect(initialPhase(true, false)).toBe("listen");
    expect(initialPhase(true, true)).toBe("listen");
  });
  test("audioFirst=false のときは clozeDefault が cloze/prompt を決める（v0.11.0 と同一）", () => {
    expect(initialPhase(false, true)).toBe("cloze");
    expect(initialPhase(false, false)).toBe("prompt");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認する**

Run: `cd app && bun test client/src/screens/practicePhase.test.ts`
Expected: FAIL（`Cannot find module './practicePhase'` — `initialPhase` 未定義）

- [ ] **Step 3: 最小の実装を書く**

`app/client/src/screens/practicePhase.ts` を新規作成:

```ts
/** 練習カードのフェーズ。ja→想起の "prompt"、歯抜けの "cloze"、音から始める "listen"、答え合わせの "answer"。 */
export type Phase = "listen" | "prompt" | "cloze" | "answer";

/**
 * カード開始時（および grade 後の次カード）の初期フェーズを決める。
 * 適用は排他で、音から(audioFirst) > 歯抜け(clozeDefault) > 通常(prompt) の優先順。
 * audioFirst=false のときは従来どおり clozeDefault のみで cloze/prompt を決める（挙動契約: v0.11.0 と同一）。
 */
export function initialPhase(audioFirst: boolean, clozeDefault: boolean): Phase {
  if (audioFirst) return "listen";
  return clozeDefault ? "cloze" : "prompt";
}
```

- [ ] **Step 4: テストが通ることを確認する**

Run: `cd app && bun test client/src/screens/practicePhase.test.ts`
Expected: PASS（2 tests / 4 expect calls）

- [ ] **Step 5: i18n に listenPrompt を追加する（型 + EN + JA）**

`app/client/src/i18n.ts` の `SentencesStrings` 型定義に `listenPrompt` を追加する。`sayItFirst: string;`（108行目付近）の直後に1行追加:

```ts
    sayItFirst: string;
    listenPrompt: string;
```

EN 辞書（`sayItFirst: "↑ Say it in English out loud first",` の直後、294行目付近）に追加:

```ts
      sayItFirst: "↑ Say it in English out loud first",
      listenPrompt: "🔊 Listen only — say what it means or repeat it",
```

JA 辞書（`sayItFirst: "↑ を英語で、まず声に出して言ってみる",` の直後、504行目付近）に追加:

```ts
      sayItFirst: "↑ を英語で、まず声に出して言ってみる",
      listenPrompt: "🔊 音だけを聞いて、意味を言う・繰り返してみましょう",
```

- [ ] **Step 6: PracticeTab に listen フェーズを実装する**

`app/client/src/screens/PracticeTab.tsx` を以下のとおり改修する。

(6a) `Phase` を `practicePhase.ts` から import し、ローカル定義を削除する。13行目 `import { localYmd } from "../dates";` の直後に import を追加:

```ts
import { localYmd } from "../dates";
import { initialPhase, type Phase } from "./practicePhase";
```

そして17行目のローカル型定義 `type Phase = "prompt" | "cloze" | "answer";` を**削除**する。

(6b) コンポーネント signature に optional `audioFirst` を追加する（20行目）:

```ts
export function PracticeTab({ lang, hideNote, clozeDefault, audioFirst = false }: { lang: Lang; hideNote: boolean; clozeDefault: boolean; audioFirst?: boolean }) {
```

(6c) 初期 phase を `initialPhase` で決める（24行目 `const [phase, setPhase] = useState<Phase>(clozeDefault ? "cloze" : "prompt");` を置換）:

```ts
  const [phase, setPhase] = useState<Phase>(initialPhase(audioFirst, clozeDefault));
```

(6d) grade 後のリセットも `initialPhase` にする（74行目 `setPhase(clozeDefault ? "cloze" : "prompt");` を置換）:

```ts
      setPhase(initialPhase(audioFirst, clozeDefault));
```

(6e) listen フェーズに入ったカードごとに一度だけ TTS を自動再生する effect を追加する。`const done = ...`（38行目）の直後に挿入:

```ts
  const done = load.state.status === "ready" && !current;

  // 「音から」フェーズに入ったカードごとに一度だけ TTS を自動再生する（英文・ja は非表示のまま）。
  // 音声は補助 — 失敗してもフローは止めない。ref キーで StrictMode 二重実行・再レンダーの重複再生を防ぐ。
  const listenPlayedRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "listen" || !current) return;
    const key = current.kind === "chunk" ? `c${current.id}` : `s${current.no}`;
    if (listenPlayedRef.current === key) return;
    listenPlayedRef.current = key;
    playTtsCached(current.en).catch(() => {});
  }, [phase, current]);
```

（`useRef`・`useEffect`・`playTtsCached` は既に import 済み。1行目・3行目参照。）

(6f) 常時表示されている ja/promptText ブロック（102〜109行目）を `phase !== "listen"` で gating する。既存:

```tsx
        {current.kind === "chunk" ? (
          <>
            <p className="text-sm text-muted">{t.chunkLabel}</p>
            <p className="sentence-ja">{current.promptText}</p>
          </>
        ) : (
          <p className="sentence-ja">{current.ja}</p>
        )}
```

を次に置換:

```tsx
        {phase !== "listen" && (current.kind === "chunk" ? (
          <>
            <p className="text-sm text-muted">{t.chunkLabel}</p>
            <p className="sentence-ja">{current.promptText}</p>
          </>
        ) : (
          <p className="sentence-ja">{current.ja}</p>
        ))}
```

(6g) note ブロック（111行目）も listen フェーズでは隠す（日本語ヒントが漏れないように）。既存:

```tsx
        {(!hideNote || phase === "answer") && current.note && <p className="text-sm text-muted">{current.note}</p>}
```

を次に置換:

```tsx
        {phase !== "listen" && (!hideNote || phase === "answer") && current.note && <p className="text-sm text-muted">{current.note}</p>}
```

(6h) listen フェーズの描画ブロックを追加する。`{phase === "prompt" && (`（112行目）の**直前**に挿入:

```tsx
        {phase === "listen" && (
          <>
            <p className="text-muted">{t.listenPrompt}</p>
            <div className="round-actions">
              <Button variant="ghost" onClick={() => playTtsCached(current.en).catch(() => {})} ariaLabel={t.playAgain}>
                {t.playAgain}
              </Button>
              <Button variant="primary" size="lg" onClick={reveal}>{t.showAnswer}</Button>
            </div>
          </>
        )}
        {phase === "prompt" && (
```

- [ ] **Step 7: 全ゲートを実行して green を確認する**

Run: `cd app && bun test`
Expected: PASS（既存 405 + `initialPhase` 2 = 407 pass, 0 fail）

Run: `cd app && bun run typecheck`
Expected: エラーなし（exit 0）

Run: `cd app/client && bun run build`
Expected: `tsc --noEmit && vite build` 成功（エラーなし）

- [ ] **Step 8: コミット**

```bash
cd <repo-root>
git add app/client/src/screens/practicePhase.ts app/client/src/screens/practicePhase.test.ts app/client/src/screens/PracticeTab.tsx app/client/src/i18n.ts
git commit -m "feat: 例文練習に音から始める listen フェーズを追加（既定オフ・回帰ゼロ）"
```

---

## Task 2: SentencesScreen に画面ローカルトグルを配線してモードを起動する

`sentences.audioFirst` を `hideNote` と完全同型に配線し、練習ツールバーにチェックボックスを追加、`audioFirst` prop を PracticeTab に渡す。これでモードが実際に切替可能になる。

**Files:**
- Modify: `app/client/src/i18n.ts`（`SentencesStrings` 型 + EN 辞書 + JA 辞書に `audioFirstLabel`）
- Modify: `app/client/src/screens/SentencesScreen.tsx`

**Interfaces:**
- Consumes: `PracticeTab` の optional prop `audioFirst?: boolean`（Task 1 で追加済み）。

**このタスクにユニットテストを追加しない理由（明記）:** クライアントには React レンダーテスト基盤が無い（既存テストは全て純ロジックの bun:test）。追加する `loadAudioFirst`/`saveAudioFirst` は `hideNote` の `loadHideNote`/`saveHideNote`（`SentencesScreen.tsx:10-16`）と同型の自明な localStorage ラッパーで、その前例もインラインかつ未テスト。ここだけ新規にテストを起こすのは規約不整合かつ YAGNI。検証は typecheck + build（tsc が prop 配線を捕捉）＋ 下記の手動スモークで行う。

- [ ] **Step 1: i18n に audioFirstLabel を追加する（型 + EN + JA）**

`app/client/src/i18n.ts` の `SentencesStrings` 型定義に追加する。`hideNoteLabel: string;`（105行目付近）の直後:

```ts
    hideNoteLabel: string;
    audioFirstLabel: string;
```

EN 辞書（`hideNoteLabel: "Hide hints",` の直後、291行目付近）:

```ts
      hideNoteLabel: "Hide hints",
      audioFirstLabel: "Start from audio",
```

JA 辞書（`hideNoteLabel: "ヒントを隠す",` の直後、501行目付近）:

```ts
      hideNoteLabel: "ヒントを隠す",
      audioFirstLabel: "音から始める",
```

- [ ] **Step 2: SentencesScreen にトグルを配線する**

`app/client/src/screens/SentencesScreen.tsx` を改修する。

(2a) `sentences.audioFirst` の load/save を `hideNote` と同型で追加する。既存の `saveHideNote`（16行目）の直後に挿入:

```ts
function saveHideNote(v: boolean): void {
  localStorage.setItem(HIDE_NOTE_KEY, v ? "1" : "0");
}

const AUDIO_FIRST_KEY = "sentences.audioFirst";

function loadAudioFirst(): boolean {
  return localStorage.getItem(AUDIO_FIRST_KEY) === "1";
}

function saveAudioFirst(v: boolean): void {
  localStorage.setItem(AUDIO_FIRST_KEY, v ? "1" : "0");
}
```

(2b) state とトグル関数を追加する。`const [hideNote, setHideNote] = useState(() => loadHideNote());`（21行目）の直後に:

```ts
  const [hideNote, setHideNote] = useState(() => loadHideNote());
  const [audioFirst, setAudioFirst] = useState(() => loadAudioFirst());
```

`toggleHideNote`（26〜31行目）の直後に:

```ts
  function toggleAudioFirst() {
    setAudioFirst((v) => {
      saveAudioFirst(!v);
      return !v;
    });
  }
```

(2c) ツールバーに `hideNote` と同型のチェックボックスを追加する。`hide-note-toggle` の `<label>`（46〜49行目）の直後に:

```tsx
        <label className="hide-note-toggle text-sm text-muted">
          <input type="checkbox" checked={hideNote} onChange={toggleHideNote} />
          {t.hideNoteLabel}
        </label>
        <label className="hide-note-toggle text-sm text-muted">
          <input type="checkbox" checked={audioFirst} onChange={toggleAudioFirst} />
          {t.audioFirstLabel}
        </label>
```

(2d) `PracticeTab` に `audioFirst` を渡す（51行目）:

```tsx
      {tab === "practice" ? <PracticeTab lang={lang} hideNote={hideNote} clozeDefault={clozeDefault} audioFirst={audioFirst} /> : <BrowseTab lang={lang} />}
```

- [ ] **Step 3: 全ゲートを実行して green を確認する**

Run: `cd app && bun test`
Expected: PASS（407 pass, 0 fail）

Run: `cd app && bun run typecheck`
Expected: エラーなし（exit 0）

Run: `cd app/client && bun run build`
Expected: `tsc --noEmit && vite build` 成功（エラーなし）

- [ ] **Step 4: 手動スモーク確認（起動して目視）**

Run: `cd app && bun run dev`（別ターミナルで `cd app/client && bun run dev`）
確認内容:
1. 「暗記例文300」→「今日の練習」で、ツールバーに「音から始める」チェックボックスが表示される。
2. オンにすると、次のカードから日本語（例文）/表現テキスト（チャンク）と note が非表示になり、TTS が自動再生される。「🔊 もう一度聞く」で再生、「答えを見る」で英文表示＋自動再生＋3段階評価（✅/😕/❌）が出る。
3. オフに戻すと v0.11.0 と同じ ja 起点フロー。ページ再読込後もトグル状態が保持される（localStorage `sentences.audioFirst`）。
4. 評価を押すと次カードへ進み、`audioFirst` オンなら再び listen フェーズから始まる。

- [ ] **Step 5: コミット**

```bash
cd <repo-root>
git add app/client/src/screens/SentencesScreen.tsx app/client/src/i18n.ts
git commit -m "feat: 練習ツールバーに音から始めるトグルを追加し audio-first モードを起動"
```

---

## Self-Review

**1. Spec coverage（P6-3 の各要件 → タスク対応）:**

| spec P6-3 の要件 | 対応 |
|---|---|
| フロー: TTS 先行再生（en/ja 非表示）→ 意味を言う/繰り返す → 表示 → 既存3段階評価 | Task 1 Step 6e（自動再生）/ 6f・6g（gating）/ 6h（listen 描画）/ reveal で answer フェーズ（既存の grade 経路） |
| `Phase` union に `listen` 追加、初期 phase を `audioFirst ? "listen" : (clozeDefault ? "cloze" : "prompt")` | Task 1 Step 3（`initialPhase`）/ 6c・6d |
| architect 指摘: 常時レンダリングの ja/promptText ブロックを listen で隠す gating が必須 | Task 1 Step 6f（＋6g で note も隠す） |
| 適用範囲: 例文＋期限到来チャンク双方に効く（チャンクは better 版 en 再生） | `current.en` が両型に存在（Global Constraints）。6e/6h とも分岐なしで両対応。key は `c{id}`/`s{no}` で区別 |
| トグルは画面ローカル・localStorage `sentences.audioFirst`・ui.scale と同型の直読み・サポート設定に足さない | Task 2 Step 2a（`hideNote`＝ui.scale と同型の `"1"/"0"` 直読み。support.ts 非改変） |
| TTS は reveal と同じ `playTtsCached(current.en)` で足りる | Task 1 Step 6e・6h・reveal（既存） |
| 情報的トーン・listen でも「表示」でいつでも開ける | 6h の「答えを見る」ボタン（`reveal`）。ノルマ/自動表示なし |
| grade/SRS/XP 経路不変・audioFirst=false で v0.11.0 完全同一 | `grade()` 未改変。audioFirst 既定 false → 初期 phase・reset・effect すべて従来経路（effect は phase!=="listen" で即 return） |

ギャップなし。

**2. Placeholder scan:** 「TBD」「適切に処理」「上記と同様」等なし。全コードブロックに実コードを記載。手動スモーク（Task 2 Step 4）は具体的手順を列挙済み。

**3. Type consistency:** `initialPhase(audioFirst: boolean, clozeDefault: boolean): Phase` の名前・引数順が定義（Task 1 Step 3）と全呼び出し（6c/6d）で一致。`Phase` は `practicePhase.ts` の単一定義を PracticeTab が import（6a でローカル定義削除）。`audioFirst?: boolean` prop（Task 1 6b で定義）と `audioFirst={audioFirst}`（Task 2 2d で供給）が整合。i18n の新キー `listenPrompt`（Task 1）/`audioFirstLabel`（Task 2）は型・EN・JA の3箇所すべてに追加され、使用箇所（`t.listenPrompt` in 6h、`t.audioFirstLabel` in 2c）と一致。localStorage キー `sentences.audioFirst` は定義（2a）と `hideNote` 同型で一貫。

修正事項なし。
