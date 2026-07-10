import path from "node:path";
import type { Database } from "bun:sqlite";
import { addDaysYmd, localYmd } from "./dates";
import { readEvents } from "./session-log";
import { SESSIONS_DIR } from "./paths";
import type { UtteranceMetrics } from "./metrics";

export type MetricTotals = {
  utterances: number;
  words: number;
  speechMs: number;
  totalMs: number;
  pauseMs: number;
  repetitionWords: number;
  repetitionWeightedWords: number;
};

export type AggregatedMetrics = MetricTotals & {
  speakingSec: number;
  avgArticulationWpm: number;
  avgPauseRatio: number;
  repetitionRatio: number;
};

export type DayMetrics = AggregatedMetrics & { ymd: string };

export type MetricsSummary = {
  days: DayMetrics[];
  weekly: { current: AggregatedMetrics; previous: AggregatedMetrics };
  level: { current: number; history: Array<{ ymd: string; level: number }> };
};

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** 率の再平均を避け、各日のraw分子・分母を合算して期間指標を算出する。 */
export function aggregateMetricDays(days: MetricTotals[]): AggregatedMetrics {
  const totals = days.reduce<MetricTotals>((sum, day) => ({
    utterances: sum.utterances + day.utterances,
    words: sum.words + day.words,
    speechMs: sum.speechMs + day.speechMs,
    totalMs: sum.totalMs + day.totalMs,
    pauseMs: sum.pauseMs + day.pauseMs,
    repetitionWords: sum.repetitionWords + day.repetitionWords,
    repetitionWeightedWords: sum.repetitionWeightedWords + day.repetitionWeightedWords,
  }), {
    utterances: 0, words: 0, speechMs: 0, totalMs: 0, pauseMs: 0,
    repetitionWords: 0, repetitionWeightedWords: 0,
  });
  return {
    ...totals,
    speakingSec: Math.round(totals.speechMs / 1000),
    avgArticulationWpm: totals.speechMs > 0 ? round1(totals.words / (totals.speechMs / 60_000)) : 0,
    avgPauseRatio: totals.totalMs > 0 ? round3(totals.pauseMs / totals.totalMs) : 0,
    repetitionRatio: totals.repetitionWords > 0
      ? round3(totals.repetitionWeightedWords / totals.repetitionWords)
      : 0,
  };
}

/** 直近N日のセッションログとlevel_eventsから進捗サマリを作る（stt_result のみ集計） */
export function makeMetricsSummary(deps: { db: Database; sessionsDir?: string; currentLevel: () => number }) {
  const dir = deps.sessionsDir ?? SESSIONS_DIR;
  return function metricsSummary(days: number, today = localYmd()): MetricsSummary {
    const byYmd = new Map<string, DayMetrics>();
    for (let i = Math.max(days, 14) - 1; i >= 0; i--) {
      const ymd = addDaysYmd(today, -i);
      let words = 0, speechMs = 0, totalMs = 0, pauseMs = 0;
      let utterances = 0, repetitionWords = 0, repWeighted = 0;
      for (const e of readEvents(path.join(dir, `${ymd}.jsonl`))) {
        if (e.type !== "stt_result") continue;
        const m = (e.meta as { metrics?: UtteranceMetrics } | undefined)?.metrics;
        if (!m || typeof m.words !== "number" || typeof m.speechMs !== "number") continue;
        utterances++;
        words += m.words;
        speechMs += m.speechMs;
        if (typeof m.totalMs === "number" && typeof m.pauses?.totalMs === "number") {
          totalMs += m.totalMs;
          pauseMs += m.pauses.totalMs;
        }
        if (typeof m.repetitionRatio === "number") {
          repetitionWords += m.words;
          repWeighted += m.repetitionRatio * m.words;
        }
      }
      const totals: MetricTotals = {
        utterances, words, speechMs, totalMs, pauseMs,
        repetitionWords, repetitionWeightedWords: repWeighted,
      };
      byYmd.set(ymd, {
        ymd,
        ...aggregateMetricDays([totals]),
      });
    }
    const out = Array.from({ length: days }, (_, index) =>
      byYmd.get(addDaysYmd(today, -(days - 1 - index)))!);
    const currentWeek = Array.from({ length: 7 }, (_, index) =>
      byYmd.get(addDaysYmd(today, -(6 - index)))!);
    const previousWeek = Array.from({ length: 7 }, (_, index) =>
      byYmd.get(addDaysYmd(today, -(13 - index)))!);
    const rows = deps.db
      .query<{ ymd: string; to_level: number }, []>("SELECT ymd, to_level FROM level_events WHERE kind IN ('accept-up','accept-down','manual-set','placement-set') ORDER BY id")
      .all();
    const lastByYmd = new Map<string, number>();
    for (const r of rows) lastByYmd.set(r.ymd, r.to_level);
    const history = [...lastByYmd.entries()]
      .map(([ymd, level]) => ({ ymd, level }))
      .sort((a, b) => (a.ymd < b.ymd ? -1 : 1));
    return {
      days: out,
      weekly: {
        current: aggregateMetricDays(currentWeek),
        previous: aggregateMetricDays(previousWeek),
      },
      level: { current: deps.currentLevel(), history },
    };
  };
}
