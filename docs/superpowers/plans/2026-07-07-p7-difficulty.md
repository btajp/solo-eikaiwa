# P7 出だしの負荷とステップアップの実効化（難易度フォーカス）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 学習の「出だしの負荷」を下げ（既定 Lv・秒数カーブ・ラウンド中の足場）、SRS 負荷を自己調整可能にし、難易度カーブの下方向を実効化する（降格アンカー＋実測シグナル）。素材面では stage1 帯のロールプレイ枯渇を補う。

**Architecture:** サーバの難易度つまみ（`app/server/progression.ts`）を中心に、既定レベル・4/3/2 秒数カーブ・降格先アンカーを変更する。降格提案（`app/server/progress-store.ts`）には、既に session ログに記録済みの `round_end`（`elapsedSec`/`transcript`）から算出する「発話量シグナル」を追加する（新規テーブルは作らない）。クライアントは 4/3/2 画面（`FourThreeTwoScreen.tsx`）と例文練習（`PracticeTab.tsx`/`SentencesScreen.tsx`）に情報的な文言と表示区切りを足す。stage1 帯シナリオは既存生成パイプラインに準じた固定プラン生成モードを追加して補充する。

**Tech Stack:** TypeScript / Bun（`bun test`・`tsc --noEmit`）/ React（Vite, `app/client`）/ bun:sqlite。i18n は `app/client/src/i18n.ts`（EN/JA 2 系統）。

## Global Constraints

- 研究制約（binding・全タスク共通）: フィードバックは**情報的のみ**。**XP は減らさない**。**自動降格しない**（提案＋本人承認のみ）。**警告調・判定調・ノルマ・未達表示を出さない**。中立トーン。
- サーバの仕様変更（定数・純粋関数・降格ロジック）は**テストの意図的更新を明示**する。サーバロジック変更（P7-2 カーブ・P7-5 降格）は **TDD**（テスト先行、赤→緑）。
- 検証ゲート（各タスク完了時に該当分を実行）:
  - `cd app && bun test`
  - `cd app && bun run typecheck`
  - `cd app/client && bun run build`
  - client のテストを変更した場合のみ `cd app/client && bun test`
- コミット規約: Conventional Commits（`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`）。**1 タスク 1 コミット**。
- 数値の一元定義: 難易度に関わる数値定数は `app/server/progression.ts` に集約する（ファイル冒頭コメントの規約「数値はすべてここで一元定義する — 他ファイルに複製しない」に従う）。
- ブランチ: `feat/p7-difficulty`（作成済み・main=6a0e37a・v0.12.1）。
- 既存ユーザー無影響の原則: `user_progress`（id=1）行は初回のみ `INSERT OR IGNORE ... VALUES (1, DEFAULT_LEVEL, ...)` で作られる（`progress-store.ts:72-78` の `ensureRow`）。既に行があるユーザーの `getLevel()`/`getSummary()` は保存済み level を返すため、**`DEFAULT_LEVEL` の変更は新規インストール（行がまだ無い状態）にのみ影響する**。

---

## File Structure

**サーバ（変更）**
- `app/server/progression.ts` — `DEFAULT_LEVEL`（13→5）、`fttFirstSec` の非線形カーブ、`stageAnchorLevel`（新規）、`demotionTargetLevel`（下 stage アンカーへ）、発話量シグナルの閾値定数（新規）。
- `app/server/progress-store.ts` — `makeProgressStore` に発話量シグナル provider を注入（既定 no-op）。`DownRationale` に `lowOutputRounds` 追加。`computeProposal` の降格分岐に低産出トリガを追加。
- `app/server/session-log.ts` — `fttOutputSignals(today, days, dir)`（新規・`round_end` 集計、新規テーブルなし）。
- `app/server/content-gen.ts` — `genScenarios(deps)`（新規・固定プラン生成。`genListening` に倣う）。
- `app/server/index.ts` — `makeProgressStore` に実 signal provider を配線。
- `scripts/generate-content.ts` — `scenarios` サブコマンド追加。

**サーバ（テスト更新）**
- `app/server/__tests__/progression.test.ts` — `DEFAULT_LEVEL`・カーブ・`demotionTargetLevel` の期待値。
- `app/server/__tests__/progress-store.test.ts` — 既定 level・降格 toLevel・placementSet・低産出シグナル。
- `app/server/__tests__/menu.test.ts` — 既定 level 由来の `roundsSec` リテラルとコメント。
- `app/server/__tests__/session-log.test.ts` — `fttOutputSignals`。
- `app/server/__tests__/content-gen.test.ts` — `genScenarios` の検証・ラウンドトリップ。
- `app/server/__tests__/scenarios-coverage.test.ts`（新規）— 実シナリオの stage1 帯カバレッジ。

**クライアント（変更）**
- `app/client/src/i18n.ts` — 追加文言（EN/JA）と型。
- `app/client/src/screens/FourThreeTwoScreen.tsx` — prep のマイク説明、ラウンドの上限文言・中立 timeUp、ラウンド中の折りたたみチャンク。
- `app/client/src/screens/StartScreen.tsx` — 測定 callout（new）に既定 Lv 開示 1 行。
- `app/client/src/screens/SentencesScreen.tsx` — 新規/日セレクタ（3/5/10, localStorage）。
- `app/client/src/screens/PracticeTab.tsx` — `newPerDay` prop 受け取り、復習セット区切り。
- `app/client/src/api/progress.ts` — `LevelProposal.rationale` に `lowOutputRounds?`。

---

## Task 1: 出だし負荷の是正 — 既定レベル 5 & 4/3/2 秒数カーブの非線形化（サーバ・TDD）

**対応所見:** Minor-13/14（既定 Lv13 は重い開始点）・Minor-17（stage1〜3 の秒数差がほぼない）。P7-1（サーバ分）+ P7-2（カーブ）。

**Files:**
- Modify: `app/server/progression.ts:11`（`DEFAULT_LEVEL`）, `:25-28`（`fttFirstSec`）
- Test: `app/server/__tests__/progression.test.ts:20-37,60-64`
- Test: `app/server/__tests__/progress-store.test.ts:12-24,244-259,262-288`
- Test: `app/server/__tests__/menu.test.ts:262-270,287-294,338-349,440-467,517-527`

**Interfaces:**
- Consumes: 既存 `stageOf`, `round5`, `fttRoundsSec`, `fttMiniRoundsSec`。
- Produces: `DEFAULT_LEVEL = 5`（stage1）。新カーブ `fttFirstSec(level)`（Lv1=60・Lv5=80・Lv10=100・Lv11=105・Lv13=110・Lv21=125・Lv60=180、単調非減少・180 頭打ち）。`fttRoundsSec`/`fttMiniRoundsSec` のシグネチャは不変（`fttFirstSec` の内部差し替えのみ）。

**設計判断（秒数カーブの具体式）:** 制御点 `(level, first-round秒)` = `[1,60] [11,105] [21,125] [31,145] [41,160] [51,172] [60,180]` を区間線形補間し `round5` で丸める。stage1 は 60 秒開始（真の初学者の負荷を下げる）、Lv11=105・Lv13=110 は現行と同値（既存ユーザー体感を維持）、Lv60=180 の上限を維持。丸め順序は現行踏襲（丸めた first に 0.75/0.5 を掛けて再 `round5`）なので `fttMiniRoundsSec`（`slice(0,2)`）も自動整合。

- [ ] **Step 1: progression.test の期待値を新カーブ・新既定に更新（赤）**

`app/server/__tests__/progression.test.ts` の該当ブロックを次に置き換える:

```ts
describe("progression: fttRoundsSec", () => {
  test("stage駆動の非線形カーブ（丸め順序込みの検算値）", () => {
    expect(fttRoundsSec(1)).toEqual([60, 45, 30]);
    expect(fttRoundsSec(5)).toEqual([80, 60, 40]);   // DEFAULT_LEVEL(stage1)
    expect(fttRoundsSec(10)).toEqual([100, 75, 50]);
    expect(fttRoundsSec(11)).toEqual([105, 80, 55]); // stage2 開始（現行と同値）
    expect(fttRoundsSec(13)).toEqual([110, 85, 55]); // 既存ユーザー帯（現行と同値）
    expect(fttRoundsSec(21)).toEqual([125, 95, 65]);
    expect(fttRoundsSec(60)).toEqual([180, 135, 90]); // 上限維持
  });
  test("Lv61以降は難易度据え置き（Lv60と同値）", () => {
    expect(fttRoundsSec(61)).toEqual(fttRoundsSec(60));
    expect(fttRoundsSec(100)).toEqual(fttRoundsSec(60));
  });
  test("ミニ版は先頭2ラウンド", () => {
    expect(fttMiniRoundsSec(13)).toEqual([110, 85]);
    expect(fttMiniRoundsSec(21)).toEqual([125, 95]);
  });
});
```

同ファイルの `DEFAULT_LEVEL` テストを置き換える:

```ts
  test("DEFAULT_LEVEL は 5（stage 1・測定しない初学者の出だしを軽くする）", () => {
    expect(DEFAULT_LEVEL).toBe(5);
    expect(stageOf(DEFAULT_LEVEL)).toBe(1);
  });
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `cd app && bun test progression.test.ts`
Expected: FAIL（`fttRoundsSec(1)` は現行 `[90,70,45]`、`DEFAULT_LEVEL` は 13）

- [ ] **Step 3: progression.ts を実装**

`app/server/progression.ts` の `DEFAULT_LEVEL` を変更:

```ts
/** プレースメント未実施時の開始レベル（stage 1 の代表アンカー=stageAnchorLevel(1)。出だしの負荷を下げる） */
export const DEFAULT_LEVEL = 5;
```

`fttFirstSec` を制御点補間に差し替える（`:25-28` を置換）:

```ts
/** 4/3/2 初回ラウンド秒の制御点 (level, sec)。区間線形補間・round5。単調非減少・Lv60 で 180 頭打ち。
 *  stage1=60秒開始（初学者の負荷減）、Lv11/13 は現行同値（既存体感維持）。 */
const FTT_FIRST_SEC_POINTS: ReadonlyArray<readonly [number, number]> = [
  [1, 60], [11, 105], [21, 125], [31, 145], [41, 160], [51, 172], [60, 180],
];

/** 4/3/2 の初回ラウンド秒。制御点間を線形補間して round5 で丸める */
function fttFirstSec(level: number): number {
  const L = Math.min(Math.max(level, 1), 60);
  const pts = FTT_FIRST_SEC_POINTS;
  for (let i = 0; i < pts.length - 1; i++) {
    const [l0, s0] = pts[i];
    const [l1, s1] = pts[i + 1];
    if (L <= l1) return round5(s0 + ((L - l0) / (l1 - l0)) * (s1 - s0));
  }
  return round5(pts[pts.length - 1][1]);
}
```

- [ ] **Step 4: 実行して緑を確認**

Run: `cd app && bun test progression.test.ts`
Expected: PASS

- [ ] **Step 5: progress-store.test を新既定に更新**

`app/server/__tests__/progress-store.test.ts` の「初回は…初期化される」テスト（12-24 行付近）:

```ts
  test("初回は DEFAULT_LEVEL=5・xp0 で初期化される", () => {
    const { store } = freshStore();
    const s = store.getSummary(T);
    expect(s.level).toBe(5);
    expect(s.xp).toBe(0);
    expect(s.xpIntoLevel).toBe(0);
    expect(s.xpToNext).toBe(20); // needXp(5)=15+5*stageOf(5)=20
    expect(s.stage).toBe(1);
    expect(s.difficultyMaxed).toBe(false);
    expect(s.proposal).toBeNull();
    expect(store.getLevel()).toBe(5);
  });
```

「同一レベルへの set は no-op」テスト（244-259 行付近）は現行 level(=既定)を前提にしているので `13` を `5` に置換する:

```ts
  test("同一レベルへの set は no-op（xpIntoLevel維持・level_events未記録）", () => {
    const { db, store } = freshStore();
    store.addXp("block", 10, {}, T); // xpIntoLevel を 0 以外にしておく
    const before = store.getSummary(T);
    expect(before.level).toBe(5);
    expect(before.xpIntoLevel).toBe(10);
    const countBefore = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM level_events").get()!.n;

    const s = store.levelAction("set", 5, T)!;
    expect(s.levelChanged).toBe(false);

    expect(s.summary.level).toBe(5);
    expect(s.summary.xpIntoLevel).toBe(10); // リセットされない
    const countAfter = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM level_events").get()!.n;
    expect(countAfter).toBe(countBefore); // level_events 行が増えない
  });
```

placementSet ブロック（262-288 行付近）で既定 level 13 に依存している 2 箇所を更新する。「placement-set が記録される」テストの `from_level` 期待値を `13` → `5`:

```ts
    expect(ev).toEqual({ kind: "placement-set", from_level: 5, to_level: 23 });
```

「同一レベルは no-op」テストの `placementSet(13)` を `placementSet(5)` に置換（既定 level と同値で no-op を検証する意図を維持）:

```ts
    store.addXp("block", 6, {}, "2026-07-06"); // xpIntoLevel=6
    const s = store.placementSet(5, "2026-07-06");
    expect(s!.levelChanged).toBe(false);
    expect(s!.summary.xpIntoLevel).toBe(6);
```

- [ ] **Step 6: menu.test を新既定・新カーブに更新**

`app/server/__tests__/menu.test.ts` の該当箇所を更新する。

262-270 行（既定 level 由来の roundsSec、level 未指定でビルド）:

```ts
  test("60分・30分とも roundsSec は DEFAULT_LEVEL(5) から計算される [80, 60, 40]", () => {
    const dirs = makeContentDirs();
    const m60 = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const ftt60 = m60.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt60.params.roundsSec).toEqual([80, 60, 40]);
    const m30 = buildTodayMenu(30, { ...dirs, today: JULY5 });
    const ftt30 = m30.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt30.params.roundsSec).toEqual([80, 60, 40]);
  });
```

287-294 行（ftt-mini・既定 level 由来）:

```ts
  test("ftt-mini: four-three-two・8分・roundsSec=[80,60]（DEFAULT_LEVEL=5から計算）", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const m = buildQuickMenu("ftt-mini", deps);
    expect(m.minutes).toBe(8);
    expect(m.blocks[0].kind).toBe("four-three-two");
    expect(m.blocks[0].params.roundsSec).toEqual([80, 60]);
  });
```

344 行のコメントのみ更新（挙動＝帯域外フォールバックは不変。s1 は level `[5,6]` で stage1 でも帯域外なので選択結果は同じ）:

```ts
    // DEFAULT_LEVEL=5 → stage1。business は帯域外の s1 のみ → フォールバックで s1 が選ばれる
```

441-445 行（level 21 明示）:

```ts
  test("roundsSec はレベルから計算される（level 21 → [125,95,65]）", () => {
    const dirs = makeContentDirs();
    const m = buildTodayMenu(60, { ...dirs, level: 21, today: () => new Date("2026-07-06T09:00:00") });
    const ftt = m.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt.params.roundsSec).toEqual([125, 95, 65]);
  });
```

464 行は level 13 明示で `[110, 85, 55]` のまま**変更不要**（新カーブでも Lv13 は同値）。

524 行（level 21 明示、無効化後の再構築）:

```ts
    expect(f2.params.roundsSec).toEqual([125, 95, 65]); // 新レベルが即時反映される
```

- [ ] **Step 7: サーバ全体で緑を確認**

Run: `cd app && bun test`
Expected: PASS（progression / progress-store / menu すべて）

Run: `cd app && bun run typecheck`
Expected: エラーなし

- [ ] **Step 8: コミット**

```bash
git add app/server/progression.ts app/server/__tests__/progression.test.ts app/server/__tests__/progress-store.test.ts app/server/__tests__/menu.test.ts
git commit -m "feat: 既定Lvを5(stage1)に下げ4/3/2秒数をstage駆動の非線形カーブに"
```

---

## Task 2: 難易度 UI の情報的文言と足場（クライアント・i18n）

**対応所見:** Minor-13（既定 Lv 開示）・Minor-17 / 未検証minor「時間切れ文言」「早く終えてよい明文化」・Major-8（🎙が起点であることの無説明）・未検証minor「ラウンド中に準備チャンクが消える」。P7-1（開示）+ P7-2（上限文言・中立 timeUp）+ P7-3（マイク説明・折りたたみチャンク）。

**Files:**
- Modify: `app/client/src/i18n.ts:137-150`（`Ftt432Strings` 型）, `:349-362`（EN ftt432）, `:563-576`（JA ftt432）, `:84-87`（placement 型）, `:265-266`（EN placement）, `:478-479`（JA placement）
- Modify: `app/client/src/screens/FourThreeTwoScreen.tsx:246-312`（prep）, `:345-378`（round stage）
- Modify: `app/client/src/screens/StartScreen.tsx:156,228-245`（PlacementCallout）

**Interfaces:**
- Consumes: `STR[lang].ftt432`, `STR[lang].placement`, `useSupport`（既存）, `ChunkList`（既存 `app/client/src/ui/ChunkList`）, `showJaFromPrep`（既存）。
- Produces: 新 i18n キー `ftt432.prepMicNote` / `ftt432.roundTimeboxNote` / `ftt432.roundChunksToggle`、変更 `ftt432.timeUp`（中立化）、新 `placement.startDefaultNote`。

- [ ] **Step 1: i18n 型に新キーを追加**

`app/client/src/i18n.ts` の `Ftt432Strings`（137-150 行）に 3 キーを追加する（`timeUp` は既存・値だけ後で変える）:

```ts
  prepIntro: (rounds: string, count: number, prep: string) => string;
  prepMicNote: string; roundTimeboxNote: string; roundChunksToggle: string;
  prepTimerNote: string; loading: string; retry: string; outlineTitle: string;
```

`placement` 型（84-87 行付近、`cardTitleNew` の並び）に追加する:

```ts
    cardTitleNew: string; cardBodyNew: string; startDefaultNote: string;
```

- [ ] **Step 2: EN 文言を追加・変更**

`app/client/src/i18n.ts` の EN `ftt432`（349-362 行）に追記し、`timeUp` を中立化する:

```ts
      prepIntro: (rounds, count, prep) => `You'll tell the same story ${count} times: ${rounds}. First, look over some phrases and an outline (about ${prep}).`,
      prepMicNote: "Press 🎙 to start speaking — the timer starts then. Your Round 1 recording gets coach feedback before Round 2.",
      roundTimeboxNote: "This time is a cap — if you finish sooner, that's great.",
      roundChunksToggle: "Prep phrases",
```

```ts
      timeUp: "— Time reached", recStop: "⏹ Stop recording", recTranscribing: "📝 Transcribing…",
```

EN `placement`（265-266 行）に追記:

```ts
      cardTitleNew: "Find your level (10 min)",
      cardBodyNew: "Three short speaking tasks set your starting level",
      startDefaultNote: "No test? You'll start at Lv 5 — you can change it anytime.",
```

- [ ] **Step 3: JA 文言を追加・変更**

JA `ftt432`（563-576 行）:

```ts
      prepIntro: (rounds, count, prep) => `これから同じ話を ${rounds} で${count}回話します。まず使えそうな表現と骨組みを確認してください（目安 ${prep}）。`,
      prepMicNote: "🎙を押して話し始めるとタイマーが動きます。Round 1 の録音には Round 2 の前にコーチのフィードバックが付きます。",
      roundTimeboxNote: "時間は上限です。言えたところまでで早く終えてもOKです。",
      roundChunksToggle: "準備の表現チャンク",
```

```ts
      timeUp: "— 目安の時間になりました", recStop: "⏹ 録音を止める", recTranscribing: "📝 文字起こし中…",
```

JA `placement`（478-479 行）:

```ts
      cardTitleNew: "レベル測定（10分）",
      cardBodyNew: "3つの短いスピーキングで開始レベルを決めます",
      startDefaultNote: "測定しない場合は Lv5 から始まります（いつでも変更できます）。",
```

- [ ] **Step 4: prep 画面にマイク説明を追加**

`app/client/src/screens/FourThreeTwoScreen.tsx` の prep フェーズ、`prepIntro` の段落（251-253 行）の直後に追記する:

```tsx
          <p className="text-muted">
            {t.prepIntro(roundsSec.map((s) => t.min(minNum(s))).join("→"), roundsSec.length, t.min(minNum(PREP_SECONDS)))}
          </p>
          <p className="text-sm text-muted">{t.prepMicNote}</p>
```

- [ ] **Step 5: ラウンド画面に上限文言・中立 timeUp・折りたたみチャンクを追加**

同ファイルの round stage（345-378 行の `return (<div className="round-stage">…`）を次に置き換える。`prep`（コンポーネント state）は prep フェーズ後も保持されているので、ラウンド中も同じチャンクを既定折りたたみで参照できる。研究制約適合のため既定は畳んだ状態（`<details>` に `open` を付けない）:

```tsx
  return (
    <div className="round-stage">
      <h3>
        {t.roundHeading(roundIndex + 1, t.min(minNum(roundsSec[roundIndex])), props.topic.title)}
      </h3>
      <p className="text-muted">{LISTENERS[roundIndex % LISTENERS.length]}</p>
      <ul className="text-sm text-muted">
        {props.topic.hints.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
      {prep && (() => {
        const filteredChunks = prep.chunks.filter((c) => typeof c.en === "string" && c.en);
        if (filteredChunks.length === 0) return null;
        const showJa = showJaFromPrep(support, prep);
        return (
          <details className="round-chunks">
            <summary className="text-sm text-muted">{t.roundChunksToggle}</summary>
            <ChunkList
              chunks={filteredChunks} playingIdx={playRow.playingKey} onPlay={(i, text) => playRow.play(i, text)} showJa={showJa}
              playAria={(en) => STR[props.lang].chunkList.playAria(en)}
            />
          </details>
        );
      })()}
      <div className={`round-timer${timer.expired ? " is-expired" : ""}`}>
        {formatMmSs(timer.remaining)} {timer.expired && <span className="text-sm">{t.timeUp}</span>}
      </div>
      <p className="text-sm text-muted">{t.roundTimeboxNote}</p>
      <div className="round-actions">
        <button
          className={`btn btn-primary btn-lg record-btn${recState === "recording" ? " is-recording" : ""}`}
          onClick={toggleRecording}
          disabled={recState === "transcribing"}
        >
          {recState === "recording" ? t.recStop : recState === "transcribing" ? t.recTranscribing : t.recStart}
        </button>
        <Button onClick={finishRound} disabled={recState === "transcribing"}>
          {t.roundFinish}
        </Button>
      </div>
      {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      {transcripts[roundIndex] && (
        <Card className="reading-text">
          <strong>You:</strong> {transcripts[roundIndex]}
        </Card>
      )}
    </div>
  );
```

（`ChunkList`・`showJaFromPrep`・`support`・`playRow` はいずれもこのファイルで既に import / 定義済み。追加 import は不要。）

- [ ] **Step 6: 測定 callout（new）に既定 Lv 開示を追加**

`app/client/src/screens/StartScreen.tsx` の `PlacementCallout`（228-245 行）で、`kind === "new"` のときだけ開示 1 行を出す。`drill-desc` の直後に追記する:

```tsx
      <span className="drill-body">
        <span className="drill-title">{kind === "new" ? tp.cardTitleNew : tp.cardTitleMonthly}</span>
        <span className="drill-desc">{kind === "new" ? tp.cardBodyNew : tp.cardBodyMonthly}</span>
        {kind === "new" && <span className="drill-desc text-sm text-muted">{tp.startDefaultNote}</span>}
      </span>
```

- [ ] **Step 7: 型チェックとビルド**

Run: `cd app && bun run typecheck`
Expected: エラーなし（i18n の EN/JA 両系統に新キーが揃っていること＝どちらか欠けると `STR` の型不一致で失敗する）

Run: `cd app/client && bun run build`
Expected: 成功

- [ ] **Step 8: コミット**

```bash
git add app/client/src/i18n.ts app/client/src/screens/FourThreeTwoScreen.tsx app/client/src/screens/StartScreen.tsx
git commit -m "feat: 4/3/2に上限文言・マイク説明・ラウンド中の折りたたみチャンクと既定Lv開示を追加"
```

---

## Task 3: 例文の新規/日をローカル設定に（3/5/10・クライアント）

**対応所見:** Major-4（新規 10 枚/日固定で 4 週目に膨張）。P7-4 前半。

**設計判断（サーバ側要否）:** **サーバ変更不要**。`GET /api/sentences/queue` は既に `new`（0〜50）を受け取り（`routes/sentences.ts:16-19`）、`fetchSentenceQueue(newCount)` が `?new=` で渡す（`api/sentences.ts:55-56`）。よってクライアントで選んだ値を渡すだけの **additive** 変更。

**Files:**
- Modify: `app/client/src/screens/SentencesScreen.tsx:7-8,27-48,63-74,76`
- Modify: `app/client/src/screens/PracticeTab.tsx:16,19,21`
- Modify: `app/client/src/i18n.ts`（`sentences` 型 + EN/JA に `newPerDayLabel`）

**Interfaces:**
- Consumes: 既存 localStorage トグル流儀（`sentences.hideNote` / `sentences.audioFirst`）、`fetchSentenceQueue(newCount)`。
- Produces: localStorage キー `sentences.newPerDay`（許容値 3/5/10、既定 10）。`PracticeTab` に `newPerDay: number` prop 追加。i18n `sentences.newPerDayLabel`。

- [ ] **Step 1: i18n に newPerDay ラベルを追加**

`app/client/src/i18n.ts` の `SentencesStrings` 型（`remaining`/`doneTitle` 等がある `sentences` ブロック）に追加する:

```ts
    newPerDayLabel: string;
```

EN `sentences`（`remaining` 付近、298 行前後）に:

```ts
      newPerDayLabel: "New/day",
```

JA `sentences`（511 行前後）に:

```ts
      newPerDayLabel: "1日の新規",
```

- [ ] **Step 2: PracticeTab を newPerDay prop 化**

`app/client/src/screens/PracticeTab.tsx` の固定定数を prop に置き換える。16 行の `const NEW_PER_DAY = 10;` を削除し、props と `useLoad` を変更する:

```tsx
export function PracticeTab({ lang, hideNote, clozeDefault, audioFirst = false, newPerDay }: { lang: Lang; hideNote: boolean; clozeDefault: boolean; audioFirst?: boolean; newPerDay: number }) {
  const t = STR[lang].sentences;
  const load = useLoad(() => fetchSentenceQueue(newPerDay));
```

- [ ] **Step 3: SentencesScreen に newPerDay セレクタを追加**

`app/client/src/screens/SentencesScreen.tsx` の localStorage ヘルパ群（7-25 行）に追加する:

```ts
const NEW_PER_DAY_KEY = "sentences.newPerDay";
const NEW_PER_DAY_OPTIONS = [3, 5, 10] as const;

function loadNewPerDay(): number {
  const v = Number(localStorage.getItem(NEW_PER_DAY_KEY));
  return (NEW_PER_DAY_OPTIONS as readonly number[]).includes(v) ? v : 10;
}

function saveNewPerDay(v: number): void {
  localStorage.setItem(NEW_PER_DAY_KEY, String(v));
}
```

state を追加する（`audioFirst` の隣、31 行付近）:

```tsx
  const [newPerDay, setNewPerDay] = useState(() => loadNewPerDay());
```

practice タブのツールバー（63-74 行の `{tab === "practice" && (…)}` 内、`audioFirst` ラベルの後）にセレクタを追加する:

```tsx
            <label className="hide-note-toggle text-sm text-muted">
              {t.newPerDayLabel}
              <select
                value={newPerDay}
                onChange={(e) => { const v = Number(e.target.value); saveNewPerDay(v); setNewPerDay(v); }}
              >
                {NEW_PER_DAY_OPTIONS.map((n) => (<option key={n} value={n}>{n}</option>))}
              </select>
            </label>
```

`PracticeTab` に prop を渡す（76 行）:

```tsx
      {tab === "practice" ? <PracticeTab lang={lang} hideNote={hideNote} clozeDefault={clozeDefault} audioFirst={audioFirst} newPerDay={newPerDay} /> : <BrowseTab lang={lang} />}
```

- [ ] **Step 4: 型チェックとビルド**

Run: `cd app && bun run typecheck`
Expected: エラーなし

Run: `cd app/client && bun run build`
Expected: 成功

- [ ] **Step 5: コミット**

```bash
git add app/client/src/screens/SentencesScreen.tsx app/client/src/screens/PracticeTab.tsx app/client/src/i18n.ts
git commit -m "feat: 例文の新規/日を3/5/10のローカル設定に（既定10・サーバ変更なし）"
```

---

## Task 4: 復習のセット区切り（20 枚・表示のみ・クライアント）

**対応所見:** Major-3（数日空けて戻ると復習が一括で積み上がる「復習の壁」）。P7-4 後半。実施順の注記（監査 §付記）に従い、C1（セット区切り）を先に入れておくと将来の due 可視化が巨大数字にならずに済む。

**設計判断:** **SRS の間隔ロジック・grade 経路は完全不変**。`sentences.queue()`（`sentences.ts:126-139`）が返す `[復習…, 新規…]` の配列を、クライアントが 20 件ごとの「セット」に区切って表示するだけ。セット完了時に情報的な区切り画面（判定・連続日数・警告なし）を挟み、「続ける」で次セットへ。

**Files:**
- Modify: `app/client/src/screens/PracticeTab.tsx:22-37,97-107,108-110`
- Modify: `app/client/src/i18n.ts`（`sentences` 型 + EN/JA に `setDone` / `setContinue` / `setNote`）

**Interfaces:**
- Consumes: 既存 `queue`（`QueueItem[]`）、`idx`、`gradedCount`。
- Produces: 定数 `SET_SIZE = 20`。i18n `sentences.setDone(remaining)` / `sentences.setContinue` / `sentences.setNote`。

- [ ] **Step 1: i18n にセット区切り文言を追加**

`app/client/src/i18n.ts` の `sentences` 型に追加する:

```ts
    setDone: (remaining: number) => string;
    setContinue: string;
    setNote: string;
```

EN `sentences`:

```ts
      setDone: (remaining) => `Set complete ✅ — ${remaining} more to go`,
      setContinue: "Continue",
      setNote: "Do the rest now or later — either is fine.",
```

JA `sentences`:

```ts
      setDone: (remaining) => `今日のセット完了 ✅ — 続きが ${remaining} 文あります`,
      setContinue: "続ける",
      setNote: "続きは今でも後でもOKです。",
```

- [ ] **Step 2: PracticeTab にセット境界の状態と表示を追加**

`app/client/src/screens/PracticeTab.tsx` に定数と state を足す。`initialPhase` import の下（15 行付近）:

```tsx
const SET_SIZE = 20;
```

state 群（`gradedCount` の隣、24 行付近）:

```tsx
  const [continuedSets, setContinuedSets] = useState(0);
```

`done` 判定（37 行付近）の直後に、セット境界の派生値を追加する:

```tsx
  const queue = load.state.status === "ready" ? load.state.data : [];
  const current = queue[idx];
  const done = load.state.status === "ready" && !current;
  // セット境界: idx が SET_SIZE の倍数（>0）に到達し、まだ後続があり、このセットをまだ「続ける」していない
  const atSetBoundary = !done && idx > 0 && idx % SET_SIZE === 0 && idx / SET_SIZE > continuedSets;
```

`done` の描画分岐（97-107 行）の**直前**にセット完了画面を挿入する:

```tsx
  if (atSetBoundary) {
    return (
      <Card>
        <p className="sentence-done">{t.setDone(queue.length - idx)}</p>
        <p className="text-muted">{t.setNote}</p>
        <Button variant="primary" size="lg" onClick={() => setContinuedSets(idx / SET_SIZE)}>
          {t.setContinue}
        </Button>
      </Card>
    );
  }
  if (done) {
```

（`done` の全消化画面・`remaining` 行・grade 経路は現行のまま。セット完了画面は表示の区切りのみで、`grade()`／SRS 遷移には一切触れない。）

- [ ] **Step 3: 型チェックとビルド**

Run: `cd app && bun run typecheck`
Expected: エラーなし

Run: `cd app/client && bun run build`
Expected: 成功

- [ ] **Step 4: コミット**

```bash
git add app/client/src/screens/PracticeTab.tsx app/client/src/i18n.ts
git commit -m "feat: 復習キューを20枚のセットに区切り情報的なセット完了画面を挟む（SRSロジック不変）"
```

---

## Task 5: 降格先を下 stage の開始アンカーへ（サーバ・TDD）

**対応所見:** Major-6（受諾しても Lv13→10 は 5 秒差で緩和を体感できない）。P7-5 前半。承認制・根拠開示・「XP は減りません」の現行フローは維持。

**設計判断（降格アンカー）:** 各 stage の代表アンカー = `(stage-1)*10 + 5`（stage1→5・stage2→15・…・stage6→55）を導入する。降格先は「一つ下の stage の開始アンカー」= `stageAnchorLevel(stageOf(level) - 1)`。例: Lv13(stage2)→**Lv5**（現行 Lv10 から体感差を作る。秒数 110→80・チャンク 7→8・stage1 の語彙制約が有効化）。Lv23(stage3)→Lv15、Lv75(stage6)→Lv45。DEFAULT_LEVEL=5 は `stageAnchorLevel(1)` と一致する（stage1 の出だしと降格先が同じアンカーに揃う）。

**Files:**
- Modify: `app/server/progression.ts:72-75`（`demotionTargetLevel` + 新規 `stageAnchorLevel`）
- Test: `app/server/__tests__/progression.test.ts:60-72`
- Test: `app/server/__tests__/progress-store.test.ts:158-227`

**Interfaces:**
- Consumes: `stageOf`。
- Produces: `stageAnchorLevel(stage: number): number`。`demotionTargetLevel(level)` は下 stage アンカーを返すよう変更（シグネチャ不変）。

- [ ] **Step 1: progression.test を新アンカーに更新（赤）**

`app/server/__tests__/progression.test.ts` の「降格先」テスト（68-72 行）を置き換える:

```ts
  test("降格先は一つ下のstageの開始アンカー（例: Lv23→15、Lv13→5、Lv75→45）", () => {
    expect(demotionTargetLevel(23)).toBe(15);
    expect(demotionTargetLevel(13)).toBe(5);
    expect(demotionTargetLevel(75)).toBe(45);
  });
  test("stageAnchorLevel は各stageの代表アンカー（(stage-1)*10+5）", () => {
    expect(stageAnchorLevel(1)).toBe(5);
    expect(stageAnchorLevel(2)).toBe(15);
    expect(stageAnchorLevel(6)).toBe(55);
  });
```

import 行（3-5 行）に `stageAnchorLevel` を追加する:

```ts
import {
  BOUNDARY_LEVELS, DEFAULT_LEVEL, demotionTargetLevel, fttMiniRoundsSec, fttRoundsSec,
  needXp, PLACEMENT_XP, prepParams, stageAnchorLevel, stageOf, vocabConstraint, xpForGrade,
} from "../progression";
```

- [ ] **Step 2: 実行して失敗を確認**

Run: `cd app && bun test progression.test.ts`
Expected: FAIL（`demotionTargetLevel(23)` は現行 20・`stageAnchorLevel` 未定義）

- [ ] **Step 3: progression.ts を実装**

`app/server/progression.ts` の `demotionTargetLevel`（72-75 行）を置き換える:

```ts
/** stage(1..6) の代表アンカーレベル（各stageの下寄り中央）。降格先・既定開始レベルの基準。 */
export function stageAnchorLevel(stage: number): number {
  const s = Math.min(Math.max(Math.trunc(stage), 1), 6);
  return (s - 1) * 10 + 5; // stage1→5, stage2→15, ..., stage6→55
}

/** 降格承認時の移動先: 一つ下の stage の開始アンカー（体感差を作る）。stage1 では呼ばない前提（提案側で抑止） */
export function demotionTargetLevel(level: number): number {
  return stageAnchorLevel(stageOf(level) - 1);
}
```

- [ ] **Step 4: progress-store.test の降格 toLevel を更新**

`app/server/__tests__/progress-store.test.ts` の降格ブロック（158-227 行）で、Lv23 起点の降格先 `20` を `15` に更新する。3 箇所:

「完了率<40% で down 提案」（165 行付近）:

```ts
    expect(p.toLevel).toBe(15);
```

「承認で現ステージ最下端の1つ下へ」→ 表現も更新（195-205 行付近）:

```ts
  test("承認で一つ下のstageアンカーへ・XPは減らない", () => {
    const { db, store } = freshStore();
    store.levelAction("set", 23, T);
    store.addXp("block", 10, {}, T);
    for (let i = 0; i < 5; i++) seedAttempt(db, "2026-07-04", "roleplay", 0);
    const s = store.levelAction("accept", undefined, T)!;
    expect(s.summary.level).toBe(15);
    expect(s.summary.xp).toBe(10); // 累積XPは不変
    expect(s.summary.xpIntoLevel).toBe(0);
    expect(s.levelChanged).toBe(true);
  });
```

「accept-down の level_events」（206-216 行付近）の `to_level` を `15` に:

```ts
    const s = store.levelAction("accept", undefined, T)!;
    expect(s.summary.level).toBe(15);
    const row = db.query<{ kind: string; from_level: number; to_level: number }, []>(
      "SELECT kind, from_level, to_level FROM level_events WHERE kind = 'accept-down' ORDER BY id DESC LIMIT 1").get()!;
    expect(row.from_level).toBe(23);
    expect(row.to_level).toBe(15);
```

（「stage1 では降格提案しない」テストの `set(5)`・6 件 seed はそのまま有効＝既定と同じ stage1 で提案されないことを確認。）

- [ ] **Step 5: サーバ全体で緑を確認**

Run: `cd app && bun test`
Expected: PASS

Run: `cd app && bun run typecheck`
Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add app/server/progression.ts app/server/__tests__/progression.test.ts app/server/__tests__/progress-store.test.ts
git commit -m "feat: 降格先を一つ下のstage開始アンカーに変更し体感差を作る"
```

---

## Task 6: 降格シグナルに 4/3/2 の実測発話量を追加（サーバ・TDD）

**対応所見:** Major-6（「完走するが苦しい」層に降格が発火しない — 完了=クリックで完了率が常に 100%）。P7-5 後半。承認制フローは維持。

**設計判断（実データ構造）:** `round_end` イベントは既に `meta = { blockId, block: "four-three-two", round, aborted?, transcript, elapsedSec }` を session ログ（`SESSIONS_DIR/<ymd>.jsonl`）に記録している（`FourThreeTwoScreen.tsx:114-122,205-211`。生成経路 `routes/session.ts`）。**新規テーブルは作らない**。「時間はかけたのに発話が極端に短い」ラウンド（= `elapsedSec >= FTT_ENGAGED_SEC` かつ 語数 `< FTT_WORDS_FLOOR`）を直近 7 日で数え、一定数を超えたら降格提案の材料に加える。これは block_attempts の完了/中断（既存シグナル）では拾えない「完走するが苦しい」層を捕捉する。`round_end` に当時のレベル別目標秒は保存されていないため、「目標比」ではなくレベル非依存の絶対フロア（`elapsedSec`＋語数）で判定する。閾値は `progression.ts` に一元定義する。

`makeProgressStore` に signal provider を注入する（既定 no-op なので既存テスト・既存呼び出しは無影響）。`index.ts` で `fttOutputSignals` を配線する。

**Files:**
- Modify: `app/server/progression.ts`（`FTT_ENGAGED_SEC` / `FTT_WORDS_FLOOR` 追加）
- Modify: `app/server/session-log.ts`（`fttOutputSignals` 追加）
- Modify: `app/server/progress-store.ts:8-11,33-39,67,135-152`（`DownRationale` / 閾値 / 注入 / 降格分岐）
- Modify: `app/server/index.ts:15,32`（配線）
- Modify: `app/client/src/api/progress.ts:6`（rationale 型）
- Modify: `app/client/src/screens/StartScreen.tsx:254-260`（rationale 行）
- Modify: `app/client/src/i18n.ts`（`progress` 型 + EN/JA `lowOutput`）
- Test: `app/server/__tests__/session-log.test.ts`
- Test: `app/server/__tests__/progress-store.test.ts`

**Interfaces:**
- Consumes: `readEvents`, `addDaysYmd`（`dates.ts`）, `SESSIONS_DIR`, `FTT_ENGAGED_SEC`, `FTT_WORDS_FLOOR`。
- Produces: `fttOutputSignals(today: string, days?: number, dir?: string): { lowRounds: number; totalRounds: number }`。`makeProgressStore(db, fttSignals?)` — `fttSignals: (today: string) => { lowRounds: number; totalRounds: number }`（既定 `() => ({ lowRounds: 0, totalRounds: 0 })`）。`DownRationale` に `lowOutputRounds: number` 追加。

- [ ] **Step 1: 閾値を progression.ts に追加**

`app/server/progression.ts` の末尾（`PLACEMENT_XP` の下）に追加する:

```ts
/** 4/3/2「低産出ラウンド」判定: この秒数以上取り組んで（engaged）、語数がフロア未満なら苦戦とみなす。降格シグナル用 */
export const FTT_ENGAGED_SEC = 20;
export const FTT_WORDS_FLOOR = 8;
```

- [ ] **Step 2: session-log.test に fttOutputSignals の失敗テストを書く（赤）**

`app/server/__tests__/session-log.test.ts` に追記する（既存の import と `appendEvent`/一時ディレクトリの流儀に合わせる。無ければ次を追加）:

```ts
import { fttOutputSignals } from "../session-log";
// 既存の appendEvent を使い、round_end を仕込む

describe("fttOutputSignals", () => {
  test("engagedかつ低語数のみ lowRounds に数える（block一致・elapsed/語数で判定）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sig-"));
    const file = path.join(dir, "2026-07-06.jsonl");
    const ev = (meta: Record<string, unknown>) =>
      appendEvent(file, { ts: "2026-07-06T09:00:00Z", type: "round_end", sessionId: "s", meta });
    ev({ block: "four-three-two", elapsedSec: 40, transcript: "well um yeah" });     // 3語 → low
    ev({ block: "four-three-two", elapsedSec: 40, transcript: "I think we should ship the feature today because it is ready" }); // 12語 → not low
    ev({ block: "four-three-two", elapsedSec: 5, transcript: "no" });                // engaged未満 → 数えるが low ではない
    ev({ block: "roleplay", elapsedSec: 40, transcript: "hi" });                     // 別block → 無視
    const r = fttOutputSignals("2026-07-06", 7, dir);
    expect(r.totalRounds).toBe(3); // four-three-two の3件
    expect(r.lowRounds).toBe(1);   // 1件目のみ
  });

  test("ログが無い日は 0/0", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "sig-"));
    expect(fttOutputSignals("2026-07-06", 7, dir)).toEqual({ lowRounds: 0, totalRounds: 0 });
  });
});
```

（ファイル冒頭に `mkdtempSync`/`tmpdir`/`path` の import が無ければ既存テストに倣って追加する。）

- [ ] **Step 3: 実行して失敗を確認**

Run: `cd app && bun test session-log.test.ts`
Expected: FAIL（`fttOutputSignals` 未定義）

- [ ] **Step 4: session-log.ts に fttOutputSignals を実装**

`app/server/session-log.ts` の import を拡張する（1-3 行付近）:

```ts
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { addDaysYmd } from "./dates";
import { FTT_ENGAGED_SEC, FTT_WORDS_FLOOR } from "./progression";
import { SESSIONS_DIR } from "./paths";
```

ファイル末尾に追加する:

```ts
/**
 * 直近 days 日の 4/3/2 `round_end` から発話量シグナルを集計する（降格提案の追加材料）。
 * lowRounds = 「engaged（elapsedSec>=FTT_ENGAGED_SEC）だが語数 < FTT_WORDS_FLOOR」のラウンド数。
 * elapsedSec/transcript は round_end に既に記録済みなので新規記録は不要。
 */
export function fttOutputSignals(
  today: string, days = 7, dir: string = SESSIONS_DIR,
): { lowRounds: number; totalRounds: number } {
  let lowRounds = 0, totalRounds = 0;
  for (let i = 0; i < days; i++) {
    const ymd = addDaysYmd(today, -i);
    for (const e of readEvents(path.join(dir, `${ymd}.jsonl`))) {
      if (e.type !== "round_end") continue;
      const m = e.meta as { block?: string; elapsedSec?: number; transcript?: string } | undefined;
      if (!m || m.block !== "four-three-two") continue;
      totalRounds++;
      const elapsed = typeof m.elapsedSec === "number" ? m.elapsedSec : 0;
      const words = (m.transcript ?? "").trim().split(/\s+/).filter(Boolean).length;
      if (elapsed >= FTT_ENGAGED_SEC && words < FTT_WORDS_FLOOR) lowRounds++;
    }
  }
  return { lowRounds, totalRounds };
}
```

Run: `cd app && bun test session-log.test.ts`
Expected: PASS

- [ ] **Step 5: progress-store.test に低産出降格の失敗テストを書く（赤）**

`app/server/__tests__/progress-store.test.ts` の降格ブロックに追加する。注入した fake signal で発火することを確認する（`freshStore` は既定 no-op のままなので、ここでは直接 `makeProgressStore` を使う）:

```ts
describe("progress-store: 低産出シグナルによる降格", () => {
  test("直近の4/3/2低産出ラウンドが閾値超で down 提案（rationaleにlowOutputRounds）", () => {
    const db = openDb(":memory:");
    const store = makeProgressStore(db, () => ({ lowRounds: 4, totalRounds: 6 }));
    store.levelAction("set", 23, T);
    const p = store.getSummary(T).proposal!;
    expect(p.kind).toBe("down");
    expect(p.toLevel).toBe(15);
    expect((p.rationale as { lowOutputRounds: number }).lowOutputRounds).toBe(4);
  });
  test("観測ラウンドが窓未満（totalRounds<6）なら発火しない", () => {
    const db = openDb(":memory:");
    const store = makeProgressStore(db, () => ({ lowRounds: 4, totalRounds: 5 }));
    store.levelAction("set", 23, T);
    expect(store.getSummary(T).proposal).toBeNull();
  });
  test("stage1 では低産出でも降格提案しない", () => {
    const db = openDb(":memory:");
    const store = makeProgressStore(db, () => ({ lowRounds: 6, totalRounds: 6 }));
    store.levelAction("set", 5, T);
    expect(store.getSummary(T).proposal).toBeNull();
  });
});
```

Run: `cd app && bun test progress-store.test.ts`
Expected: FAIL（`makeProgressStore` は 2 引数を受け取らず、低産出トリガも無い）

- [ ] **Step 6: progress-store.ts に注入と降格分岐を実装**

`DownRationale` に `lowOutputRounds` を追加（8-11 行付近）:

```ts
export type DownRationale = { completionRate: number | null; fttAborts: number; lowOutputRounds: number };
```

閾値定数を追加（33-39 行付近の他の `DEMOTE_*` の並び）:

```ts
const DEMOTE_LOW_OUTPUT_MIN = 4;      // この数以上の低産出ラウンドで降格材料に
const DEMOTE_LOW_OUTPUT_WINDOW = 6;   // 信頼するのに必要な観測ラウンド数（totalRounds 下限）
```

`makeProgressStore` のシグネチャに provider を追加（67 行）:

```ts
export function makeProgressStore(
  db: Database,
  fttSignals: (today: string) => { lowRounds: number; totalRounds: number } = () => ({ lowRounds: 0, totalRounds: 0 }),
): ProgressStore {
```

`computeProposal` の降格分岐（135-152 行）を置き換える:

```ts
  function computeProposal(row: ProgressRow, today: string): Proposal | null {
    // 降格（§5.2）
    if (stageOf(row.level) >= 2 && !inCooldown("decline-down", today)) {
      const week = completionRate7d(today);
      const ftt = fttAbortsLast5();
      const out = fttSignals(today);
      const lowCompletion = week.count >= DEMOTE_MIN_ATTEMPTS && week.rate !== null && week.rate < DEMOTE_MAX_COMPLETION;
      const manyAborts = ftt.count >= 5 && ftt.aborts >= DEMOTE_FTT_ABORTS;
      // 「完走するが苦しい」層: 完了/中断では拾えない、engagedだが極端に低語数のラウンドが続く状態
      const lowOutput = out.totalRounds >= DEMOTE_LOW_OUTPUT_WINDOW && out.lowRounds >= DEMOTE_LOW_OUTPUT_MIN;
      if (lowCompletion || manyAborts || lowOutput) {
        return {
          kind: "down",
          toLevel: demotionTargetLevel(row.level),
          rationale: { completionRate: week.rate, fttAborts: ftt.aborts, lowOutputRounds: out.lowRounds },
        };
      }
    }
    // 昇格（§5.1）
    if (BOUNDARY_LEVELS.includes(row.level) && row.xp_into_level >= needXp(row.level) && !inCooldown("decline-up", today)) {
      const days = practicedDays14(today);
      const rate = completionRateLastN(20);
      if (days >= PROMOTE_MIN_PRACTICE_DAYS && rate !== null && rate >= PROMOTE_MIN_COMPLETION) {
        return {
          kind: "up",
          toLevel: row.level + 1,
          rationale: { xpReached: true, practicedDays14: days, completionRate: rate },
        };
      }
    }
    return null;
  }
```

Run: `cd app && bun test progress-store.test.ts`
Expected: PASS（既存の降格テストは `freshStore`＝no-op signal のままなので `lowOutputRounds: 0` を含む rationale で従来どおり通る）

- [ ] **Step 7: index.ts に実 provider を配線**

`app/server/index.ts` の session-log import（9 行）と progressStore 生成（32 行）を更新する:

```ts
import { fttOutputSignals, listPracticeDays, readEvents } from "./session-log";
```

```ts
const progressStore = makeProgressStore(db, (today) => fttOutputSignals(today));
```

- [ ] **Step 8: クライアントの rationale 表示を追加**

`app/client/src/api/progress.ts:6` の rationale 型に追加する:

```ts
  rationale: { xpReached?: boolean; practicedDays14?: number; completionRate?: number | null; fttAborts?: number; lowOutputRounds?: number };
```

`app/client/src/i18n.ts` の `progress` 型（`fttAborts` の隣）に追加する:

```ts
    lowOutput: (n: number) => string;
```

EN `progress`（`fttAborts` 付近、245 行）:

```ts
      lowOutput: (n) => `${n} recent 4/3/2 rounds were very short on words`,
```

JA `progress`（458 行）:

```ts
      lowOutput: (n) => `直近の4/3/2で発話が極端に短いラウンドが${n}回`,
```

`app/client/src/screens/StartScreen.tsx` の `ProposalCard`（254-260 行）で `fttAborts` の行の直後に追加する:

```tsx
  if (typeof r.fttAborts === "number" && r.fttAborts > 0 && proposal.kind === "down") lines.push(t.fttAborts(r.fttAborts));
  if (typeof r.lowOutputRounds === "number" && r.lowOutputRounds > 0 && proposal.kind === "down") lines.push(t.lowOutput(r.lowOutputRounds));
```

- [ ] **Step 9: 全体検証**

Run: `cd app && bun test`
Expected: PASS

Run: `cd app && bun run typecheck`
Expected: エラーなし

Run: `cd app/client && bun run build`
Expected: 成功

- [ ] **Step 10: コミット**

```bash
git add app/server/progression.ts app/server/session-log.ts app/server/progress-store.ts app/server/index.ts app/server/__tests__/session-log.test.ts app/server/__tests__/progress-store.test.ts app/client/src/api/progress.ts app/client/src/i18n.ts app/client/src/screens/StartScreen.tsx
git commit -m "feat: 4/3/2の実測発話量を降格シグナルに追加（round_end集計・新規テーブルなし）"
```

---

## Task 7: stage1 帯のロールプレイ素材を補充（生成モード追加 + 生成実行）

**対応所見:** 未検証minor「stage1 でビジネス/IT ロールプレイが帯域外シナリオへ黙ってフォールバック」。P7-6。帯域外フォールバックの挙動自体は変えず、素材で解消する。

**設計判断（stage1 素材の実測結果）:** `content/scenarios/` 全 16 本の frontmatter `level`（= stage 帯 [min,max]）を実測した結果、**stage1 が帯域内（min==1）で選べるシナリオはドメイン別に daily=3 本（restaurant-order・neighbor-chat・travel-trouble）、business=0 本、it=0 本**。business/it は最小帯が stage2（例 daily-standup [2,4]・progress-update [2,5]）で、stage1 では `filterInBand`→`pickInDomain` の帯域外フォールバック（`rotation.ts:54-66`）が発火し、難しいシナリオが黙って選ばれる。よって **business と it に stage1 帯シナリオを 1 本ずつ生成して補充**する。

**設計判断（生成手段）:** 既存 `topics` モード（`content-gen.ts` の `genTopics`）は「お題2本+シナリオ1本」を生成し、ドメイン・level はモデル任せ（現 stage を含む制約のみ）で、**特定ドメイン×stage1 帯を狙えない**。そこで `genListening` の固定プラン方式（`LISTENING_PLAN` で domain/level を固定）に倣い、**固定プランの `genScenarios` と `scenarios` サブコマンドを追加**する。プランは `[{domain:"business",level:[1,3]}, {domain:"it",level:[1,3]}]`、語彙は `vocabConstraint(1)`（stage1 レベリング）。検証（id/title/hints）→ all-or-nothing 書き込みは既存 2 モードと同型。

**Files:**
- Modify: `app/server/content-gen.ts`（`genScenarios` + `validateScenarioCandidate` 追加。`contentToMarkdown` は流用）
- Modify: `scripts/generate-content.ts`（`scenarios` サブコマンド）
- Test: `app/server/__tests__/content-gen.test.ts`（`genScenarios` の検証・ドメイン/level 固定・ラウンドトリップ）
- Create: `app/server/__tests__/scenarios-coverage.test.ts`（実シナリオの stage1 カバレッジ・生成→検証ゲート）
- 生成物（Create、実行時）: `content/scenarios/<business-id>.md`, `content/scenarios/<it-id>.md`

**Interfaces:**
- Consumes: `ClaudeRunner`, `loadContent`, `vocabConstraint`, `contentToMarkdown`, `extractJson`, `ORIGINALITY`。
- Produces: `SCENARIO_BAND_PLAN`（固定プラン）、`genScenarios(deps: { runner; scenariosDir; dry; log? })`。CLI `bun scripts/generate-content.ts scenarios [--dry]`。

- [ ] **Step 1: stage1 カバレッジの失敗テストを書く（赤・生成前）**

`app/server/__tests__/scenarios-coverage.test.ts` を新規作成する:

```ts
import { describe, expect, test } from "bun:test";
import { loadContent, DOMAINS } from "../content";
import { SCENARIOS_DIR } from "../paths";

describe("scenarios: stage1 帯カバレッジ", () => {
  test("全ドメインが stage1 で帯域内(level[0]===1)のシナリオを最低1本持つ", () => {
    const scenarios = loadContent(SCENARIOS_DIR);
    for (const d of DOMAINS) {
      const stage1 = scenarios.filter((s) => s.domain === d && s.level[0] === 1);
      expect({ domain: d, count: stage1.length }).toEqual({ domain: d, count: expect.any(Number) });
      expect(stage1.length).toBeGreaterThanOrEqual(1);
    }
  });
});
```

Run: `cd app && bun test scenarios-coverage.test.ts`
Expected: FAIL（business=0・it=0 のため `toBeGreaterThanOrEqual(1)` が落ちる）

- [ ] **Step 2: content-gen.test に genScenarios の検証テストを追加**

`app/server/__tests__/content-gen.test.ts` に追記する（既存の `genTopics`/`genListening` テストのフェイク runner・一時ディレクトリの流儀に合わせる）:

```ts
import { genScenarios, SCENARIO_BAND_PLAN } from "../content-gen";

describe("genScenarios（固定プラン・stage1帯）", () => {
  test("プランは business/it の [1,3] を狙う", () => {
    expect(SCENARIO_BAND_PLAN.map((p) => [p.domain, p.level])).toEqual([
      ["business", [1, 3]], ["it", [1, 3]],
    ]);
  });

  test("生成候補のdomain/levelはプランで固定され、検証通過分を全件書き込む", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "gen-sc-"));
    let n = 0;
    const runner = async () => {
      n++;
      return { text: JSON.stringify({
        id: `stage1-sc-${n}`, title: `T${n}`, titleJa: `t${n}`,
        domain: "daily", level: [4, 6], // モデルが誤った domain/level を返してもプランで上書きされる
        hints: ["Ask a simple question — 簡単な質問をする"],
      }) };
    };
    await genScenarios({ runner: runner as never, scenariosDir: dir, dry: false, log: () => {} });
    const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    expect(files).toHaveLength(2);
    const first = parseContentFile(readFileSync(path.join(dir, files[0]), "utf8"))!;
    expect([first.domain, first.level[0]]).toEqual(["business", 1]); // プラン固定・stage1帯
  });
});
```

（`parseContentFile` は `../content` から import。`mkdtempSync`/`readdirSync`/`readFileSync`/`tmpdir`/`path` は既存テストの import に倣う。）

Run: `cd app && bun test content-gen.test.ts`
Expected: FAIL（`genScenarios`/`SCENARIO_BAND_PLAN` 未定義）

- [ ] **Step 3: content-gen.ts に genScenarios を実装**

`app/server/content-gen.ts` の `genListening` の直前（または `genTopics` の後）に追加する。domain/level はプラン固定、検証は id/title/titleJa/hints（domain/level はモデル値を使わない）:

```ts
export type GenScenariosDeps = {
  runner: ClaudeRunner;
  scenariosDir: string;
  dry: boolean;
  log?: (s: string) => void;
};

/** stage1 帯が枯渇しているドメインを補う固定プラン（domain/level を固定・語彙は stage1 レベリング） */
export const SCENARIO_BAND_PLAN: ReadonlyArray<{ domain: (typeof DOMAINS)[number]; level: [number, number]; vocabStage: number }> = [
  { domain: "business", level: [1, 3], vocabStage: 1 },
  { domain: "it", level: [1, 3], vocabStage: 1 },
];

/** genScenarios 用の候補検証（domain/level はプラン固定なので検査しない — id/title/titleJa/hints のみ） */
function validateScenarioCandidate(
  parsed: unknown, existingIds: Set<string>, dir: string,
): { id: string; title: string; titleJa: string; hints: string[] } | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const c = parsed as Partial<NewContentCandidate>;
  if (typeof c.id !== "string" || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(c.id)) return null;
  if (existingIds.has(c.id) || existsSync(path.join(dir, `${c.id}.md`))) return null;
  if (typeof c.title !== "string" || !c.title.trim() || /[\n"]/.test(c.title)) return null;
  if (typeof c.titleJa !== "string" || !c.titleJa.trim() || /[\n"]/.test(c.titleJa)) return null;
  if (!Array.isArray(c.hints) || c.hints.length === 0) return null;
  if (!c.hints.every((h) => typeof h === "string" && h.trim().length > 0)) return null;
  return { id: c.id, title: c.title.trim(), titleJa: c.titleJa.trim(), hints: c.hints.map((h) => h.trim()) };
}

/**
 * 固定プラン（SCENARIO_BAND_PLAN）で stage1 帯のシナリオを補充する。domain/level はプランで固定し、
 * 語彙制約は帯に連動（stage1）。全候補を検証してから一括書き込み（all-or-nothing）。
 */
export async function genScenarios(deps: GenScenariosDeps): Promise<void> {
  const log = deps.log ?? console.log;
  const existingIds = new Set(loadContent(deps.scenariosDir).map((c) => c.id));
  const candidates: NewContentCandidate[] = [];

  for (const p of SCENARIO_BAND_PLAN) {
    const vocab = vocabConstraint(p.vocabStage);
    const vocabLine = vocab ? `${vocab}\n` : "";
    const domainDesc = p.domain === "daily" ? "everyday life" : p.domain === "business" ? "the workplace" : "software/IT work";
    const system = `You create one original roleplay SCENARIO for an English speaking practice app (Japanese learner, beginner difficulty stage ${p.level[0]}-${p.level[1]} of 6).
Domain: ${domainDesc}. A scenario sets up a roleplay: who the AI plays, who the learner is, the goal, and useful moves.
Each hint line: English phrase — 日本語の補足. Spoken register. Keep it approachable for a near-beginner. ${ORIGINALITY}
${vocabLine}Do NOT reuse these existing ids: ${[...existingIds].join(", ") || "(none)"}
Reply with STRICT JSON only:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","hints":["English — 日本語", ...4 items]}
Do not use any tools — reply directly with text only.`;
    let cand: { id: string; title: string; titleJa: string; hints: string[] } | null = null;
    for (let attempt = 1; attempt <= 2 && !cand; attempt++) {
      let text: string | undefined;
      try {
        ({ text } = await deps.runner(`Write the ${p.domain} beginner scenario now.`, undefined, { systemPrompt: system }));
      } catch (err) {
        console.warn("[content-gen] runner error:", err instanceof Error ? err.message : String(err));
      }
      if (text !== undefined) {
        const parsed = extractJson<NewContentCandidate>(text);
        cand = validateScenarioCandidate(parsed, existingIds, deps.scenariosDir);
      }
      if (!cand && attempt === 1) log(`  ${p.domain}/${p.level[0]}-${p.level[1]}: 検証NG — 再生成します`);
    }
    if (!cand) {
      throw new Error(`エラー: ${p.domain}/${p.level[0]}-${p.level[1]} のシナリオが検証を通りませんでした。何も書き込みません。`);
    }
    existingIds.add(cand.id);
    candidates.push({ ...cand, kind: "scenario", domain: p.domain, level: p.level });
    log(`  + scenario: ${cand.id} [${p.domain}/${p.level[0]}-${p.level[1]}] ${cand.title}`);
  }

  if (deps.dry) {
    log("--dry のため書き込みません");
    return;
  }

  const written: string[] = [];
  try {
    for (const cand of candidates) {
      const file = path.join(deps.scenariosDir, `${cand.id}.md`);
      if (existsSync(file)) throw new Error(`エラー: ${file} は既に存在します。中止します。`);
      writeFileSync(file, contentToMarkdown(cand));
      written.push(file);
    }
  } catch (err) {
    for (const f of written) rmSync(f, { force: true });
    throw err;
  }
  log(`完了: ${written.length} 本の stage1 シナリオを追加しました。`);
}
```

Run: `cd app && bun test content-gen.test.ts`
Expected: PASS

- [ ] **Step 4: CLI に scenarios サブコマンドを追加**

`scripts/generate-content.ts` を更新する。import に `genScenarios` を足し（13 行）、分岐を追加する:

```ts
import { genSentences, genTopics, genScenarios, genListening } from "../app/server/content-gen";
```

```ts
  } else if (sub === "topics") {
    await genTopics({ runner, topicsDir: TOPICS_DIR, scenariosDir: SCENARIOS_DIR, stage, dry, log: console.log });
  } else if (sub === "scenarios") {
    await genScenarios({ runner, scenariosDir: SCENARIOS_DIR, dry, log: console.log });
  } else if (sub === "listening") {
```

使い方コメント（4-6 行）と usage 文字列（33 行）にも `scenarios` を追記する:

```ts
    console.error("使い方: bun scripts/generate-content.ts <sentences|topics|scenarios|listening> [--dry]");
```

Run: `cd app && bun test && bun run typecheck`
Expected: PASS / エラーなし（この時点で `scenarios-coverage.test.ts` はまだ赤＝素材未生成。Step 5 で解消する）

- [ ] **Step 5: dry-run で生成物をプレビュー**

Run: `bun scripts/generate-content.ts scenarios --dry`
Expected: business/it それぞれの候補（id/domain/level）がログに出て「--dry のため書き込みません」。エラー終了しないこと。

- [ ] **Step 6: 本生成して素材を書き込む**

Run: `bun scripts/generate-content.ts scenarios`
Expected: `content/scenarios/` に business と it の stage1 シナリオ 2 本が追加され「完了: 2 本の stage1 シナリオを追加しました。」

- [ ] **Step 7: 生成物を検収し、カバレッジテストが緑になることを確認**

Run: `cd app && bun test scenarios-coverage.test.ts`
Expected: PASS（business/it とも `level[0]===1` のシナリオが 1 本以上）

生成された 2 ファイルを目視で検収する（frontmatter が `domain`＝プランどおり・`level: [1, 3]`、hints が「English — 日本語」形式・stage1 相当の平易さ、`title`/`title_ja` に改行や `"` を含まない）:

```bash
cat content/scenarios/*.md | sed -n '1,40p'
```

帯域内選択の実挙動を確認する（stage1 で business/it が帯域外フォールバックせず新素材を選ぶ）:

```bash
cd app && bun test menu.test.ts
```

Expected: PASS（menu.test は合成フィクスチャを使うため回帰なし。実シナリオでの帯域内選択は `scenarios-coverage.test.ts` が担保）

- [ ] **Step 8: 全体検証**

Run: `cd app && bun test`
Expected: PASS

Run: `cd app && bun run typecheck`
Expected: エラーなし

- [ ] **Step 9: コミット（コード + 生成素材 + テスト）**

```bash
git add app/server/content-gen.ts scripts/generate-content.ts app/server/__tests__/content-gen.test.ts app/server/__tests__/scenarios-coverage.test.ts content/scenarios/
git commit -m "feat: stage1帯のbusiness/ITロールプレイを固定プラン生成モードで補充"
```

---

## Self-Review

**1. Spec coverage（P7 6 項目）:**
- P7-1 既定 Lv 5（stage1）+ 測定 callout の開示 → Task 1（サーバ・既定 5）+ Task 2（callout 開示）。既存ユーザー無影響を Global Constraints で `ensureRow` の `INSERT OR IGNORE` 根拠付きで明記。✅
- P7-2 秒数カーブ非線形化 + 上限文言 + 中立 timeUp → Task 1（カーブ・具体式明記）+ Task 2（`roundTimeboxNote`・`timeUp` 中立化）。✅
- P7-3 ラウンド中の折りたたみチャンク + prep マイク説明 → Task 2（`<details>` 既定折りたたみ・`prepMicNote`）。✅
- P7-4 新規/日 3/5/10 + 復習セット区切り → Task 3（セレクタ・サーバ変更不要を根拠付き明記）+ Task 4（20 枚セット・SRS 不変）。✅
- P7-5 降格アンカー + 実測シグナル → Task 5（`stageAnchorLevel`/下 stage アンカー）+ Task 6（`fttOutputSignals`・注入・rationale）。承認制/XP 不減は維持。✅
- P7-6 stage1 素材補充 → Task 7（実測: daily=3/business=0/it=0、固定プラン生成モード追加 + 生成実行 + カバレッジゲート）。✅

**2. Placeholder scan:** 各コード step に完全なコードを記載。TDD の赤/緑コマンドと期待出力を明記。TBD/「適切に処理」等なし。Task 1 Step 6 に一度混入した誤記（`[125, 90, 60] && [125, 95, 65]`）は直後に正しい `[125, 95, 65]` へ訂正済み（実装時は訂正後のみ採用）。

**3. Type consistency:**
- `fttOutputSignals` の戻り型 `{ lowRounds: number; totalRounds: number }` は session-log.ts / progress-store.ts の provider 型 / index.ts 配線で一致。
- `DownRationale.lowOutputRounds`（サーバ必須）↔ client `rationale.lowOutputRounds?`（optional）↔ i18n `progress.lowOutput(n)` ↔ StartScreen `t.lowOutput(...)` で一貫。
- `stageAnchorLevel` は progression.ts で export、progression.test で import、`demotionTargetLevel` から使用。
- `DEFAULT_LEVEL=5 == stageAnchorLevel(1)` の整合を確認（Task 5 設計判断に明記）。
- `genScenarios` の候補は `NewContentCandidate`（`kind:"scenario"` 付与）として `contentToMarkdown` に渡す型で一致。
- i18n の新キーは EN/JA 両方に追加（片方欠けは typecheck で検出される旨を Task 2 Step 7 に明記）。

**4. 既存ユーザー無影響の再確認:** `DEFAULT_LEVEL` 変更は新規インストールのみ（`ensureRow` の `INSERT OR IGNORE`）。カーブ変更は Lv11/13 を現行同値に固定（既存の中位ユーザー体感を保つ）。降格アンカー変更は「提案＋承認」経路のみで自動適用なし。SRS の間隔・grade は Task 3/4 で不変。
