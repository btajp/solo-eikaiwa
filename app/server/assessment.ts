import type { Database } from "bun:sqlite";
import { addDaysYmd, localYmd } from "./dates";
import { defaultRunner, type ClaudeRunner } from "./converse";
import { insertReturningId } from "./db-util";
import type { Sentence } from "./sentences";
import { aggregateMetricDays, type MetricsSummary } from "./metrics-aggregate";
import type { PlacementResultRow } from "./placement";
import { categoryBadRates, pickWorstCategories, type CategoryRate } from "./srs-analytics";

export type MonthData = {
  windowDays: number;
  practicedDays: number;
  speakingSec: number;
  utterances: number;
  /** 30日全体のraw語数 / speechMsから算出する構音速度 */
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
  practiceDays: () => string[];
  currentLevel: () => number;
  placementLatest: () => PlacementResultRow | null;
};

export function makeAssembleMonthData(deps: AssembleDeps) {
  return function assembleMonthData(today: string = localYmd()): MonthData {
    const since = addDaysYmd(today, -29);
    const ms = deps.metricsSummary(30, today);

    const speaking = aggregateMetricDays(ms.days);

    const xpDays = deps.db
      .query<{ ymd: string }, [string, string]>(
        "SELECT DISTINCT ymd FROM xp_events WHERE ymd >= ? AND ymd <= ?")
      .all(since, today)
      .map((row) => row.ymd);
    const practicedDays = new Set([
      ...deps.practiceDays().filter((ymd) => ymd >= since && ymd <= today),
      ...xpDays,
    ]).size;

    const attempts = deps.db
      .query<{ total: number; done: number }, [string, string]>(
        `SELECT COUNT(*) AS total, SUM(a.completed) AS done FROM block_attempts a
         LEFT JOIN block_attempt_outcomes o ON o.attempt_id = a.id
         WHERE a.ymd >= ? AND a.ymd <= ?
           AND (o.attempt_id IS NULL OR o.status IN ('completed', 'aborted'))`)
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
      practicedDays,
      speakingSec: speaking.speakingSec,
      utterances: speaking.utterances,
      avgArticulationWpm: speaking.avgArticulationWpm,
      avgPauseRatio: speaking.avgPauseRatio,
      repetitionRatio: speaking.repetitionRatio,
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
発話指標の扱い: avgArticulationWpm・avgPauseRatio・repetitionRatio は音声認識のセグメント区切りから
算出した推定値で、区切り方によって揺れる。小さな増減を上達・悪化と断定せず、おおまかな傾向としてだけ触れる。
avgPauseRatio は文中の詰まりと文と文の間の考えるポーズを区別できない合算値なので、
「ポーズ全体を減らす」方向の助言をしない（研究上、考えるポーズは問題ではない）。
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

export function ensureAssessmentSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS monthly_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    ymd TEXT NOT NULL,
    text TEXT NOT NULL,
    data_json TEXT NOT NULL
  )`);
}

export function makeAssessmentStore(db: Database): AssessmentStore {
  return {
    save(r) {
      const ts = new Date().toISOString();
      db.run("INSERT INTO monthly_reports (ts, ymd, text, data_json) VALUES (?, ?, ?, ?)",
        [ts, r.ymd, r.text, JSON.stringify(r.data)]);
      return { id: insertReturningId(db), ts, ymd: r.ymd, text: r.text };
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
