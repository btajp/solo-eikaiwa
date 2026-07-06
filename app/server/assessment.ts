import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "bun:sqlite";
import { addDaysYmd, localYmd } from "./dates";
import { makeClaudeRunner, type ClaudeRunner } from "./converse";
import { pickWorstCategories } from "./content-gen";
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
    const worst = pickWorstCategories(categoryBadRates(deps.db, deps.sentences));

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
