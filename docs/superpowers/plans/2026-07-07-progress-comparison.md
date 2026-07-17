# 進歩の見える化・比較 実装計画

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 月次レビューに前月の実測値を渡して「先月比」を事実として書ける／見せられるようにし、レベル測定の結果画面に前回測定（日付・ステージ）と現在レベル・CEFR目安を中立に併記して、「進歩を感じる瞬間」を情報的に提供する。

**Architecture:** 過去データは新規の常時記録を増やさず、既存DBから再構成する。月次レビューは `monthly_reports.data_json`（M5で既に保存済み・未公開）を読み出して LLM へ `{thisMonth, lastMonth}` を渡し（捏造防止＝Major-10）、さらに決定的（LLM非依存）な「先月比」ファクトを純関数で組み立てて新規GETで返す。レベル測定は `placement_results` に既に積まれた履歴から `previous()` を足し、submit応答に前回行と現在レベルを載せて結果画面に比較ブロックを描く（Major-11）。すべて additive（既存フィールド不変・新規メソッド/エンドポイント/コピーのみ）。

**Tech Stack:** Bun + TypeScript / bun:sqlite / Claude Agent SDK（既存 `converse.ts` の runner 経由）/ React + Vite（クライアント）

## Global Constraints

- 研究制約（情報的フィードバックのみ）: 目標/ノルマの押し付け・達成/未達の判定・警告/叱責・喪失演出をしない。数値は事実として併記するだけ。減少に ↓ 等の損失シグナルや色付けを付けない（月次「先月比」は方向矢印を使わず「先月 X → 今月 Y」の並記のみ）。
- 過去データは既存DB（`monthly_reports.data_json` / `placement_results`）から再構成する。**新規の常時記録（新テーブル・新イベント列）を足さない。** 既存の `data_json`・`placement_results` は M5・progression-c で確定済みで、本計画は読み出しメソッドを追加するだけ。
- HTTP は additive のみ: 既存レスポンスのフィールドを削除・改名しない。submit応答へのフィールド追加と新規GET 1本、および既存 `generateMonthlyReport` 依存の引数型変更（値の意味は保つ）に限る。
- i18n は named 型を EN/JA 両方に必ず同時追加する（型定義 → EN → JA の3箇所）。片方だけ追加すると `tsc --noEmit` が落ちる。文言は EN/JA 対訳で用意する。
- サーバは TDD（テスト先行・red を確認してから実装）。ルート合成は `makeXRoutes(deps)` パターンを維持し、依存はフェイク注入可能に保つ。
- 日付はローカル基準: サーバは `app/server/dates.ts` の `localYmd`、クライアントは `app/client/src/dates.ts` の `localYmd(date)` を使う。`toISOString().slice` での ymd 抽出禁止（イベントの `ts` フルタイムスタンプ列は ISO のまま）。
- コミットは Conventional Commits（日本語）。
- ゲート（各タスク完了時に該当するもの）: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`

## Interfaces（タスク間契約）

- **Task 1（サーバ・placement）** Produces:
  - `app/server/placement.ts`: `PlacementStore.previous(): PlacementResultRow | null` を型・実装に追加。`PlacementResultRow = { id: number; ts: string; stage: number; startLevel: number; rationale: string }`（既存）。
  - HTTP: `POST /api/placement/submit` の応答に `previous: PlacementResultRow | null` と `currentLevel: number` を**追加**（既存の `stage`/`startLevel`/`rationale` は不変）。
- **Task 2（クライアント・placement）** Consumes: 上記submit応答。Produces: `api/placement.ts` の `PlacementResult`（`previous`/`currentLevel` 追加）と `PlacementResultRow` 型、i18n `placement.resultPrev`/`resultCurLevel`/`resultCefr`、結果画面の比較描画。
- **Task 3（サーバ・assessment 接地）** Produces:
  - `app/server/assessment.ts`: `type ReportInput = { thisMonth: MonthData; lastMonth: MonthData | null }`／`generateMonthlyReport(input: ReportInput, runner?): Promise<string | null>`（引数を `MonthData` から `ReportInput` へ）／`AssessmentStore.previousData(currentYmd: string): MonthData | null`。
  - HTTP: `POST /api/assessment/generate` は内部で `{thisMonth, lastMonth}` を渡すが**応答形は不変**（`{report, cached}`）。保存する `data_json` は従来どおり `thisMonth`（= `MonthData`）のみ。
- **Task 4（サーバ・assessment 決定的先月比）** Consumes: Task 3 の `MonthData`/store。Produces:
  - `app/server/assessment.ts`: `type ComparisonKey = "practicedDays" | "blocks" | "speakingMin" | "utterances" | "level"`／`type ComparisonFact = { key: ComparisonKey; last: number; now: number }`／`monthComparison(thisMonth: MonthData, lastMonth: MonthData): ComparisonFact[]`／`AssessmentStore.comparisonData(): { thisMonth: MonthData; lastMonth: MonthData } | null`。
  - HTTP: `GET /api/assessment/comparison` → `{ comparison: ComparisonFact[] | null }`。
- **Task 5（クライアント・assessment 先月比UI）** Consumes: `GET /api/assessment/comparison`。Produces: `api/assessment.ts` の `ComparisonFact` 型と `fetchMonthlyComparison()`、i18n `progress.mrCompareTitle`/`mrCmp*`、`MonthlyReview` の先月比ブロック描画。

---

### Task 1: サーバ — placement `previous()` と submit応答への前回・現在レベル併記

**Files:**
- Modify: `app/server/placement.ts`（`PlacementStore` 型に `previous`、`makePlacementStore` に実装）
- Modify: `app/server/routes/placement.ts`（submit応答へ `previous`・`currentLevel` を追加）
- Modify: `app/server/__tests__/placement.test.ts`（`previous()` の単体テスト）
- Create: `app/server/__tests__/routes-placement.test.ts`（submit応答の契約テスト）
- Modify: `app/server/__tests__/helpers/route-deps.ts`（`makeFakePlacementStore` に `previous` 既定）

**Interfaces:**
- Consumes: `openDb`（db.ts）/ `makeFetchHandler`（routes.ts）/ `makeTestDeps`・`makeFakePlacementStore`（helpers/route-deps）/ `postJson`（helpers/http）/ `progressStore.getLevel()`（既存 `ProgressStore`）。
- Produces: `PlacementStore.previous()` と submit応答の追加2フィールド（上記 Interfaces 節のとおり）。

- [ ] **Step 1: placement.test.ts に `previous()` の失敗テストを追加（red）**

`app/server/__tests__/placement.test.ts` の `describe("placement: store", ...)` ブロック内、末尾の `})` の直前（`test("複数保存で latest は最後の1件", ...)` の後）に追加する:

```ts
  test("previous は直近から2件目（1件以下では null）", () => {
    const db = openDb(":memory:");
    const store = makePlacementStore(db);
    expect(store.previous()).toBeNull();
    store.save({ stage: 2, startLevel: 13, rationale: "先月分", metrics: [] });
    expect(store.previous()).toBeNull(); // 1件だけなら前回は無い
    store.save({ stage: 3, startLevel: 23, rationale: "今月分", metrics: [] });
    const prev = store.previous();
    expect(prev).toMatchObject({ stage: 2, startLevel: 13, rationale: "先月分" });
    expect(store.latest()!.stage).toBe(3); // latest は影響を受けない
  });
```

- [ ] **Step 2: テストが赤（未実装）であることを確認**

Run: `cd app && bun test placement.test.ts`
Expected: FAIL（`store.previous is not a function` 相当）

- [ ] **Step 3: `PlacementStore` 型と `makePlacementStore` に `previous()` を実装**

`app/server/placement.ts` の `PlacementStore` 型（`latest(): PlacementResultRow | null;` の行）を次のように置き換える:

```ts
export type PlacementStore = {
  save(r: { stage: number; startLevel: number; rationale: string; metrics: unknown }): PlacementResultRow;
  latest(): PlacementResultRow | null;
  /** 直近から2件目（＝前回測定）。1件以下なら null。結果画面の前回比較に使う */
  previous(): PlacementResultRow | null;
};
```

同ファイル `makePlacementStore` の `latest()` メソッド定義（`latest() { ... },` ブロック）の直後に `previous()` を追加する:

```ts
    previous() {
      const row = db
        .query<DbRow, []>(
          "SELECT id, ts, stage, start_level, rationale FROM placement_results ORDER BY id DESC LIMIT 1 OFFSET 1")
        .get();
      if (!row) return null;
      return { id: row.id, ts: row.ts, stage: row.stage, startLevel: row.start_level, rationale: row.rationale };
    },
```

- [ ] **Step 4: 単体テストが緑になることを確認**

Run: `cd app && bun test placement.test.ts`
Expected: PASS（全ケース）

- [ ] **Step 5: フェイクストアに `previous` 既定を追加（型を通す）**

`app/server/__tests__/helpers/route-deps.ts` の `makeFakePlacementStore` を次のように置き換える（`latest: () => null,` の行の下に `previous` を足す）:

```ts
export function makeFakePlacementStore(overrides: Partial<PlacementStore> = {}): PlacementStore {
  return {
    save: (r) => ({ id: 1, ts: "2026-07-06T00:00:00.000Z", stage: r.stage, startLevel: r.startLevel, rationale: r.rationale }),
    latest: () => null,
    previous: () => null,
    ...overrides,
  } satisfies PlacementStore;
}
```

- [ ] **Step 6: submit応答の契約テストを新規作成（red）**

`app/server/__tests__/routes-placement.test.ts` を新規作成する:

```ts
import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeFakePlacementStore, makeTestDeps } from "./helpers/route-deps";
import { postJson } from "./helpers/http";
import { PLACEMENT_TASKS } from "../placement";

const TASKS = PLACEMENT_TASKS.map((t) => ({
  taskId: t.id, transcript: "I work as an engineer and I like coffee.", durationSec: 30, wordCount: 9,
}));

describe("routes: placement submit の応答", () => {
  test("submit は stage/startLevel/rationale に加えて previous と currentLevel を返す", async () => {
    const prevRow = { id: 5, ts: "2026-06-06T00:00:00.000Z", stage: 2, startLevel: 13, rationale: "先月分" };
    const { deps } = makeTestDeps({
      placementStore: makeFakePlacementStore({ previous: () => prevRow }),
      // makeTestDeps 既定: evaluatePlacement → {stage:2,startLevel:13}, progressStore.getLevel → 13
    });
    const res = await makeFetchHandler(deps)(postJson("/api/placement/submit", { tasks: TASKS }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stage).toBe(2);
    expect(body.startLevel).toBe(13);
    expect(typeof body.rationale).toBe("string");
    expect(body.previous).toEqual(prevRow);
    expect(body.currentLevel).toBe(13);
  });

  test("初回（前回なし）は previous:null を返す", async () => {
    const { deps } = makeTestDeps({
      placementStore: makeFakePlacementStore({ previous: () => null }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/placement/submit", { tasks: TASKS }));
    const body = await res.json();
    expect(body.previous).toBeNull();
    expect(body.currentLevel).toBe(13);
  });
});
```

- [ ] **Step 7: テストが赤（`previous`/`currentLevel` 未実装）であることを確認**

Run: `cd app && bun test routes-placement.test.ts`
Expected: FAIL（`body.previous` が undefined）

- [ ] **Step 8: submit ハンドラの応答にフィールドを追加**

`app/server/routes/placement.ts` の `handlePlacementSubmit` 末尾、`return json({ stage: ev.stage, startLevel: ev.startLevel, rationale: ev.rationaleJa });` の行を次のように置き換える:

```ts
  // 前回測定は save 後に取得する（OFFSET 1 = 今保存した1件前 = 実際の前回）。現在レベルは中立併記用
  const previous = deps.placementStore.previous();
  return json({
    stage: ev.stage, startLevel: ev.startLevel, rationale: ev.rationaleJa,
    previous, currentLevel: deps.progressStore.getLevel(),
  });
```

- [ ] **Step 9: 契約テストが緑になることを確認**

Run: `cd app && bun test routes-placement.test.ts`
Expected: PASS（2ケース）

- [ ] **Step 10: サーバ全体のテストと型を確認**

Run: `cd app && bun test && bun run typecheck`
Expected: PASS（既存テストの回帰なし・型エラーなし）

- [ ] **Step 11: コミット**

```bash
git add app/server/placement.ts app/server/routes/placement.ts \
  app/server/__tests__/placement.test.ts app/server/__tests__/routes-placement.test.ts \
  app/server/__tests__/helpers/route-deps.ts
git commit -m "feat: レベル測定submit応答に前回測定と現在レベルを併記（PlacementStore.previous追加）"
```

---

### Task 2: クライアント — レベル測定結果画面に前回比較・現在レベル・CEFR目安

**Files:**
- Modify: `app/client/src/api/placement.ts`（`PlacementResultRow` 追加・`PlacementResult` 拡張）
- Modify: `app/client/src/i18n.ts`（`PlacementStrings` 型 + EN + JA に `resultPrev`/`resultCurLevel`/`resultCefr`）
- Modify: `app/client/src/screens/PlacementScreen.tsx`（result ステップに比較ブロック・CEFR行）

**Interfaces:**
- Consumes: Task 1 の submit応答（`previous: PlacementResultRow | null`、`currentLevel: number`）／`localYmd`（client `dates.ts`）／`STR`/`Lang`（i18n）／`Card`（ui）。
- Produces: 結果画面の比較描画。追加API・状態フックは無し（`step.result` に載る値を描くだけ）。

- [ ] **Step 1: `api/placement.ts` の型を拡張**

`app/client/src/api/placement.ts` の `export type PlacementResult = ...` の行を、次の2つの型定義に置き換える（`PlacementLatest` の定義はそのまま残す）:

```ts
export type PlacementResultRow = { id: number; ts: string; stage: number; startLevel: number; rationale: string };
export type PlacementResult = {
  stage: number; startLevel: number; rationale: string;
  /** 前回測定行（初回は null → 比較を出さない） */
  previous: PlacementResultRow | null;
  /** 現在の設定レベル（中立併記用） */
  currentLevel: number;
};
```

- [ ] **Step 2: i18n の `PlacementStrings` 型に3キーを追加**

`app/client/src/i18n.ts` の `type PlacementStrings` 内、`resultTitle: string; resultStage: (stage: number) => string;` の行の直後に追加する:

```ts
    resultPrev: (date: string, prevStage: number, curStage: number) => string;
    resultCurLevel: (level: number) => string;
    resultCefr: (stage: number) => string;
```

- [ ] **Step 3: 英語ロケールに文言を追加**

`app/client/src/i18n.ts` の EN 側 `placement:` ブロック、`resultStage: (stage) => \`Estimated stage: ${stage} of 6\`,` の行の直後に追加する:

```ts
      resultPrev: (date, prevStage, curStage) => `Last check (${date}): stage ${prevStage} → this time: stage ${curStage}`,
      resultCurLevel: (level) => `Current level setting: Lv ${level}`,
      resultCefr: (stage) => {
        const band = ["", "roughly A2 (lower)", "roughly A2 (upper)", "roughly B1 (entry)",
          "roughly B1 (upper)", "roughly B2 (lower)", "roughly B2"][stage] ?? "";
        return band ? `As a rough guide: ${band}` : "";
      },
```

- [ ] **Step 4: 日本語ロケールに文言を追加**

`app/client/src/i18n.ts` の JA 側 `placement:` ブロック、`resultStage: (stage) => \`推定ステージ: ${stage} / 6\`,` の行の直後に追加する:

```ts
      resultPrev: (date, prevStage, curStage) => `前回 (${date}): ステージ ${prevStage} → 今回: ステージ ${curStage}`,
      resultCurLevel: (level) => `現在の設定レベル: Lv ${level}`,
      resultCefr: (stage) => {
        const band = ["", "A2（前半）", "A2（後半）", "B1（入り口）", "B1（後半）", "B2（前半）", "B2"][stage] ?? "";
        return band ? `目安: ${band}` : "";
      },
```

- [ ] **Step 5: `PlacementScreen.tsx` で `localYmd` を import**

`app/client/src/screens/PlacementScreen.tsx` の import 群、`import { STR, type Lang } from "../i18n";` の直後の行に追加する:

```ts
import { localYmd } from "../dates";
```

- [ ] **Step 6: result ステップに CEFR行と前回比較ブロックを描画**

`app/client/src/screens/PlacementScreen.tsx` の result 描画（`// result` コメント以下）で、まず結果カード内に CEFR目安を足す。`<p className="reading-text">{result.rationale}</p>` の直後、`<p className="text-sm text-muted">{t.xpNote}</p>` の直前に追加する:

```tsx
        {t.resultCefr(result.stage) && <p className="text-sm text-muted">{t.resultCefr(result.stage)}</p>}
```

続けて、その結果カード（`</Card>`）の直後、`{confirmError && <Banner ...>}` の行の直前に、前回比較ブロックを追加する:

```tsx
      {result.previous && (
        <Card>
          <p className="text-sm text-muted">
            {t.resultPrev(localYmd(new Date(result.previous.ts)), result.previous.stage, result.stage)}
          </p>
          <p className="text-sm text-muted">{t.resultCurLevel(result.currentLevel)}</p>
        </Card>
      )}
```

- [ ] **Step 7: クライアントのビルド（型込み）が通ることを確認**

Run: `cd app/client && bun run build`
Expected: PASS（`tsc --noEmit` で `PlacementResult`/i18n 追加分の型エラーが無く、vite build が成功）

- [ ] **Step 8: コミット**

```bash
git add app/client/src/api/placement.ts app/client/src/i18n.ts app/client/src/screens/PlacementScreen.tsx
git commit -m "feat: レベル測定結果に前回測定・現在レベル・CEFR目安を中立に併記"
```

---

### Task 3: サーバ — 月次レビューへ前月データを接地（捏造防止）

**Files:**
- Modify: `app/server/assessment.ts`（`ReportInput` 型・`generateMonthlyReport` 引数・`REPORT_SYSTEM`・`AssessmentStore.previousData`）
- Modify: `app/server/routes/assessment.ts`（generate ハンドラで `{thisMonth, lastMonth}` を渡す・`AssessmentRoutesDeps` の型調整）
- Modify: `app/server/index.ts`（`generateMonthlyReport` 配線の引数型）
- Modify: `app/server/__tests__/assessment.test.ts`（`previousData` と `generateMonthlyReport` の入力分岐テスト）
- Modify: `app/server/__tests__/routes-assessment.test.ts`（前月データを渡す配線の確認）
- Modify: `app/server/__tests__/helpers/route-deps.ts`（`makeFakeAssessmentStore` に `previousData` 既定・`generateMonthlyReport` 既定の引数型）

**Interfaces:**
- Consumes: `MonthData`（既存 assessment.ts）／`ClaudeRunner`・`defaultRunner`（converse.ts）／`localYmd`（dates.ts）／`openDb`（db.ts）。
- Produces: `ReportInput`・`generateMonthlyReport(input, runner?)`・`AssessmentStore.previousData(currentYmd)`（上記 Interfaces 節のとおり）。

- [ ] **Step 1: `previousData` と `generateMonthlyReport` 入力分岐の失敗テストを追加（red）**

`app/server/__tests__/assessment.test.ts` の末尾（最後の `});` の後）に追加する:

```ts
describe("assessment / previousData", () => {
  test("当月と異なる月の直近レポートの data_json を返す（無ければ null）", () => {
    const db = openDb(":memory:");
    const store = makeAssessmentStore(db);
    expect(store.previousData("2026-07-06")).toBeNull();
    store.save({ ymd: "2026-06-30", text: "六月", data: { practicedDays: 8, levelNow: 12 } });
    store.save({ ymd: "2026-07-05", text: "七月(旧)", data: { practicedDays: 10, levelNow: 13 } });
    // 当月(2026-07)の行は除外し、前月(2026-06)の data_json を返す
    const prev = store.previousData("2026-07-06");
    expect(prev).toMatchObject({ practicedDays: 8, levelNow: 12 });
  });

  test("壊れた data_json は null（例外を投げない）", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO monthly_reports (ts, ymd, text, data_json) VALUES ('t','2026-06-30','x','not json')");
    const store = makeAssessmentStore(db);
    expect(store.previousData("2026-07-06")).toBeNull();
  });
});

describe("assessment / generateMonthlyReport の入力分岐", () => {
  test("lastMonth があればプロンプトに thisMonth と lastMonth の両方が入る", async () => {
    let seen = "";
    const spy: ClaudeRunner = async (prompt) => { seen = prompt; return { text: "レポート", sessionId: "s" }; };
    const input = {
      thisMonth: { practicedDays: 12, levelNow: 14 } as never,
      lastMonth: { practicedDays: 8, levelNow: 12 } as never,
    };
    await generateMonthlyReport(input, spy);
    expect(seen).toContain("thisMonth");
    expect(seen).toContain("lastMonth");
    expect(seen).toContain("\"practicedDays\":8"); // lastMonth の実値が渡る
  });

  test("lastMonth が null なら lastMonth を渡さず初回である旨を含める", async () => {
    let seen = "";
    const spy: ClaudeRunner = async (prompt) => { seen = prompt; return { text: "レポート", sessionId: "s" }; };
    await generateMonthlyReport({ thisMonth: { practicedDays: 12 } as never, lastMonth: null }, spy);
    expect(seen).toContain("thisMonth");
    expect(seen).not.toContain("lastMonth");
  });
});
```

- [ ] **Step 2: テストが赤であることを確認**

Run: `cd app && bun test assessment.test.ts`
Expected: FAIL（`store.previousData is not a function` と入力分岐の未実装）

- [ ] **Step 3: `assessment.ts` に data_json パーサ・`previousData`・`ReportInput`・新プロンプトを実装**

`app/server/assessment.ts` の `type ReportDbRow = { id: number; ts: string; ymd: string; text: string };` の行の直後に、data_json 用の内部行型とパーサを追加する:

```ts
type ReportDataRow = { data_json: string };

/** data_json を MonthData として読み戻す。壊れた行や旧形式は null（呼び側で比較を出さない） */
function parseMonthData(jsonText: string): MonthData | null {
  try {
    const v = JSON.parse(jsonText);
    return v && typeof v === "object" ? (v as MonthData) : null;
  } catch {
    return null;
  }
}
```

`AssessmentStore` 型（`findByMonth(yyyyMm: string): MonthlyReportRow | null;` の行の直後）に `previousData` を追加する:

```ts
  /** 当月(currentYmd の YYYY-MM)と異なる月の直近レポートの data_json を MonthData で返す。無ければ null */
  previousData(currentYmd: string): MonthData | null;
```

`makeAssessmentStore` の `findByMonth(yyyyMm) { ... },` メソッドの直後に実装を追加する:

```ts
    previousData(currentYmd) {
      const ym = currentYmd.slice(0, 7);
      const row = db.query<ReportDataRow, [string]>(
        "SELECT data_json FROM monthly_reports WHERE ymd NOT LIKE ? || '-%' ORDER BY id DESC LIMIT 1")
        .get(ym);
      return row ? parseMonthData(row.data_json) : null;
    },
```

続けて `REPORT_SYSTEM` 定数を次の内容で置き換える（「数字で見る変化」を lastMonth 比較に接地し、初回分岐と捏造禁止を明記。既存の非判定/非警告制約は維持）:

```ts
const REPORT_SYSTEM = `あなたは日本人ITプロフェッショナルの英語スピーキング学習を見守るコーチです。
受け取ったJSONには今月(thisMonth)の直近30日データがあり、前月(lastMonth)がある場合はその同形データも含まれます。日本語で「今月のスピーキング振り返り」を書いてください。
構成（見出し記号・箇条書き記号は使わず、段落と改行のみ。全体で12行以内のプレーンテキスト）:
1. 今月のハイライト（2〜3行）
2. 先月からの変化（表ではなく文で。lastMonth があれば thisMonth と対応する項目を比べ「先月◯◯→今月△△」のように増減を事実として書く。lastMonth が無い（初回）なら比較は書かず「先月との比較はまだできません」と一言添える）
3. 強み（2点）
4. 次の一ヶ月のフォーカス（2点。「〜してみるのも良さそうです」のような提案トーン）
5. 締めの一言
守ること: JSONに無い数値は作らない。目標やノルマを課さない。達成/未達の判定をしない。責める表現・警告調・「落ちた」等の喪失を煽る表現を使わない。増減はあくまで中立な事実として述べる。
データが少ない項目は無理に言及せず「まだデータが少ない」と正直に書く。
Do not use any tools — reply directly with text only.`;
```

`generateMonthlyReport` の型と本体（`export async function generateMonthlyReport(...) { ... }` ブロック全体）を次で置き換える:

```ts
export type ReportInput = { thisMonth: MonthData; lastMonth: MonthData | null };

/** 月次レポートを生成する。空出力は null（ルートは502にして再試行を促す） */
export async function generateMonthlyReport(
  input: ReportInput,
  runner: ClaudeRunner = defaultRunner,
): Promise<string | null> {
  const payload = input.lastMonth
    ? { thisMonth: input.thisMonth, lastMonth: input.lastMonth }
    : { thisMonth: input.thisMonth };
  const prompt = `学習データ(JSON):\n${JSON.stringify(payload)}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: REPORT_SYSTEM });
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}
```

- [ ] **Step 4: assessment 単体テストが緑になることを確認**

Run: `cd app && bun test assessment.test.ts`
Expected: PASS（`previousData` 2ケース・入力分岐2ケース・既存 `generateMonthlyReport` の trim/empty ケースも維持）

- [ ] **Step 5: generate ルートで前月データを渡すよう配線**

`app/server/routes/assessment.ts` の import 行 `import type { AssessmentStore, MonthData } from "../assessment";` を、`ReportInput` も含める形に置き換える:

```ts
import type { AssessmentStore, MonthData, ReportInput } from "../assessment";
```

`AssessmentRoutesDeps` 内の `generateMonthlyReport` の型を次で置き換える:

```ts
  /** 月次レポート生成。空出力は null（ルートは502） */
  generateMonthlyReport: (input: ReportInput) => Promise<string | null>;
```

`handleAssessmentGenerate` 内、`const data = deps.assembleMonthData();` から `const text = await deps.generateMonthlyReport(data);` までを次で置き換える:

```ts
  const data = deps.assembleMonthData();
  const lastMonth = deps.assessmentStore.previousData(today);
  const text = await deps.generateMonthlyReport({ thisMonth: data, lastMonth });
```

（`save({ ymd: today, text, data })` は変更しない — data_json には従来どおり thisMonth のみを保存する）

- [ ] **Step 6: index.ts の配線を新シグネチャに合わせる**

`app/server/index.ts` の `generateMonthlyReport: (data) => generateMonthlyReport(data),` の行を次で置き換える:

```ts
  generateMonthlyReport: (input) => generateMonthlyReport(input),
```

- [ ] **Step 7: ルート依存フェイクに `previousData` を追加し、生成フェイクの引数型を合わせる**

`app/server/__tests__/helpers/route-deps.ts` の `makeFakeAssessmentStore` を次で置き換える（`findByMonth: () => null,` の下に `previousData` を足す）:

```ts
export function makeFakeAssessmentStore(overrides: Partial<AssessmentStore> = {}): AssessmentStore {
  return {
    save: (r) => ({ id: 1, ts: "2026-07-06T00:00:00.000Z", ymd: r.ymd, text: r.text }),
    latest: () => null,
    list: () => [],
    findByMonth: () => null,
    previousData: () => null,
    ...overrides,
  } satisfies AssessmentStore;
}
```

同ファイルの `makeTestDeps` 既定にある `generateMonthlyReport: async () => "今月の振り返りテキスト",` は引数を無視するためそのままで型が通る（`ReportInput` を受けて `Promise<string|null>` を返す形に一致）。変更不要。

- [ ] **Step 8: routes-assessment に前月データ配線の確認テストを追加（red→green）**

`app/server/__tests__/routes-assessment.test.ts` の `describe("routes: assessment", ...)` の中、`test("POST /api/assessment/generate は生成して保存し cached:false", ...)` の直後に追加する:

```ts
  test("generate は previousData を lastMonth として generateMonthlyReport に渡す", async () => {
    let seenLastMonth: unknown = "unset";
    const { deps } = makeTestDeps({
      assessmentStore: makeFakeAssessmentStore({
        previousData: () => ({ practicedDays: 8, levelNow: 12 }) as never,
      }),
      assembleMonthData: () => ({ practicedDays: 12, levelNow: 14 }) as ReturnType<typeof deps.assembleMonthData>,
      generateMonthlyReport: async (input) => { seenLastMonth = input.lastMonth; return "レポート"; },
    });
    const res = await makeFetchHandler(deps)(post({}));
    expect(res.status).toBe(200);
    expect(seenLastMonth).toMatchObject({ practicedDays: 8, levelNow: 12 });
  });
```

このテストで `deps.assembleMonthData` の戻り型注釈を使うため、`makeTestDeps` の戻り値 `deps` を参照する。型が煩雑なら `as never` で簡略化してよい（下の代替を使う）:

```ts
  test("generate は previousData を lastMonth として generateMonthlyReport に渡す", async () => {
    let seenLastMonth: unknown = "unset";
    const { deps } = makeTestDeps({
      assessmentStore: makeFakeAssessmentStore({
        previousData: () => ({ practicedDays: 8, levelNow: 12 }) as never,
      }),
      assembleMonthData: () => ({ practicedDays: 12, levelNow: 14 }) as never,
      generateMonthlyReport: async (input) => { seenLastMonth = input.lastMonth; return "レポート"; },
    });
    const res = await makeFetchHandler(deps)(post({}));
    expect(res.status).toBe(200);
    expect(seenLastMonth).toMatchObject({ practicedDays: 8, levelNow: 12 });
  });
```

（`import { makeFakeAssessmentStore, makeTestDeps } from "./helpers/route-deps";` は既存 import に `makeFakeAssessmentStore` が含まれていることを確認する。含まれていなければ追加する。）

- [ ] **Step 9: assessment ルートテスト・全体テスト・型を確認**

Run: `cd app && bun test routes-assessment.test.ts && bun test && bun run typecheck`
Expected: PASS（新テスト含め全通過・型エラーなし）

- [ ] **Step 10: コミット**

```bash
git add app/server/assessment.ts app/server/routes/assessment.ts app/server/index.ts \
  app/server/__tests__/assessment.test.ts app/server/__tests__/routes-assessment.test.ts \
  app/server/__tests__/helpers/route-deps.ts
git commit -m "feat: 月次レビューに前月data_jsonを渡し先月比を接地（捏造防止・初回分岐）"
```

---

### Task 4: サーバ — 決定的な「先月比」ファクトと取得エンドポイント

**Files:**
- Modify: `app/server/assessment.ts`（`ComparisonKey`/`ComparisonFact`/`monthComparison`・`AssessmentStore.comparisonData`）
- Modify: `app/server/routes/assessment.ts`（`GET /api/assessment/comparison`）
- Modify: `app/server/__tests__/assessment.test.ts`（`monthComparison`・`comparisonData` の単体テスト）
- Modify: `app/server/__tests__/routes-assessment.test.ts`（新エンドポイントの契約テスト）
- Modify: `app/server/__tests__/helpers/route-deps.ts`（`makeFakeAssessmentStore` に `comparisonData` 既定）

**Interfaces:**
- Consumes: `MonthData`・`parseMonthData`（Task 3 で追加）・`makeAssessmentStore`（同ファイル）。
- Produces: `monthComparison`・`ComparisonFact`・`AssessmentStore.comparisonData`・`GET /api/assessment/comparison`（上記 Interfaces 節のとおり）。

- [ ] **Step 1: `monthComparison` と `comparisonData` の失敗テストを追加（red）**

`app/server/__tests__/assessment.test.ts` の末尾に追加する:

```ts
describe("assessment / monthComparison", () => {
  test("固定順で先月・今月の実測を並べる（speakingMin は分・1桁丸め）", () => {
    const last = {
      practicedDays: 8, blockAttempts: 20, speakingSec: 600, utterances: 30, levelNow: 12,
    } as never;
    const now = {
      practicedDays: 12, blockAttempts: 34, speakingSec: 915, utterances: 41, levelNow: 14,
    } as never;
    const facts = monthComparison(now, last);
    expect(facts.map((f) => f.key)).toEqual(["practicedDays", "blocks", "speakingMin", "utterances", "level"]);
    expect(facts[0]).toEqual({ key: "practicedDays", last: 8, now: 12 });
    expect(facts[2]).toEqual({ key: "speakingMin", last: 10, now: 15.3 }); // 600/60=10, 915/60=15.25→15.3
    expect(facts[4]).toEqual({ key: "level", last: 12, now: 14 });
  });
});

describe("assessment / comparisonData", () => {
  test("最新行と、それと異なる月の直近行の data_json を返す", () => {
    const db = openDb(":memory:");
    const store = makeAssessmentStore(db);
    expect(store.comparisonData()).toBeNull(); // 0件
    store.save({ ymd: "2026-06-30", text: "六月", data: { practicedDays: 8, blockAttempts: 20, speakingSec: 600, utterances: 30, levelNow: 12 } });
    expect(store.comparisonData()).toBeNull(); // 1ヶ月しか無い
    store.save({ ymd: "2026-07-06", text: "七月", data: { practicedDays: 12, blockAttempts: 34, speakingSec: 915, utterances: 41, levelNow: 14 } });
    const cd = store.comparisonData();
    expect(cd!.thisMonth).toMatchObject({ practicedDays: 12, levelNow: 14 });
    expect(cd!.lastMonth).toMatchObject({ practicedDays: 8, levelNow: 12 });
  });

  test("同月に複数行あっても前月行が無ければ null", () => {
    const db = openDb(":memory:");
    const store = makeAssessmentStore(db);
    store.save({ ymd: "2026-07-01", text: "七月1", data: { practicedDays: 5, levelNow: 13 } });
    store.save({ ymd: "2026-07-06", text: "七月2", data: { practicedDays: 12, levelNow: 14 } });
    expect(store.comparisonData()).toBeNull();
  });
});
```

`monthComparison` を import に足す。テスト冒頭の import 行 `import { generateMonthlyReport, makeAssembleMonthData, makeAssessmentStore } from "../assessment";` を次で置き換える:

```ts
import { generateMonthlyReport, makeAssembleMonthData, makeAssessmentStore, monthComparison } from "../assessment";
```

- [ ] **Step 2: テストが赤であることを確認**

Run: `cd app && bun test assessment.test.ts`
Expected: FAIL（`monthComparison`/`comparisonData` 未実装）

- [ ] **Step 3: `assessment.ts` に `monthComparison` と `comparisonData` を実装**

`app/server/assessment.ts` の `parseMonthData` 関数（Task 3 で追加済み）の直後に、比較型と純関数を追加する:

```ts
export type ComparisonKey = "practicedDays" | "blocks" | "speakingMin" | "utterances" | "level";
/** 先月比の1項目。判定・矢印は持たず、last/now の実測を並べるだけ（描画側で中立表示する） */
export type ComparisonFact = { key: ComparisonKey; last: number; now: number };

/** 今月と先月の MonthData から、固定順の中立ファクト列を組み立てる純関数 */
export function monthComparison(thisMonth: MonthData, lastMonth: MonthData): ComparisonFact[] {
  const toMin = (sec: number) => Math.round((sec / 60) * 10) / 10;
  return [
    { key: "practicedDays", last: lastMonth.practicedDays, now: thisMonth.practicedDays },
    { key: "blocks", last: lastMonth.blockAttempts, now: thisMonth.blockAttempts },
    { key: "speakingMin", last: toMin(lastMonth.speakingSec), now: toMin(thisMonth.speakingSec) },
    { key: "utterances", last: lastMonth.utterances, now: thisMonth.utterances },
    { key: "level", last: lastMonth.levelNow, now: thisMonth.levelNow },
  ];
}
```

`AssessmentStore` 型（Task 3 で追加した `previousData` の行の直後）に `comparisonData` を追加する:

```ts
  /** 最新レポートと、それと異なる月の直近レポートの data_json 対。どちらか欠ければ null（初回は非表示） */
  comparisonData(): { thisMonth: MonthData; lastMonth: MonthData } | null;
```

`makeAssessmentStore` の `previousData(...) { ... },`（Task 3 で追加）の直後に実装を追加する:

```ts
    comparisonData() {
      const rows = db.query<{ ymd: string; data_json: string }, []>(
        "SELECT ymd, data_json FROM monthly_reports ORDER BY id DESC LIMIT 24").all();
      if (rows.length === 0) return null;
      const thisMonth = parseMonthData(rows[0].data_json);
      const thisYm = rows[0].ymd.slice(0, 7);
      const prevRow = rows.find((r) => r.ymd.slice(0, 7) !== thisYm);
      if (!thisMonth || !prevRow) return null;
      const lastMonth = parseMonthData(prevRow.data_json);
      if (!lastMonth) return null;
      return { thisMonth, lastMonth };
    },
```

- [ ] **Step 4: assessment 単体テストが緑になることを確認**

Run: `cd app && bun test assessment.test.ts`
Expected: PASS（`monthComparison` 1ケース・`comparisonData` 2ケース含む全通過）

- [ ] **Step 5: フェイクストアに `comparisonData` 既定を追加**

`app/server/__tests__/helpers/route-deps.ts` の `makeFakeAssessmentStore` の `previousData: () => null,` の直後に追加する:

```ts
    comparisonData: () => null,
```

- [ ] **Step 6: 比較エンドポイントの契約テストを追加（red）**

`app/server/__tests__/routes-assessment.test.ts` の `test("GET latest / list の形", ...)` の直後に追加する:

```ts
  test("GET /api/assessment/comparison は comparisonData を monthComparison で整形して返す", async () => {
    const { deps } = makeTestDeps({
      assessmentStore: makeFakeAssessmentStore({
        comparisonData: () => ({
          thisMonth: { practicedDays: 12, blockAttempts: 34, speakingSec: 915, utterances: 41, levelNow: 14 } as never,
          lastMonth: { practicedDays: 8, blockAttempts: 20, speakingSec: 600, utterances: 30, levelNow: 12 } as never,
        }),
      }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/assessment/comparison"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.comparison).toHaveLength(5);
    expect(body.comparison[0]).toEqual({ key: "practicedDays", last: 8, now: 12 });
    expect(body.comparison[4]).toEqual({ key: "level", last: 12, now: 14 });
  });

  test("comparisonData が null なら comparison:null", async () => {
    const { deps } = makeTestDeps({
      assessmentStore: makeFakeAssessmentStore({ comparisonData: () => null }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/assessment/comparison"));
    expect(await res.json()).toEqual({ comparison: null });
  });
```

- [ ] **Step 7: テストが赤（404）であることを確認**

Run: `cd app && bun test routes-assessment.test.ts`
Expected: FAIL（未登録ルートで 404 → `body.comparison` が undefined）

- [ ] **Step 8: `GET /api/assessment/comparison` を実装**

`app/server/routes/assessment.ts` の import 行を、`monthComparison` を値として取り込む形に調整する。現在の
`import type { AssessmentStore, MonthData, ReportInput } from "../assessment";`
を次の2行で置き換える:

```ts
import { monthComparison } from "../assessment";
import type { AssessmentStore, MonthData, ReportInput } from "../assessment";
```

`makeAssessmentRoutes` の返す配列、`exact("GET", "/api/assessment/list", ...)` の行の直後に1行追加する:

```ts
    exact("GET", "/api/assessment/comparison", () => {
      const cd = deps.assessmentStore.comparisonData();
      return json({ comparison: cd ? monthComparison(cd.thisMonth, cd.lastMonth) : null });
    }),
```

- [ ] **Step 9: ルートテスト・全体テスト・型を確認**

Run: `cd app && bun test routes-assessment.test.ts && bun test && bun run typecheck`
Expected: PASS（比較エンドポイント2ケース含む全通過・型エラーなし）

- [ ] **Step 10: コミット**

```bash
git add app/server/assessment.ts app/server/routes/assessment.ts \
  app/server/__tests__/assessment.test.ts app/server/__tests__/routes-assessment.test.ts \
  app/server/__tests__/helpers/route-deps.ts
git commit -m "feat: 月次レビューの決定的な先月比ファクトと GET /api/assessment/comparison を追加"
```

---

### Task 5: クライアント — 月次レビューに「先月比」ファクトブロックを表示

**Files:**
- Modify: `app/client/src/api/assessment.ts`（`ComparisonFact` 型・`fetchMonthlyComparison`）
- Modify: `app/client/src/i18n.ts`（`ProgressStrings` 型 + EN + JA に `mrCompareTitle`/`mrCmpLabels`/`mrCmpUnit`）
- Modify: `app/client/src/screens/ProgressScreen.tsx`（`MonthlyReview` で比較を取得・描画）

**Interfaces:**
- Consumes: `GET /api/assessment/comparison`（Task 4）／`STR`/`Lang`（i18n）／`Card`（ui）。
- Produces: 月次レビューカード内の先月比ブロック。既存レイアウト・既存 `mr*` 文言は不変。

- [ ] **Step 1: `api/assessment.ts` に比較の型と取得関数を追加**

`app/client/src/api/assessment.ts` の `export type MonthlyReportPreview = ...` の行の直後に型を追加する:

```ts
export type ComparisonKey = "practicedDays" | "blocks" | "speakingMin" | "utterances" | "level";
export type ComparisonFact = { key: ComparisonKey; last: number; now: number };
```

同ファイル末尾に取得関数を追加する:

```ts
export async function fetchMonthlyComparison(): Promise<ComparisonFact[] | null> {
  const res = await fetch("/api/assessment/comparison");
  if (!res.ok) throw new Error(`assessment comparison failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { comparison: ComparisonFact[] | null }).comparison;
}
```

`api/index.ts` は `export * from "./assessment";` でバレル再エクスポートしているため、追加した `fetchMonthlyComparison`・`ComparisonFact` は自動で `../api` から import 可能になる（`api/index.ts` の編集は不要）。

- [ ] **Step 2: i18n の `ProgressStrings` 型に先月比キーを追加**

`app/client/src/i18n.ts` の `type ProgressStrings`（`progress: { ... }`）内、`mrAlreadyThisMonth: string;` の行の直後に追加する:

```ts
    mrCompareTitle: string;
    mrCmpPracticedDays: string; mrCmpBlocks: string; mrCmpSpeakingMin: string;
    mrCmpUtterances: string; mrCmpLevel: string;
    mrCmpUnitDays: string; mrCmpUnitBlocks: string; mrCmpUnitMin: string; mrCmpUnitTimes: string;
    mrCmpRow: (label: string, last: string, now: string) => string;
```

- [ ] **Step 3: 英語ロケールに先月比文言を追加**

`app/client/src/i18n.ts` の EN 側 `progress:` ブロック、`mrAlreadyThisMonth: "This month's review is already written — showing the latest.",` の行の直後に追加する:

```ts
      mrCompareTitle: "Change since last month (facts only)",
      mrCmpPracticedDays: "Practice days", mrCmpBlocks: "Blocks", mrCmpSpeakingMin: "Speaking time",
      mrCmpUtterances: "Utterances", mrCmpLevel: "Level",
      mrCmpUnitDays: "d", mrCmpUnitBlocks: "", mrCmpUnitMin: "min", mrCmpUnitTimes: "",
      mrCmpRow: (label, last, now) => `${label}: last month ${last} → this month ${now}`,
```

- [ ] **Step 4: 日本語ロケールに先月比文言を追加**

`app/client/src/i18n.ts` の JA 側 `progress:` ブロック、`mrAlreadyThisMonth: "今月のレビューは生成済みです — 最新の内容を表示しています。",` の行の直後に追加する:

```ts
      mrCompareTitle: "先月からの変化（事実のみ）",
      mrCmpPracticedDays: "練習日数", mrCmpBlocks: "ブロック数", mrCmpSpeakingMin: "話した時間",
      mrCmpUtterances: "発話回数", mrCmpLevel: "レベル",
      mrCmpUnitDays: "日", mrCmpUnitBlocks: "回", mrCmpUnitMin: "分", mrCmpUnitTimes: "回",
      mrCmpRow: (label, last, now) => `${label}: 先月 ${last} → 今月 ${now}`,
```

- [ ] **Step 5: `ProgressScreen.tsx` の import に比較の型・関数を追加**

`app/client/src/screens/ProgressScreen.tsx` の api import ブロックを次で置き換える（`fetchMonthlyComparison` と `ComparisonFact` を足す）:

```ts
import {
  fetchLatestMonthlyReport, fetchMetricsSummary, fetchMonthlyComparison, fetchMonthlyReportList, requestMonthlyReport,
  type ComparisonFact, type MonthlyReport, type MonthlyReportPreview,
} from "../api";
```

- [ ] **Step 6: `MonthlyReview` に比較の状態・取得・描画を追加**

`app/client/src/screens/ProgressScreen.tsx` の `MonthlyReview` 関数内、`const [past, setPast] = useState<MonthlyReportPreview[]>([]);` の直後に状態を追加する:

```ts
  const [comparison, setComparison] = useState<ComparisonFact[] | null>(null);
```

`load()` 内の `const [latest, list] = await Promise.all([fetchLatestMonthlyReport(), fetchMonthlyReportList()]);` を、比較も同時取得する形に置き換える:

```ts
      const [latest, list, cmp] = await Promise.all([
        fetchLatestMonthlyReport(), fetchMonthlyReportList(), fetchMonthlyComparison(),
      ]);
```

同じ `load()` 内、`setPast(list.filter((r) => r.id !== latest?.id));` の直後に追加する:

```ts
      setComparison(cmp);
```

`generate()` 内、`setReport(r);` の直後に、生成直後の比較再取得を追加する（生成で今月行が確定するため）:

```ts
      fetchMonthlyComparison().then((c) => { if (aliveRef.current) setComparison(c); }).catch(() => {});
```

`MonthlyReview` の返す JSX、`{report ? ( ... ) : ( ... )}` ブロックの直後（`report.text` を表示する `</>` と `{canGenerate && ...}` の間）に先月比ブロックを追加する:

```tsx
      {comparison && (
        <div className="mr-compare">
          <p className="text-sm text-muted">{t.mrCompareTitle}</p>
          <ul className="mr-compare-list">
            {comparison.map((f) => (
              <li key={f.key} className="text-sm text-muted">{comparisonRow(t, f)}</li>
            ))}
          </ul>
        </div>
      )}
```

`ProgressScreen.tsx` の末尾（ファイル最終行の `MonthlyReview` 関数の閉じ `}` の後）に、行文字列を組み立てるヘルパを追加する:

```tsx
/** 先月比1行の中立文字列。矢印・色は使わず、ラベル＋単位付きの last→now を並べるだけ */
function comparisonRow(t: (typeof STR)[Lang]["progress"], f: ComparisonFact): string {
  const label = {
    practicedDays: t.mrCmpPracticedDays, blocks: t.mrCmpBlocks, speakingMin: t.mrCmpSpeakingMin,
    utterances: t.mrCmpUtterances, level: t.mrCmpLevel,
  }[f.key];
  const unit = {
    practicedDays: t.mrCmpUnitDays, blocks: t.mrCmpUnitBlocks, speakingMin: t.mrCmpUnitMin,
    utterances: t.mrCmpUnitTimes, level: "",
  }[f.key];
  const fmt = (n: number) => (f.key === "level" ? `Lv ${n}` : unit ? `${n}${unit}` : `${n}`);
  return t.mrCmpRow(label, fmt(f.last), fmt(f.now));
}
```

- [ ] **Step 7: クライアントのビルド（型込み）が通ることを確認**

Run: `cd app/client && bun run build`
Expected: PASS（`ComparisonFact`・i18n 追加分・`comparisonRow` の型エラーが無く vite build 成功）

- [ ] **Step 8: 任意 — スタイルの最小追加（見た目が崩れる場合のみ）**

`app/client/src/styles/app.css` に既存 `.mr-past` があればそれに倣い、無ければ最小の余白のみ追加する（機能には不要・視覚整理のみ。判定色は付けない）:

```css
.mr-compare { margin-top: 0.5rem; }
.mr-compare-list { list-style: none; padding: 0; margin: 0.25rem 0 0; }
```

- [ ] **Step 9: コミット**

```bash
git add app/client/src/api/assessment.ts app/client/src/i18n.ts \
  app/client/src/screens/ProgressScreen.tsx app/client/src/styles/app.css
git commit -m "feat: 月次レビューに決定的な先月比ファクトブロックを中立表示"
```

---

## Self-Review

**1. Spec coverage（監査 Major-10・Major-11 / 改善候補 B5・C5 / 研究制約）:**

- Major-11「レベル測定の結果画面に前回比較がない」→ Task 1（`previous()`＋submit応答）＋ Task 2（結果画面の前回・現在Lv・CEFR併記、初回は `previous:null` で非表示）。改善候補 B5 の「PlacementStore に previous() / 前回stage・日付・現在Lv・CEFR目安」を全て充足。confirm の上書き挙動は変更しない（スコープ外・表示のみ）。
- Major-10「月次レビューが変化を書けない（捏造リスク）」→ Task 3（`previousData` で前月 `data_json` を読み `{thisMonth, lastMonth}` を LLM に渡す・初回分岐・捏造禁止をシステムプロンプトに明記）。改善候補 C5 を充足。
- 「進歩の見える化・比較」の主眼＝「進歩を感じる瞬間」→ Task 4・5 で LLM 非依存の決定的な先月比ファクト（練習日数・ブロック数・話した時間・発話回数・レベル）を中立表示。team-lead 指示の「前月の実測値を併記し先月比を情報表示」を、LLM のプロンプト接地（Task 3）と決定的表示（Task 4/5）の二層で満たす。
- 過去データ取得元: `monthly_reports.data_json`（M5で保存済み）と `placement_results`（progression-c で保存済み）からの再構成のみ。新規の常時記録・新テーブルは無し（Global Constraints 準拠）。
- 研究制約: 全文言を情報的・非判定に統一。月次先月比は方向矢印/色を使わず「先月 X → 今月 Y」の並記（喪失演出なし）。レベル比較は「ステージ X → ステージ Y」の事実提示のみ。

**2. Placeholder scan:** 各コード手順に完全な実装／テストコードを記載。TBD・「適切に処理」・省略なし。i18n は型・EN・JA の3箇所を各タスクで具体文字列付きで指定。

**3. Type consistency:**
- `PlacementResultRow`（サーバ既存 = クライアント新規、同形 `{id, ts, stage, startLevel, rationale}`）。submit応答の追加は `previous: PlacementResultRow | null`・`currentLevel: number` でサーバ／クライアント一致。
- `ReportInput = { thisMonth: MonthData; lastMonth: MonthData | null }` を Task 3 で定義し、routes/assessment・index の配線・route-deps フェイクの型が一致。`generateMonthlyReport` の引数は `MonthData`→`ReportInput` に統一（旧引数名 `data` は route ハンドラ内のローカル変数として残るが型は `MonthData`、`generateMonthlyReport` へは `{ thisMonth: data, lastMonth }` を渡す）。
- `ComparisonKey`/`ComparisonFact` はサーバ（assessment.ts）とクライアント（api/assessment.ts）で同一の文字列ユニオン・同一フィールド（`key`/`last`/`now`）。`monthComparison` の返す固定順（practicedDays, blocks, speakingMin, utterances, level）と、クライアント `comparisonRow` のラベル/単位マップのキーが一致。
- `AssessmentStore` に追加する `previousData(currentYmd)`・`comparisonData()` は型・実装・フェイク（route-deps）の3箇所で一致。`PlacementStore.previous()` も型・実装・フェイクで一致。

**4. 実行順の注意:** Task 1→2（placement のサーバ→クライアント）、Task 3→4→5（assessment のサーバ接地→決定的ファクト→クライアント）。Task 3 と 4 は同じ `assessment.ts`・`route-deps.ts`・`routes/assessment.ts` を触るため、必ず Task 3 を先に完了させてから Task 4 に着手する（`parseMonthData` を Task 3 で追加し Task 4 が再利用する）。
