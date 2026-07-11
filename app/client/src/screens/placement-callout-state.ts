import type { PlacementLatest } from "../api";

export type PlacementLatestState = PlacementLatest | "loading" | "unavailable";
export type PlacementCalloutKind = "new" | "monthly" | "none";

/** ホーム上部の測定導線は、取得結果を確認できるまで専用枠を確保する。 */
export function placementCalloutKind(latest: PlacementLatestState, now: number): PlacementCalloutKind {
  if (latest === "loading" || latest === "unavailable") return "none";
  if (latest === null) return "new";

  const completedAt = Date.parse(latest.ts);
  if (!Number.isFinite(completedAt)) return "none";
  return now - completedAt >= 30 * 24 * 60 * 60 * 1000 ? "monthly" : "none";
}

export function reservesInitialPlacementSpace(latest: PlacementLatestState): boolean {
  return latest === "loading" || latest === "unavailable";
}
