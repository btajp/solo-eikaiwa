import { extractErrorMessage } from "./http";

export type AggregatedMetrics = {
  utterances: number; words: number; speechMs: number; totalMs: number;
  pauseMs: number; repetitionWords: number; repetitionWeightedWords: number; speakingSec: number;
  avgArticulationWpm: number; avgPauseRatio: number; repetitionRatio: number;
};
export type DayMetrics = AggregatedMetrics & { ymd: string };
export type MetricsSummary = {
  days: DayMetrics[];
  weekly: { current: AggregatedMetrics; previous: AggregatedMetrics };
  level: { current: number; history: Array<{ ymd: string; level: number }> };
};

/** 進捗ダッシュボード用の日別メトリクス集計 */
export async function fetchMetricsSummary(days = 14): Promise<MetricsSummary> {
  const res = await fetch(`/api/metrics/summary?days=${days}`);
  if (!res.ok) throw new Error(`metrics failed: ${await extractErrorMessage(res)}`);
  return res.json();
}
