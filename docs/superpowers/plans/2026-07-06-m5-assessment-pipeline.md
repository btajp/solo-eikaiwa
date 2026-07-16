# M5: 月次アセスメント・コンテンツ生成パイプライン 実装計画

> **歴史的計画文書**: 本文書は執筆時点のリポジトリ構成・ファイルパスのスナップショットであり、その後のリファクタ（ファイル分割・改名等）は反映していません。現在の構成は [README.md](../../../README.md) / [AGENTS.md](../../../AGENTS.md) を参照してください。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 直近30日の学習データから月次レビュー（日本語の振り返りレポート）を生成・保存・表示し、実力データ（SRSの苦手カテゴリ・現在ステージ）駆動でオリジナル教材を追加生成するCLIを提供する。

**Architecture:** Part A はサーバに `assessment.ts`（データ組み立て・レポート生成・SQLite保存）と3つのAPIを追加し、Progress 画面最下部に月次レビューカードを載せる。Part B は `app/server/content-gen.ts` に純粋ヘルパ（テスト対象）を置き、`scripts/generate-content.ts` が薄いCLIとしてそれを編成する。レポート生成・教材生成はどちらも既存の `makeClaudeRunner`（`tools: []`・maxTurns 1）を注入可能な形で使う。

**Tech Stack:** Bun + TypeScript / bun:sqlite / Claude Agent SDK（既存 converse.ts の runner 経由）/ React + Vite（クライアント）

## Global Constraints

- 情報的フィードバックのみ: レポートに目標の押し付け・達成/未達判定・数値ノルマを書かせない（システムプロンプトで明示的に禁止する）
- HTTP は既存フィールド不変・additive のみ（新規エンドポイント3本と RouteDeps 追加のみ）
- 生成失敗は UI/CLI で明示する（黙って壊れない。空出力は 502 / CLI は非ゼロ exit）
- コンテンツは完全オリジナル（既存教材の複製・翻案禁止。生成プロンプトにも明記）
- CLI は書き込み前バリデーション必須（不正なら書かずにエラー終了。リポジトリを壊さない）
- 日付はサーバローカル（`app/server/dates.ts` の `localYmd`/`addDaysYmd` を使う。`toISOString().slice` での ymd 抽出禁止。イベントの `ts` フルタイムスタンプ列は ISO のまま）
- コミットは Conventional Commits（日本語）
- ゲート: `cd app && bun test` / `cd app && bun run typecheck` / `cd app/client && bun run build`

## Interfaces（タスク間契約）

- Task 1 が Produces:
  - `app/server/assessment.ts`: `categoryBadRates(db, sentences): CategoryRate[]` / `type CategoryRate = { categoryNo: number; category: string; reviewed: number; badRate: number }` / `type MonthData`（下記 Step 2 の形そのまま）/ `makeAssembleMonthData(deps): (today?: string) => MonthData` / `generateMonthlyReport(data, runner?): Promise<string | null>` / `makeAssessmentStore(db): AssessmentStore` / `type MonthlyReportRow = { id: number; ts: string; ymd: string; text: string }`
  - HTTP: `POST /api/assessment/generate` body `{force?: boolean}` → `{report: MonthlyReportRow, cached: boolean}`（空出力 502）/ `GET /api/assessment/latest` → `{report: MonthlyReportRow | null}` / `GET /api/assessment/list` → `{reports: Array<MonthlyReportRow & {preview: string}>}`（ts降順）
- Task 2 が Consumes: 上記3エンドポイント。Produces: `api.ts` の `fetchLatestMonthlyReport` / `fetchMonthlyReportList` / `generateMonthlyReport`
- Task 3 が Consumes: `categoryBadRates`（Task 1）・`normalizeEn`（chunks.ts 既存）・`parseContentFile`/`loadContent`（menu.ts 既存）・`loadSentences`（sentences.ts 既存）。Produces: `app/server/content-gen.ts` の `pickWorstCategories` / `validateNewSentences` / `contentToMarkdown` と `scripts/generate-content.ts`

---

### Task 1: サーバ — assessment.ts・monthly_reports・API

**Files:**
- Create: `app/server/assessment.ts`
- Create: `app/server/__tests__/assessment.test.ts`
- Modify: `app/server/db.ts`（monthly_reports テーブル追加）
- Modify: `app/server/routes.ts`（RouteDeps 3フィールド・ハンドラ3本・ルート3行）
- Modify: `app/server/index.ts`（配線）
- Modify: `app/server/__tests__/routes.test.ts`（makeTestDeps 追加・契約テスト）

**Interfaces:**
- Consumes: `makeMetricsSummary`（metrics-aggregate.ts）/ `PlacementStore.latest()` / `localYmd`/`addDaysYmd`（dates.ts）/ `makeClaudeRunner`（converse.ts）/ `extractJson` は不要（自由文のため）
- Produces: 上記 Interfaces 節のとおり

- [ ] **Step 1: db.ts に monthly_reports テーブルを追加**

`app/server/db.ts` の `collected_chunks` テーブル定義の直後（`return db;` の直前）に追加:

```ts
  db.run(`CREATE TABLE IF NOT EXISTS monthly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ymd TEXT NOT NULL,
    text TEXT NOT NULL,
    data_json TEXT NOT NULL
  )`);
```

- [ ] **Step 2: assessment.test.ts を書く（red）**

`app/server/__tests__/assessment.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import type { Sentence } from "../sentences";
import {
  categoryBadRates, generateMonthlyReport, makeAssembleMonthData, makeAssessmentStore,
} from "../assessment";
import type { ClaudeRunner } from "../converse";
import type { MetricsSummary } from "../metrics-aggregate";

const SENTENCES: Sentence[] = [
  { no: 1, category_no: 1, category: "現在形", domain: "daily", en: "One.", ja: "1", note: "" },
  { no: 2, category_no: 1, category: "現在形", domain: "business", en: "Two.", ja: "2", note: "" },
  { no: 3, category_no: 2, category: "過去形", domain: "it", en: "Three.", ja: "3", note: "" },
];

function seedSrs(db: ReturnType<typeof openDb>, no: number, lastGrade: string, reviews = 1) {
  db.run("INSERT INTO sentence_srs (no, stage, due, last_grade, reviews) VALUES (?, 0, '2026-08-01', ?, ?)",
    [no, lastGrade, reviews]);
}

describe("assessment / categoryBadRates", () => {
  test("カテゴリ別に reviewed と badRate を集計し bad率降順で返す", () => {
    const db = openDb(":memory:");
    seedSrs(db, 1, "bad");
    seedSrs(db, 2, "good");
    seedSrs(db, 3, "bad");
    const rates = categoryBadRates(db, SENTENCES);
    expect(rates[0]).toEqual({ categoryNo: 2, category: "過去形", reviewed: 1, badRate: 1 });
    expect(rates[1]).toEqual({ categoryNo: 1, category: "現在形", reviewed: 2, badRate: 0.5 });
  });

  test("評価済みが無ければ空配列", () => {
    expect(categoryBadRates(openDb(":memory:"), SENTENCES)).toEqual([]);
  });
});

describe("assessment / makeAssembleMonthData", () => {
  test("30日窓のデータを組み立てる", () => {
    const db = openDb(":memory:");
    // 練習日: block XP 2日分（窓内）+ 1日（窓外）
    db.run("INSERT INTO xp_events (ts, ymd, kind, amount) VALUES ('t','2026-07-01','block',6)");
    db.run("INSERT INTO xp_events (ts, ymd, kind, amount) VALUES ('t','2026-07-02','block',8)");
    db.run("INSERT INTO xp_events (ts, ymd, kind, amount) VALUES ('t','2026-05-01','block',6)");
    // SRS評価: good(2) ×1, soso/bad(1) ×1
    db.run("INSERT INTO xp_events (ts, ymd, kind, amount) VALUES ('t','2026-07-02','srs-grade',2)");
    db.run("INSERT INTO xp_events (ts, ymd, kind, amount) VALUES ('t','2026-07-03','srs-grade',1)");
    // ブロック試行: 2件中1完了
    db.run("INSERT INTO block_attempts (ts, ymd, kind, completed) VALUES ('t','2026-07-01','warmup-reading',1)");
    db.run("INSERT INTO block_attempts (ts, ymd, kind, completed) VALUES ('t','2026-07-02','four-three-two',0)");
    // チャンク: 窓内1件
    db.run(`INSERT INTO collected_chunks (created, source, prompt_text, en, norm_en, note, due)
            VALUES ('2026-07-01','ae','I go yesterday','I went yesterday','i went yesterday','', '2026-07-02')`);
    seedSrs(db, 1, "bad");

    const fakeSummary: MetricsSummary = {
      days: [
        { ymd: "2026-07-01", utterances: 2, speakingSec: 120, avgArticulationWpm: 100, avgPauseRatio: 0.2, repetitionRatio: 0.1 },
        { ymd: "2026-07-02", utterances: 0, speakingSec: 0, avgArticulationWpm: 0, avgPauseRatio: 0, repetitionRatio: 0 },
      ],
      level: { current: 14, history: [] },
    };
    const assemble = makeAssembleMonthData({
      db,
      sentences: SENTENCES,
      metricsSummary: () => fakeSummary,
      currentLevel: () => 14,
      placementLatest: () => ({ id: 1, ts: "2026-06-20T00:00:00.000Z", stage: 2, startLevel: 13, rationale: "r" }),
    });
    const data = assemble("2026-07-06");
    expect(data.practicedDays).toBe(2);
    expect(data.speakingSec).toBe(120);
    expect(data.utterances).toBe(2);
    expect(data.avgArticulationWpm).toBe(100);
    expect(data.blockAttempts).toBe(2);
    expect(data.blockCompletionRate).toBe(0.5);
    expect(data.srsReviews30d).toBe(2);
    expect(data.srsGoodRate30d).toBe(0.5);
    expect(data.chunksCollected30d).toBe(1);
    expect(data.chunkExamples).toEqual(["I went yesterday"]);
    expect(data.placement?.stage).toBe(2);
    expect(data.levelNow).toBe(14);
  });
});

describe("assessment / generateMonthlyReport", () => {
  test("runner のテキストを trim して返す", async () => {
    const fake: ClaudeRunner = async () => ({ text: "  今月の振り返り。\n良い調子です。 \n", sessionId: "s" });
    const text = await generateMonthlyReport({} as never, fake);
    expect(text).toBe("今月の振り返り。\n良い調子です。");
  });

  test("空出力は null", async () => {
    const fake: ClaudeRunner = async () => ({ text: "   \n ", sessionId: "s" });
    expect(await generateMonthlyReport({} as never, fake)).toBeNull();
  });
});

describe("assessment / makeAssessmentStore", () => {
  test("save/latest/list/findByMonth", () => {
    const db = openDb(":memory:");
    const store = makeAssessmentStore(db);
    expect(store.latest()).toBeNull();
    expect(store.findByMonth("2026-07")).toBeNull();
    const a = store.save({ ymd: "2026-06-30", text: "六月のレポート本文", data: { x: 1 } });
    const b = store.save({ ymd: "2026-07-06", text: "七月のレポート本文です。".repeat(20), data: { x: 2 } });
    expect(store.latest()!.id).toBe(b.id);
    expect(store.findByMonth("2026-07")!.id).toBe(b.id);
    expect(store.findByMonth("2026-06")!.id).toBe(a.id);
    const list = store.list();
    expect(list.map((r) => r.id)).toEqual([b.id, a.id]);
    expect(list[0].preview.length).toBeLessThanOrEqual(80);
    expect(list[0].text.length).toBeGreaterThan(80);
  });
});
```

- [ ] **Step 3: red を確認**

Run: `cd app && bun test __tests__/assessment.test.ts`
Expected: FAIL（`../assessment` が存在しない）

- [ ] **Step 4: assessment.ts を実装**

`app/server/assessment.ts` を新規作成:

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "bun:sqlite";
import { addDaysYmd, localYmd } from "./dates";
import { makeClaudeRunner, type ClaudeRunner } from "./converse";
import type { Sentence } from "./sentences";
import type { MetricsSummary } from "./metrics-aggregate";
import type { PlacementResultRow } from "./placement";

export type CategoryRate = { categoryNo: number; category: string; reviewed: number; badRate: number };

/** カテゴリ別の bad率（現在の last_grade スナップショット・reviewed>0 の文のみ）。bad率降順・同率は reviewed 降順 */
export function categoryBadRates(db: Database, sentences: Sentence[]): CategoryRate[] {
  const rows = db
    .query<{ no: number; last_grade: string | null }, []>(
      "SELECT no, last_grade FROM sentence_srs WHERE reviews > 0")
    .all();
  const byNo = new Map(sentences.map((s) => [s.no, s]));
  const agg = new Map<number, { category: string; reviewed: number; bad: number }>();
  for (const r of rows) {
    const s = byNo.get(r.no);
    if (!s) continue;
    const a = agg.get(s.category_no) ?? { category: s.category, reviewed: 0, bad: 0 };
    a.reviewed++;
    if (r.last_grade === "bad") a.bad++;
    agg.set(s.category_no, a);
  }
  return [...agg.entries()]
    .map(([categoryNo, a]) => ({
      categoryNo,
      category: a.category,
      reviewed: a.reviewed,
      badRate: Math.round((a.bad / a.reviewed) * 1000) / 1000,
    }))
    .sort((x, y) => y.badRate - x.badRate || y.reviewed - x.reviewed);
}

export type MonthData = {
  windowDays: number;
  practicedDays: number;
  speakingSec: number;
  utterances: number;
  /** 30日全体の加重平均（語数近似 = 日別wpm×発話分。近似である旨レポートには数値のみ渡る） */
  avgArticulationWpm: number;
  avgPauseRatio: number;
  repetitionRatio: number;
  blockAttempts: number;
  blockCompletionRate: number | null;
  srsReviews30d: number;
  srsGoodRate30d: number | null;
  /** 評価5文以上のカテゴリからワースト3（bad率>0のみ） */
  worstCategories: CategoryRate[];
  chunksCollected30d: number;
  chunkExamples: string[];
  placement: { ts: string; stage: number; startLevel: number; rationale: string } | null;
  levelNow: number;
};

export type AssembleDeps = {
  db: Database;
  sentences: Sentence[];
  metricsSummary: (days: number, today?: string) => MetricsSummary;
  currentLevel: () => number;
  placementLatest: () => PlacementResultRow | null;
};

export function makeAssembleMonthData(deps: AssembleDeps) {
  return function assembleMonthData(today: string = localYmd()): MonthData {
    const since = addDaysYmd(today, -29);
    const ms = deps.metricsSummary(30, today);

    let words = 0, speechMin = 0, speakingSec = 0, utterances = 0, pauseW = 0, repW = 0;
    for (const d of ms.days) {
      if (d.utterances === 0) continue;
      const min = d.speakingSec / 60;
      words += d.avgArticulationWpm * min;
      speechMin += min;
      speakingSec += d.speakingSec;
      utterances += d.utterances;
      pauseW += d.avgPauseRatio * d.speakingSec;
      repW += d.repetitionRatio * d.speakingSec;
    }

    const practiced = deps.db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(DISTINCT ymd) AS n FROM xp_events WHERE kind = 'block' AND ymd >= ? AND ymd <= ?")
      .get(since, today)!;

    const attempts = deps.db
      .query<{ total: number; done: number }, [string, string]>(
        "SELECT COUNT(*) AS total, SUM(completed) AS done FROM block_attempts WHERE ymd >= ? AND ymd <= ?")
      .get(since, today)!;

    const srs = deps.db
      .query<{ total: number; good: number }, [string, string]>(
        "SELECT COUNT(*) AS total, SUM(CASE WHEN amount = 2 THEN 1 ELSE 0 END) AS good FROM xp_events WHERE kind = 'srs-grade' AND ymd >= ? AND ymd <= ?")
      .get(since, today)!;

    const chunks = deps.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM collected_chunks WHERE created >= ?")
      .get(since)!;
    const examples = deps.db
      .query<{ en: string }, [string]>(
        "SELECT en FROM collected_chunks WHERE created >= ? ORDER BY id DESC LIMIT 3")
      .all(since)
      .map((r) => r.en);

    const p = deps.placementLatest();
    const worst = categoryBadRates(deps.db, deps.sentences)
      .filter((r) => r.reviewed >= 5 && r.badRate > 0)
      .slice(0, 3);

    return {
      windowDays: 30,
      practicedDays: practiced.n,
      speakingSec,
      utterances,
      avgArticulationWpm: speechMin > 0 ? Math.round((words / speechMin) * 10) / 10 : 0,
      avgPauseRatio: speakingSec > 0 ? Math.round((pauseW / speakingSec) * 1000) / 1000 : 0,
      repetitionRatio: speakingSec > 0 ? Math.round((repW / speakingSec) * 1000) / 1000 : 0,
      blockAttempts: attempts.total,
      blockCompletionRate: attempts.total > 0 ? Math.round(((attempts.done ?? 0) / attempts.total) * 1000) / 1000 : null,
      srsReviews30d: srs.total,
      srsGoodRate30d: srs.total > 0 ? Math.round(((srs.good ?? 0) / srs.total) * 1000) / 1000 : null,
      worstCategories: worst,
      chunksCollected30d: chunks.n,
      chunkExamples: examples,
      placement: p ? { ts: p.ts, stage: p.stage, startLevel: p.startLevel, rationale: p.rationale } : null,
      levelNow: deps.currentLevel(),
    };
  };
}

const defaultRunner: ClaudeRunner = makeClaudeRunner(query);

const REPORT_SYSTEM = `あなたは日本人ITプロフェッショナルの英語スピーキング学習を見守るコーチです。
受け取った直近30日の学習データ(JSON)から、日本語で「今月のスピーキング振り返り」を書いてください。
構成（見出し記号・箇条書き記号は使わず、段落と改行のみ。全体で12行以内のプレーンテキスト）:
1. 今月のハイライト（2〜3行）
2. 数字で見る変化（表ではなく文で。データに無い数字を作らない）
3. 強み（2点）
4. 次の一ヶ月のフォーカス（2点。「〜してみるのも良さそうです」のような提案トーン）
5. 締めの一言
守ること: 目標やノルマを課さない。達成/未達の判定をしない。責める表現・警告調を使わない。
データが少ない項目は無理に言及せず「まだデータが少ない」と正直に書く。
Do not use any tools — reply directly with text only.`;

/** 月次レポートを生成する。空出力は null（ルートは502にして再試行を促す） */
export async function generateMonthlyReport(
  data: MonthData,
  runner: ClaudeRunner = defaultRunner,
): Promise<string | null> {
  const prompt = `学習データ(JSON):\n${JSON.stringify(data)}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: REPORT_SYSTEM });
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

export type MonthlyReportRow = { id: number; ts: string; ymd: string; text: string };
export type AssessmentStore = {
  save(r: { ymd: string; text: string; data: unknown }): MonthlyReportRow;
  latest(): MonthlyReportRow | null;
  /** ts降順。preview は本文先頭80字 */
  list(): Array<MonthlyReportRow & { preview: string }>;
  /** yyyyMm 例 "2026-07"。同月の最新行 */
  findByMonth(yyyyMm: string): MonthlyReportRow | null;
};

type ReportDbRow = { id: number; ts: string; ymd: string; text: string };

export function makeAssessmentStore(db: Database): AssessmentStore {
  return {
    save(r) {
      const ts = new Date().toISOString();
      db.run("INSERT INTO monthly_reports (ts, ymd, text, data_json) VALUES (?, ?, ?, ?)",
        [ts, r.ymd, r.text, JSON.stringify(r.data)]);
      const row = db.query<{ id: number }, []>("SELECT last_insert_rowid() AS id").get()!;
      return { id: row.id, ts, ymd: r.ymd, text: r.text };
    },
    latest() {
      return db.query<ReportDbRow, []>(
        "SELECT id, ts, ymd, text FROM monthly_reports ORDER BY id DESC LIMIT 1").get() ?? null;
    },
    list() {
      return db.query<ReportDbRow, []>(
        "SELECT id, ts, ymd, text FROM monthly_reports ORDER BY id DESC").all()
        .map((r) => ({ ...r, preview: r.text.slice(0, 80) }));
    },
    findByMonth(yyyyMm) {
      return db.query<ReportDbRow, [string]>(
        "SELECT id, ts, ymd, text FROM monthly_reports WHERE ymd LIKE ? || '-%' ORDER BY id DESC LIMIT 1")
        .get(yyyyMm) ?? null;
    },
  };
}
```

注意: `findByMonth` の LIKE は `ymd`（`YYYY-MM-DD`）に対して `"2026-07" || "-%"` = `2026-07-%` を意図している。bun:sqlite のパラメータ結合で動くことをテストが固定する（動かなければ `WHERE substr(ymd, 1, 7) = ?` に置き換えてよい — テストが正）。

- [ ] **Step 5: green を確認**

Run: `cd app && bun test __tests__/assessment.test.ts`
Expected: PASS（8件）

- [ ] **Step 6: routes.ts に RouteDeps・ハンドラ・ルートを追加**

import に追加:

```ts
import type { AssessmentStore, MonthData } from "./assessment";
```

`RouteDeps` の `metricsSummary` フィールドの直後に追加:

```ts
  /** 月次レビューの保存・取得（実体は assessment.ts、テストはフェイク） */
  assessmentStore: AssessmentStore;
  /** 直近30日の学習データ組み立て（実体は assessment.ts、テストはフェイク） */
  assembleMonthData: () => MonthData;
  /** 月次レポート生成。空出力は null（ルートは502） */
  generateMonthlyReport: (data: MonthData) => Promise<string | null>;
```

ハンドラを `handleMetricsSummary` の直後に追加:

```ts
async function handleAssessmentGenerate(req: Request, deps: RouteDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ force?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const force = parsed.body.force === true;
  const today = localYmd();
  const existing = deps.assessmentStore.findByMonth(today.slice(0, 7));
  if (existing && !force) return json({ report: existing, cached: true });
  const data = deps.assembleMonthData();
  const text = await deps.generateMonthlyReport(data);
  if (!text) return json({ error: "report generation returned empty output — try again" }, 502);
  const saved = deps.assessmentStore.save({ ymd: today, text, data });
  return json({ report: saved, cached: false });
}
```

`makeFetchHandler` のルート表、`/api/metrics/summary` 行の直後に追加:

```ts
      if (req.method === "POST" && url.pathname === "/api/assessment/generate") return await handleAssessmentGenerate(req, deps);
      if (req.method === "GET" && url.pathname === "/api/assessment/latest") return json({ report: deps.assessmentStore.latest() });
      if (req.method === "GET" && url.pathname === "/api/assessment/list") return json({ reports: deps.assessmentStore.list() });
```

- [ ] **Step 7: routes.test.ts — makeTestDeps 追加と契約テスト（red→green）**

`makeTestDeps` の `metricsSummary` フェイクの直後に追加（在れば `...overrides` の前）:

```ts
    assessmentStore: {
      save: (r: { ymd: string; text: string; data: unknown }) =>
        ({ id: 1, ts: "2026-07-06T00:00:00.000Z", ymd: r.ymd, text: r.text }),
      latest: () => null,
      list: () => [],
      findByMonth: () => null,
    } as RouteDeps["assessmentStore"],
    assembleMonthData: () => ({ windowDays: 30 }) as ReturnType<RouteDeps["assembleMonthData"]>,
    generateMonthlyReport: async () => "今月の振り返りテキスト",
```

契約テストを `describe("routes: metrics")` 系の後に追加:

```ts
describe("routes: assessment", () => {
  const post = (body: unknown) =>
    new Request("http://x/api/assessment/generate", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });

  test("POST /api/assessment/generate は生成して保存し cached:false", async () => {
    const saved: Array<{ ymd: string; text: string }> = [];
    const { deps } = makeTestDeps({
      assessmentStore: {
        save: (r: { ymd: string; text: string; data: unknown }) => {
          saved.push({ ymd: r.ymd, text: r.text });
          return { id: 9, ts: "t", ymd: r.ymd, text: r.text };
        },
        latest: () => null, list: () => [], findByMonth: () => null,
      } as RouteDeps["assessmentStore"],
    });
    const res = await makeFetchHandler(deps)(post({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(false);
    expect(body.report.text).toBe("今月の振り返りテキスト");
    expect(saved).toHaveLength(1);
  });

  test("同一月に既存があれば cached:true で再生成しない（force で再生成）", async () => {
    let generated = 0;
    const existing = { id: 1, ts: "t", ymd: "2026-07-01", text: "既存" };
    const { deps } = makeTestDeps({
      assessmentStore: {
        save: (r: { ymd: string; text: string }) => ({ id: 2, ts: "t2", ymd: r.ymd, text: r.text }),
        latest: () => existing, list: () => [], findByMonth: () => existing,
      } as RouteDeps["assessmentStore"],
      generateMonthlyReport: async () => { generated++; return "新レポート"; },
    });
    const handler = makeFetchHandler(deps);
    const r1 = await handler(post({}));
    expect((await r1.json())).toEqual({ report: existing, cached: true });
    expect(generated).toBe(0);
    const r2 = await handler(post({ force: true }));
    const b2 = await r2.json();
    expect(b2.cached).toBe(false);
    expect(b2.report.text).toBe("新レポート");
    expect(generated).toBe(1);
  });

  test("生成が空なら 502 で保存しない", async () => {
    let saveCalls = 0;
    const { deps } = makeTestDeps({
      generateMonthlyReport: async () => null,
      assessmentStore: {
        save: () => { saveCalls++; return { id: 1, ts: "t", ymd: "y", text: "x" }; },
        latest: () => null, list: () => [], findByMonth: () => null,
      } as RouteDeps["assessmentStore"],
    });
    const res = await makeFetchHandler(deps)(post({}));
    expect(res.status).toBe(502);
    expect(saveCalls).toBe(0);
  });

  test("GET latest / list の形", async () => {
    const row = { id: 1, ts: "t", ymd: "2026-07-06", text: "本文" };
    const { deps } = makeTestDeps({
      assessmentStore: {
        save: () => row, latest: () => row,
        list: () => [{ ...row, preview: "本文" }], findByMonth: () => null,
      } as RouteDeps["assessmentStore"],
    });
    const handler = makeFetchHandler(deps);
    expect(await (await handler(new Request("http://x/api/assessment/latest"))).json()).toEqual({ report: row });
    expect(await (await handler(new Request("http://x/api/assessment/list"))).json()).toEqual({ reports: [{ ...row, preview: "本文" }] });
  });
});
```

Run: `cd app && bun test __tests__/routes.test.ts`
Expected: PASS

- [ ] **Step 8: index.ts の配線**

`makeMetricsSummary` の使用を変数に抽出して再利用する。既存:

```ts
  metricsSummary: makeMetricsSummary({ db, currentLevel: () => progressStore.getLevel() }),
```

を、`realDeps` 定義の**前**にこう置き:

```ts
const metricsSummary = makeMetricsSummary({ db, currentLevel: () => progressStore.getLevel() });
const assessmentStore = makeAssessmentStore(db);
const assembleMonthData = makeAssembleMonthData({
  db,
  sentences,
  metricsSummary,
  currentLevel: () => progressStore.getLevel(),
  placementLatest: () => placementStore.latest(),
});
```

`realDeps` 内は:

```ts
  metricsSummary,
  assessmentStore,
  assembleMonthData: () => assembleMonthData(),
  generateMonthlyReport: (data) => generateMonthlyReport(data),
```

import に `makeAssessmentStore, makeAssembleMonthData, generateMonthlyReport`（from `./assessment`）を追加。
注意: index.ts に既に `const sentences = loadSentences();` があること（M3 で導入済み・26行目付近）を確認して再利用する。

- [ ] **Step 9: 全ゲート**

Run: `cd app && bun test && bun run typecheck`
Expected: 全 PASS（280 + 新規 ≒ 292前後）・typecheck 0

- [ ] **Step 10: コミット**

```bash
git add app/server/assessment.ts app/server/__tests__/assessment.test.ts app/server/db.ts app/server/routes.ts app/server/index.ts app/server/__tests__/routes.test.ts
git commit -m "feat: 月次アセスメントの組み立て・生成・保存とAPIを追加"
```

---

### Task 2: クライアント — Progress 画面の月次レビュー

**Files:**
- Modify: `app/client/src/api.ts`
- Modify: `app/client/src/i18n.ts`
- Modify: `app/client/src/screens/ProgressScreen.tsx`
- Modify: `app/client/src/styles/app.css`

**Interfaces:**
- Consumes: Task 1 の3エンドポイント
- Produces: なし（画面完結）

- [ ] **Step 1: api.ts に型とヘルパを追加**

`fetchMetricsSummary` の直後に追加:

```ts
export type MonthlyReport = { id: number; ts: string; ymd: string; text: string };
export type MonthlyReportPreview = MonthlyReport & { preview: string };

export async function fetchLatestMonthlyReport(): Promise<MonthlyReport | null> {
  const res = await fetch("/api/assessment/latest");
  if (!res.ok) throw new Error(`assessment latest failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { report: MonthlyReport | null }).report;
}

export async function fetchMonthlyReportList(): Promise<MonthlyReportPreview[]> {
  const res = await fetch("/api/assessment/list");
  if (!res.ok) throw new Error(`assessment list failed: ${await extractErrorMessage(res)}`);
  return ((await res.json()) as { reports: MonthlyReportPreview[] }).reports;
}

export async function requestMonthlyReport(force = false): Promise<{ report: MonthlyReport; cached: boolean }> {
  const res = await fetch("/api/assessment/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(force ? { force: true } : {}),
  });
  if (!res.ok) throw new Error(`assessment generate failed: ${await extractErrorMessage(res)}`);
  return res.json();
}
```

- [ ] **Step 2: i18n.ts に文言を追加（EN/JA 両方・progress セクション）**

`Strings.progress` 型の `loading: string; retry: string;` の直後に追加:

```ts
    monthlyReview: string;
    mrGenerate: string; mrGenerating: string;
    mrEmpty: string; mrError: string;
    mrPast: string;
    mrDate: (ymd: string) => string;
```

EN 辞書（`progress` 内の対応位置）:

```ts
      monthlyReview: "Monthly review",
      mrGenerate: "Write this month's review",
      mrGenerating: "Writing your review…",
      mrEmpty: "Once a month, a short written review of your speaking practice appears here.",
      mrError: "Couldn't generate the review. Please try again.",
      mrPast: "Past reviews",
      mrDate: (ymd) => `Generated on ${ymd}`,
```

JA 辞書:

```ts
      monthlyReview: "月次レビュー",
      mrGenerate: "今月のレビューを書いてもらう",
      mrGenerating: "レビューを書いています…",
      mrEmpty: "月に一度、スピーキング練習の振り返りレポートがここに表示されます。",
      mrError: "レビューを生成できませんでした。もう一度お試しください。",
      mrPast: "過去のレビュー",
      mrDate: (ymd) => `${ymd} 生成`,
```

- [ ] **Step 3: ProgressScreen.tsx に MonthlyReview コンポーネントを追加**

import を更新:

```ts
import {
  fetchLatestMonthlyReport, fetchMetricsSummary, fetchMonthlyReportList, requestMonthlyReport,
  type MetricsSummary, type MonthlyReport, type MonthlyReportPreview,
} from "../api";
```

ファイル末尾（`ProgressScreen` の後）に自己完結コンポーネントを追加:

```tsx
/** 月次レビュー: 最新の全文 + 生成導線 + 過去一覧。自己完結（メトリクス取得の失敗と独立） */
function MonthlyReview({ lang }: { lang: Lang }) {
  const t = STR[lang].progress;
  const [report, setReport] = useState<MonthlyReport | null>(null);
  const [past, setPast] = useState<MonthlyReportPreview[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      load();
    }
    return () => { aliveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    try {
      const [latest, list] = await Promise.all([fetchLatestMonthlyReport(), fetchMonthlyReportList()]);
      if (!aliveRef.current) return;
      setReport(latest);
      setPast(list.filter((r) => r.id !== latest?.id));
    } catch (err) {
      console.warn("monthly review load failed:", err);
    }
  }

  async function generate() {
    setGenerating(true);
    setError(false);
    try {
      const { report: r } = await requestMonthlyReport();
      if (!aliveRef.current) return;
      setReport(r);
      // 一覧は次回表示時に更新されれば十分だが、その場で整合させる
      setPast((p) => p.filter((x) => x.id !== r.id));
    } catch (err) {
      console.warn("monthly review generate failed:", err);
      if (aliveRef.current) setError(true);
    } finally {
      if (aliveRef.current) setGenerating(false);
    }
  }

  const THIRTY_DAYS_MS = 30 * 86400000;
  const canGenerate = !report || Date.now() - Date.parse(report.ts) >= THIRTY_DAYS_MS;

  return (
    <Card>
      <div className="card-header"><h3>{t.monthlyReview}</h3></div>
      {report ? (
        <>
          <p className="text-sm text-muted">{t.mrDate(report.ymd)}</p>
          <p className="report-text">{report.text}</p>
        </>
      ) : (
        <p className="text-muted">{t.mrEmpty}</p>
      )}
      {canGenerate && (
        <Button variant="secondary" onClick={generate} loading={generating} disabled={generating}>
          {generating ? t.mrGenerating : t.mrGenerate}
        </Button>
      )}
      {error && <Banner kind="error">{t.mrError}</Banner>}
      {past.length > 0 && (
        <div className="mr-past">
          <p className="text-sm text-muted">{t.mrPast}</p>
          <ul className="mr-past-list">
            {past.map((r) => (
              <li key={r.id}>
                <button className="mr-past-item" onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}>
                  <span className="text-muted">{r.ymd}</span> {expandedId === r.id ? "" : `${r.preview}…`}
                </button>
                {expandedId === r.id && <p className="report-text">{r.text}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
```

`ProgressScreen` の2箇所に描画を追加:

1. 空状態ブランチ（`if (!hasData)` の return 内）— `<Card><p className="text-muted">{t.empty}</p></Card>` の直後に `<MonthlyReview lang={lang} />`
2. メインビュー — レベル履歴 `</Card>` の直後（`</div>` の直前）に `<MonthlyReview lang={lang} />`

注意: `Button` の props は既存実装（variant/size/loading/disabled/onClick/ariaLabel）に合わせる。`loading` が無ければ `disabled` のみでよい（実装時に `app/client/src/ui/Button.tsx` を確認し、既存 API のまま使う。Button 自体は変更しない）。

- [ ] **Step 4: app.css にスタイルを追加**

`.sentence-explain` 定義の直後に追加:

```css
/* 月次レビュー */
.report-text { white-space: pre-wrap; line-height: 1.7; margin: var(--sp-2) 0 var(--sp-3); }
.mr-past { margin-top: var(--sp-3); border-top: 1px solid var(--border); padding-top: var(--sp-3); }
.mr-past-list { list-style: none; padding: 0; margin: 0; }
.mr-past-list li + li { margin-top: var(--sp-1); }
.mr-past-item {
  font: inherit; font-size: var(--fs-sm); color: var(--text);
  background: none; border: none; padding: 2px 0; cursor: pointer; text-align: left; width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.mr-past-item:hover { color: var(--accent); }
```

- [ ] **Step 5: ゲート**

Run: `cd app && bun test && bun run typecheck && cd client && bun run build`
Expected: サーバテスト不変（Task 1 完了時点の件数）・typecheck 0・build 成功

- [ ] **Step 6: コミット**

```bash
git add app/client/src/api.ts app/client/src/i18n.ts app/client/src/screens/ProgressScreen.tsx app/client/src/styles/app.css
git commit -m "feat: 進捗画面に月次レビューを追加"
```

---

### Task 3: コンテンツ生成CLI と README

**Files:**
- Create: `app/server/content-gen.ts`
- Create: `app/server/__tests__/content-gen.test.ts`
- Create: `scripts/generate-content.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: `categoryBadRates`（assessment.ts）/ `normalizeEn`（chunks.ts）/ `parseContentFile`, `loadContent`（menu.ts）/ `loadSentences`, `type Sentence`（sentences.ts）/ `makeProgressStore`（progress-store.ts）/ `stageOf`（progression.ts）/ `makeClaudeRunner`, `extractJson`
- Produces: CLI（`bun scripts/generate-content.ts sentences|topics [--dry]`）

- [ ] **Step 1: content-gen.test.ts を書く（red）**

`app/server/__tests__/content-gen.test.ts` を新規作成:

```ts
import { describe, expect, test } from "bun:test";
import { parseContentFile } from "../menu";
import type { Sentence } from "../sentences";
import type { CategoryRate } from "../assessment";
import { contentToMarkdown, pickWorstCategories, validateNewSentences } from "../content-gen";

const EXISTING: Sentence[] = [
  { no: 1, category_no: 1, category: "現在形", domain: "daily", en: "I usually walk to work.", ja: "歩く", note: "" },
  { no: 5, category_no: 2, category: "過去形", domain: "it", en: "The server went down.", ja: "落ちた", note: "" },
];

describe("content-gen / pickWorstCategories", () => {
  test("reviewed>=5 かつ badRate>0 のみを上位3件", () => {
    const rates: CategoryRate[] = [
      { categoryNo: 1, category: "A", reviewed: 6, badRate: 0.5 },
      { categoryNo: 2, category: "B", reviewed: 4, badRate: 0.9 },  // 5件未満 → 除外
      { categoryNo: 3, category: "C", reviewed: 10, badRate: 0 },   // bad無し → 除外
      { categoryNo: 4, category: "D", reviewed: 5, badRate: 0.2 },
      { categoryNo: 5, category: "E", reviewed: 7, badRate: 0.3 },
      { categoryNo: 6, category: "F", reviewed: 8, badRate: 0.1 },
    ];
    expect(pickWorstCategories(rates).map((r) => r.categoryNo)).toEqual([1, 5, 4]);
  });
});

describe("content-gen / validateNewSentences", () => {
  const cands = [
    { domain: "daily", en: "She usually reads before bed.", ja: "寝る前に読む", note: "習慣の現在形" },
    { domain: "business", en: "Our team usually meets on Mondays.", ja: "月曜に集まる", note: "三単現なし" },
  ];

  test("正常系: no を既存最大+1 から連番で振る", () => {
    const out = validateNewSentences(cands, EXISTING, 1, "現在形")!;
    expect(out.map((s) => s.no)).toEqual([6, 7]);
    expect(out[0].category_no).toBe(1);
    expect(out[0].category).toBe("現在形");
  });

  test("既存と正規化重複する en があれば全体を不採用（null）", () => {
    const dup = [...cands, { domain: "it", en: "I usually walk to work!", ja: "重複", note: "" }];
    expect(validateNewSentences(dup, EXISTING, 1, "現在形")).toBeNull();
  });

  test("不正 domain / 空 en は null", () => {
    expect(validateNewSentences([{ domain: "casual", en: "x", ja: "y", note: "" }], EXISTING, 1, "現在形")).toBeNull();
    expect(validateNewSentences([{ domain: "daily", en: "  ", ja: "y", note: "" }], EXISTING, 1, "現在形")).toBeNull();
  });
});

describe("content-gen / contentToMarkdown", () => {
  test("parseContentFile とラウンドトリップする", () => {
    const md = contentToMarkdown({
      id: "hobby-gardening", kind: "topic", title: "Gardening on weekends", titleJa: "週末の庭いじり",
      domain: "daily", level: [2, 4],
      hints: ["What you grow — 育てているもの", "A small failure — 小さな失敗談"],
    });
    const parsed = parseContentFile(md)!;
    expect(parsed.id).toBe("hobby-gardening");
    expect(parsed.kind).toBe("topic");
    expect(parsed.domain).toBe("daily");
    expect(parsed.level).toEqual([2, 4]);
    expect(parsed.hints).toHaveLength(2);
  });

  test("scenario は Roleplay setup: 見出しになる", () => {
    const md = contentToMarkdown({
      id: "hotel-checkin", kind: "scenario", title: "Hotel check-in trouble", titleJa: "ホテルのチェックイン",
      domain: "daily", level: [1, 3], hints: ["You are the guest — あなたは宿泊客"],
    });
    expect(md).toContain("Roleplay setup:");
    expect(parseContentFile(md)!.kind).toBe("scenario");
  });
});
```

Run: `cd app && bun test __tests__/content-gen.test.ts` → FAIL（red）

- [ ] **Step 2: content-gen.ts を実装（green）**

`app/server/content-gen.ts` を新規作成:

```ts
import { normalizeEn } from "./chunks";
import type { CategoryRate } from "./assessment";
import type { Sentence } from "./sentences";

/** CLI(sentences): 生成対象カテゴリの選定。評価5文以上・bad率>0 のワースト3 */
export function pickWorstCategories(rates: CategoryRate[], minReviewed = 5, top = 3): CategoryRate[] {
  return rates.filter((r) => r.reviewed >= minReviewed && r.badRate > 0).slice(0, top);
}

export type NewSentenceCandidate = { domain: string; en: string; ja: string; note: string };
const DOMAINS = ["daily", "business", "it"] as const;

/**
 * 生成候補を検証して Sentence[] に整形する。1件でも不正・重複があれば null（全体不採用 → 再生成を促す）。
 * no は既存最大+1 から連番。
 */
export function validateNewSentences(
  cands: unknown,
  existing: Sentence[],
  categoryNo: number,
  category: string,
): Sentence[] | null {
  if (!Array.isArray(cands) || cands.length === 0) return null;
  const norms = new Set(existing.map((s) => normalizeEn(s.en)));
  let no = Math.max(...existing.map((s) => s.no));
  const out: Sentence[] = [];
  for (const raw of cands) {
    const c = raw as NewSentenceCandidate;
    if (typeof c?.en !== "string" || typeof c?.ja !== "string" || typeof c?.note !== "string") return null;
    if (!(DOMAINS as readonly string[]).includes(c.domain)) return null;
    const en = c.en.trim();
    if (!en || en.length > 200) return null;
    const norm = normalizeEn(en);
    if (!norm || norms.has(norm)) return null;
    norms.add(norm);
    no++;
    out.push({
      no, category_no: categoryNo, category,
      domain: c.domain as Sentence["domain"],
      en, ja: c.ja.trim(), note: c.note.trim(),
    });
  }
  return out;
}

export type NewContentCandidate = {
  id: string;
  kind: "topic" | "scenario";
  title: string;
  titleJa: string;
  domain: string;
  level: [number, number];
  hints: string[];
};

/** menu.ts の parseContentFile が読める markdown に整形する（ラウンドトリップをテストで保証） */
export function contentToMarkdown(c: NewContentCandidate): string {
  const heading = c.kind === "topic" ? "Talk about:" : "Roleplay setup:";
  return [
    "---",
    `id: ${c.id}`,
    `kind: ${c.kind}`,
    `title: "${c.title}"`,
    `title_ja: "${c.titleJa}"`,
    `domain: ${c.domain}`,
    `level: [${c.level[0]}, ${c.level[1]}]`,
    "---",
    heading,
    ...c.hints.map((h) => `- ${h}`),
    "",
  ].join("\n");
}
```

Run: `cd app && bun test __tests__/content-gen.test.ts` → PASS（6件）

- [ ] **Step 3: scripts/generate-content.ts を実装**

`scripts/generate-content.ts` を新規作成:

```ts
#!/usr/bin/env bun
/**
 * 実力データ駆動のコンテンツ生成CLI（完全オリジナル教材を追加する）。
 *   bun scripts/generate-content.ts sentences [--dry]  # SRSの苦手カテゴリに新規例文を各4文追記
 *   bun scripts/generate-content.ts topics    [--dry]  # 現在ステージ向けのお題2本+シナリオ1本を追加
 * --dry はプレビューのみ（ファイルを書かない）。書き込み前バリデーションに失敗したら何も書かずに終了する。
 * 対話AIは Claude Agent SDK（サブスクリプション認証）を使う。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { openDb } from "../app/server/db";
import { loadSentences } from "../app/server/sentences";
import { categoryBadRates } from "../app/server/assessment";
import { contentToMarkdown, pickWorstCategories, validateNewSentences, type NewContentCandidate } from "../app/server/content-gen";
import { extractJson } from "../app/server/coach";
import { makeClaudeRunner } from "../app/server/converse";
import { loadContent, parseContentFile } from "../app/server/menu";
import { makeProgressStore } from "../app/server/progress-store";
import { stageOf } from "../app/server/progression";
import { SENTENCES_FILE, SCENARIOS_DIR, TOPICS_DIR } from "../app/server/paths";

const sub = process.argv[2];
const dry = process.argv.includes("--dry");
const runner = makeClaudeRunner(query);

const ORIGINALITY = "All output must be completely original — do not copy or adapt sentences from existing textbooks or courses.";

async function genSentences(): Promise<void> {
  const db = openDb();
  const sentences = loadSentences();
  const worst = pickWorstCategories(categoryBadRates(db, sentences));
  if (worst.length === 0) {
    console.log("データ不足: 評価5文以上で bad が出ているカテゴリがまだありません。例文練習を続けてから再実行してください。");
    return;
  }
  console.log(`苦手カテゴリ: ${worst.map((w) => `${w.category}(bad率${Math.round(w.badRate * 100)}%)`).join(" / ")}`);

  let all = [...sentences];
  for (const w of worst) {
    const inCategory = sentences.filter((s) => s.category_no === w.categoryNo);
    const system = `You write original English example sentences for a Japanese learner (CEFR B1-B2).
Write exactly 4 spoken-register sentences practicing the grammar category "${w.category}".
Domains: one "daily", one "business", one "it", and one of your choice. 6-14 words each. Contractions welcome.
${ORIGINALITY}
Avoid these existing sentences (do not duplicate or closely paraphrase):
${inCategory.slice(0, 12).map((s) => `- ${s.en}`).join("\n")}
Reply with STRICT JSON only: {"sentences":[{"domain":"daily|business|it","en":"...","ja":"自然な和訳","note":"文法ポイント1行(日本語)"}]}
Do not use any tools — reply directly with text only.`;
    let validated = null;
    for (let attempt = 1; attempt <= 2 && !validated; attempt++) {
      const { text } = await runner(`Generate the 4 sentences for category: ${w.category}`, undefined, { systemPrompt: system });
      const parsed = extractJson<{ sentences?: unknown }>(text);
      validated = parsed ? validateNewSentences(parsed.sentences, all, w.categoryNo, w.category) : null;
      if (!validated && attempt === 1) console.log(`  ${w.category}: 検証NG — 再生成します`);
    }
    if (!validated) {
      console.error(`エラー: カテゴリ「${w.category}」の生成が2回とも検証を通りませんでした。何も書き込まずに終了します。`);
      process.exit(1);
    }
    all = [...all, ...validated];
    for (const s of validated) console.log(`  + no.${s.no} [${s.domain}] ${s.en}`);
  }

  if (dry) {
    console.log(`--dry のため書き込みません（追加候補 ${all.length - sentences.length} 文）`);
    return;
  }
  // 書き込み前バリデーション: temp に書いて loadSentences が全件読めることを確認してから本番に書く
  const work = mkdtempSync(path.join(tmpdir(), "gen-sent-"));
  try {
    const tempFile = path.join(work, "sentences.json");
    writeFileSync(tempFile, JSON.stringify(all, null, 2) + "\n");
    const check = loadSentences(tempFile);
    if (check.length !== all.length) {
      console.error(`エラー: 生成物のバリデーションに失敗（${all.length}件中${check.length}件のみ有効）。書き込みを中止します。`);
      process.exit(1);
    }
    writeFileSync(SENTENCES_FILE, JSON.stringify(all, null, 2) + "\n");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`完了: ${all.length - sentences.length} 文を追記しました（計 ${all.length} 文）。`);
  console.log("音声の差分生成: cd app && bun ../scripts/generate-sentence-audio.ts");
}

async function genTopics(): Promise<void> {
  const db = openDb();
  const stage = stageOf(makeProgressStore(db).getLevel());
  const topics = loadContent(TOPICS_DIR);
  const scenarios = loadContent(SCENARIOS_DIR);
  const existingIds = new Set([...topics, ...scenarios].map((c) => c.id));

  const plans: Array<{ kind: "topic" | "scenario"; dir: string }> = [
    { kind: "topic", dir: TOPICS_DIR },
    { kind: "topic", dir: TOPICS_DIR },
    { kind: "scenario", dir: SCENARIOS_DIR },
  ];
  const written: string[] = [];
  for (const p of plans) {
    const existing = (p.kind === "topic" ? topics : scenarios).map((c) => c.id).join(", ");
    const system = `You create one original ${p.kind} for an English speaking practice app (Japanese learner, difficulty stage ${stage} of 6).
${p.kind === "topic"
  ? "A topic gives 4 talking-point hints for a monologue."
  : "A scenario sets up a roleplay: who the AI plays, who the learner is, the goal, and useful moves."}
Each hint line: English phrase — 日本語の補足. Spoken register. ${ORIGINALITY}
Do NOT reuse these existing ids: ${existing}
Reply with STRICT JSON only:
{"id":"kebab-case-id","title":"English title","titleJa":"日本語タイトル","domain":"daily|business|it","level":[min,max],"hints":["English — 日本語", ...4 items]}
level must be within 1..6 and include stage ${stage}.
Do not use any tools — reply directly with text only.`;
    let cand: NewContentCandidate | null = null;
    for (let attempt = 1; attempt <= 2 && !cand; attempt++) {
      const { text } = await runner(`Create the ${p.kind} now.`, undefined, { systemPrompt: system });
      const parsed = extractJson<NewContentCandidate>(text);
      if (!parsed || typeof parsed.id !== "string" || existingIds.has(parsed.id)) { cand = null; continue; }
      const md = contentToMarkdown({ ...parsed, kind: p.kind });
      cand = parseContentFile(md) ? { ...parsed, kind: p.kind } : null;
    }
    if (!cand) {
      console.error(`エラー: ${p.kind} の生成が検証を通りませんでした。ここまでに書いたファイル: ${written.join(", ") || "なし"}`);
      process.exit(1);
    }
    existingIds.add(cand.id);
    const file = path.join(p.dir, `${cand.id}.md`);
    if (existsSync(file)) {
      console.error(`エラー: ${file} は既に存在します。中止します。`);
      process.exit(1);
    }
    console.log(`  + ${p.kind}: ${cand.id} [${cand.domain}/${cand.level[0]}-${cand.level[1]}] ${cand.title}`);
    if (!dry) {
      writeFileSync(file, contentToMarkdown(cand));
      written.push(file);
    }
  }
  console.log(dry ? "--dry のため書き込みません" : `完了: ${written.length} ファイルを追加しました。`);
}

if (sub === "sentences") await genSentences();
else if (sub === "topics") await genTopics();
else {
  console.error("使い方: bun scripts/generate-content.ts <sentences|topics> [--dry]");
  process.exit(1);
}
```

注意（実装時に確認・調整してよい点。ただし挙動契約は変えない）:
- `makeClaudeRunner` の引数シグネチャは converse.ts の実物に合わせる
- `paths.ts` に `SENTENCES_FILE` / `TOPICS_DIR` / `SCENARIOS_DIR` が export されていることを確認（M2/M3で導入済み）
- `readFileSync` を import しているが未使用なら削除する

- [ ] **Step 4: CLI のスモーク（--dry・実行はしない生成なし経路のみ）**

Run: `bun scripts/generate-content.ts` （サブコマンド無し）
Expected: 使い方を表示して exit 1

Run: `bun scripts/generate-content.ts sentences --dry`
Expected: 実DBに評価5件以上の bad ありカテゴリが無ければ「データ不足」で正常終了（あれば実生成が走るので、**データ不足メッセージが出る場合のみこのスモークを実施**。生成が走る環境では Claude 呼び出し3回のコストが掛かるため任意）

- [ ] **Step 5: README を更新**

「### 📐 レベルとプレースメント」節の末尾（次の `###` の前）に追加:

```markdown
30日ごとに Progress 画面で**月次レビュー**も書いてもらえます。直近30日の練習時間・調音速度・例文の定着・収集チャンクなどをまとめた日本語の振り返りレポートです（情報表示のみ・ノルマや判定はありません）。
```

「## 自分用にカスタマイズする」節の末尾に追加:

```markdown
実力データに合わせて教材を増やすこともできます（要 Claude Code ログイン・完全オリジナル生成）:

```bash
bun scripts/generate-content.ts sentences --dry   # SRSの苦手カテゴリ×4文をプレビュー
bun scripts/generate-content.ts sentences         # 例文に追記（音声は上の差分生成コマンドで）
bun scripts/generate-content.ts topics            # 現在レベル向けのお題2本+シナリオ1本を追加
```
```

- [ ] **Step 6: 全ゲート**

Run: `cd app && bun test && bun run typecheck && cd client && bun run build`
Expected: 全 PASS・typecheck 0・build 成功

- [ ] **Step 7: コミット**

```bash
git add app/server/content-gen.ts app/server/__tests__/content-gen.test.ts scripts/generate-content.ts README.md
git commit -m "feat: 実力データ駆動のコンテンツ生成CLIを追加しREADMEを更新"
```

---

## Self-Review

1. **設計6点カバレッジ**: Part A ①データ組み立て（Task 1 Step 4 `makeAssembleMonthData` — metrics再利用/練習日/完了率/SRS統計/チャンク/placement/レベル）②レポート生成（`generateMonthlyReport` + REPORT_SYSTEM・空→null→502）③保存とAPI（monthly_reports・generate冪等/force・latest/list）④UI（Task 2 MonthlyReview: 全文・生成条件・過去一覧折りたたみ・i18n EN/JA）/ Part B ⑤CLI 2サブコマンド（ワースト3カテゴリ×4文・stage適合topic2+scenario1・--dry・書き込み前バリデーション・データ不足案内）⑥README 2箇所 — すべてタスクにマップ済み
2. **プレースホルダ**: なし（全ステップ実コード。「実装時に確認」注記は既存APIとの整合確認のみで、値・挙動は本計画が規定）
3. **型整合**: `CategoryRate` は assessment.ts が定義し content-gen.ts が import / `MonthData` は routes の `assembleMonthData` 戻り値と一致 / `MonthlyReportRow` はサーバ⇄client の `MonthlyReport` と同形 / `ClaudeRunner` の戻り `{text, sessionId}` は converse.ts 実物に一致（placement.ts の使用実績と同形）
4. **既存テスト影響**: routes.test.ts の makeTestDeps に必須3フィールド追加（Step 7 に明記）のみ。他のフェイク構築箇所は routes.test.ts に集約されている（M4 レビューで確認済みのパターン）。既存アサーションの変更は不要（新規エンドポイントのみ）
5. **仕様上の割り切り（明記）**: カテゴリ別 bad率は per-review 履歴が無いため「現在の last_grade スナップショット」による近似 / 月間 wpm は日別 wpm×発話分からの再構成近似 / `srsGoodRate30d` は xp_events の amount(2=good) から導出（soso と bad は区別不能なため good率のみ）— いずれもコード内コメントに残す
6. **レビュー不要案件**: ユーザー承認済みの自走キュー項目。研究制約（情報的トーン）は REPORT_SYSTEM の禁止事項とテストではなくプロンプトで担保（自由文のため機械検証は不能 — 実走時にユーザーが確認）
