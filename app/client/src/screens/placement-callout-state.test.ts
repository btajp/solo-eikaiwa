import { describe, expect, test } from "bun:test";
import { placementCalloutKind, reservesInitialPlacementSpace } from "./placement-callout-state";

const NOW = new Date("2026-07-11T12:00:00.000Z").getTime();
const RECENT = {
  id: 1, ts: "2026-07-01T12:00:00.000Z", stage: 2, startLevel: 8, rationale: "Recent",
};
const OLD = { ...RECENT, ts: "2026-06-01T12:00:00.000Z" };

describe("ホームのレベル測定導線", () => {
  test("結果を待つ間や取得不能時は初期枠を確保し、未測定とは表示しない", () => {
    expect(reservesInitialPlacementSpace("loading")).toBe(true);
    expect(placementCalloutKind("loading", NOW)).toBe("none");
    expect(reservesInitialPlacementSpace("unavailable")).toBe(true);
    expect(placementCalloutKind("unavailable", NOW)).toBe("none");
  });

  test("未測定・月次測定・測定不要を結果ごとに決める", () => {
    expect(placementCalloutKind(null, NOW)).toBe("new");
    expect(placementCalloutKind(OLD, NOW)).toBe("monthly");
    expect(placementCalloutKind(RECENT, NOW)).toBe("none");
    expect(reservesInitialPlacementSpace(RECENT)).toBe(false);
  });
});
