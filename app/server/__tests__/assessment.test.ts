import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import type { Sentence } from "../sentences";
import { generateMonthlyReport, makeAssembleMonthData, makeAssessmentStore } from "../assessment";
import { categoryBadRates } from "../srs-analytics";
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
    // 練習日: block / SRSを含む全XP日を共通定義で数える（窓内3日）
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
        {
          ymd: "2026-07-01", utterances: 2, words: 200, speechMs: 120_000, totalMs: 150_000,
          pauseMs: 30_000, repetitionWords: 200, repetitionWeightedWords: 20, speakingSec: 120,
          avgArticulationWpm: 100, avgPauseRatio: 0.2, repetitionRatio: 0.1,
        },
        {
          ymd: "2026-07-02", utterances: 0, words: 0, speechMs: 0, totalMs: 0,
          pauseMs: 0, repetitionWords: 0, repetitionWeightedWords: 0, speakingSec: 0,
          avgArticulationWpm: 0, avgPauseRatio: 0, repetitionRatio: 0,
        },
      ],
      weekly: { current: {} as never, previous: {} as never },
      level: { current: 14, history: [] },
    };
    const assemble = makeAssembleMonthData({
      db,
      sentences: SENTENCES,
      metricsSummary: () => fakeSummary,
      practiceDays: () => [],
      currentLevel: () => 14,
      placementLatest: () => ({ id: 1, ts: "2026-06-20T00:00:00.000Z", stage: 2, startLevel: 13, rationale: "r" }),
    });
    const data = assemble("2026-07-06");
    expect(data.practicedDays).toBe(3);
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

  test("月次率は偏った日別件数でもraw分子・分母から計算する", () => {
    const db = openDb(":memory:");
    const fakeSummary = {
      days: [
        {
          ymd: "2026-07-01", utterances: 1, words: 1, speechMs: 600, totalMs: 1_000,
          pauseMs: 1_000, repetitionWords: 1, repetitionWeightedWords: 1, speakingSec: 1,
          avgArticulationWpm: 100, avgPauseRatio: 1, repetitionRatio: 1,
        },
        {
          ymd: "2026-07-02", utterances: 100, words: 100, speechMs: 60_000, totalMs: 100_000,
          pauseMs: 0, repetitionWords: 100, repetitionWeightedWords: 0, speakingSec: 60,
          avgArticulationWpm: 100, avgPauseRatio: 0, repetitionRatio: 0,
        },
      ],
      weekly: { current: {}, previous: {} },
      level: { current: 13, history: [] },
    } as unknown as MetricsSummary;
    const data = makeAssembleMonthData({
      db, sentences: [], metricsSummary: () => fakeSummary, practiceDays: () => [],
      currentLevel: () => 13, placementLatest: () => null,
    })("2026-07-06");
    expect(data.utterances).toBe(101);
    expect(data.avgPauseRatio).toBe(0.01);
    expect(data.repetitionRatio).toBe(0.01);
    expect(data.avgArticulationWpm).toBe(100);
  });
});

describe("assessment / worstCategories の閾値", () => {
  test("評価5文以上かつbad率>0のカテゴリだけがワースト3に入る", () => {
    const db = openDb(":memory:");
    // カテゴリ10: 6文評価済み（bad2/good4 → bad率>0・閾値超え）
    // カテゴリ20: 2文評価済み（bad2 → bad率1.0 だが閾値未満）
    // カテゴリ30: 5文評価済み・全good（bad率0 → 除外）
    const many: Sentence[] = [];
    for (let i = 1; i <= 6; i++) many.push({ no: 100 + i, category_no: 10, category: "仮定法", domain: "daily", en: `A${i}.`, ja: "", note: "" });
    for (let i = 1; i <= 2; i++) many.push({ no: 200 + i, category_no: 20, category: "関係詞", domain: "it", en: `B${i}.`, ja: "", note: "" });
    for (let i = 1; i <= 5; i++) many.push({ no: 300 + i, category_no: 30, category: "比較", domain: "business", en: `C${i}.`, ja: "", note: "" });
    for (let i = 1; i <= 6; i++) seedSrs(db, 100 + i, i <= 2 ? "bad" : "good");
    for (let i = 1; i <= 2; i++) seedSrs(db, 200 + i, "bad");
    for (let i = 1; i <= 5; i++) seedSrs(db, 300 + i, "good");

    const assemble = makeAssembleMonthData({
      db, sentences: many,
      metricsSummary: () => ({
        days: [], weekly: { current: {} as never, previous: {} as never },
        level: { current: 13, history: [] },
      }),
      practiceDays: () => [],
      currentLevel: () => 13,
      placementLatest: () => null,
    });
    const data = assemble("2026-07-06");
    expect(data.worstCategories).toHaveLength(1);
    expect(data.worstCategories[0]).toMatchObject({ categoryNo: 10, category: "仮定法", reviewed: 6 });
    expect(data.worstCategories[0].badRate).toBe(0.333); // 実装は3桁丸め
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

  test("システムプロンプトが発話指標を推定値として扱い、ポーズ全削減へ誘導しない指示を含む", async () => {
    // Issue #183/#217: 調音速度・ポーズ比率は文字起こしセグメント由来の近似値で、
    // ポーズ比率は節内（文中の詰まり）と節末（考えるポーズ）を区別できない。
    // 月次レビューがこれを能力値として断定したり、ポーズ全体を減らす助言をしないこと。
    let systemPrompt = "";
    const fake: ClaudeRunner = async (_prompt, _sessionId, opts) => {
      systemPrompt = opts?.systemPrompt ?? "";
      return { text: "ok", sessionId: "s" };
    };
    await generateMonthlyReport({} as never, fake);
    expect(systemPrompt).toContain("推定値");
    expect(systemPrompt).toContain("区別");
    expect(systemPrompt).toContain("ポーズ全体を減らす");
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
