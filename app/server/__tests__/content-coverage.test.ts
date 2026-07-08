import { describe, expect, test } from "bun:test";
import {
  bandForStage,
  isBridgeItem,
  computeStageCells,
  findBridgeItems,
  computeCoverageReport,
  QUOTA_PER_BAND_DOMAIN,
  BANDS,
  BAND_STAGE_RANGE,
  type CoverageItem,
} from "../content-coverage";

describe("bandForStage", () => {
  test("stage1-2 は foundation", () => {
    expect(bandForStage(1)).toBe("foundation");
    expect(bandForStage(2)).toBe("foundation");
  });
  test("stage3-4 は development", () => {
    expect(bandForStage(3)).toBe("development");
    expect(bandForStage(4)).toBe("development");
  });
  test("stage5-6 は fluency", () => {
    expect(bandForStage(5)).toBe("fluency");
    expect(bandForStage(6)).toBe("fluency");
  });
});

describe("BANDS / BAND_STAGE_RANGE", () => {
  test("3帯・各2stage分の範囲を持つ", () => {
    expect(BANDS).toEqual(["foundation", "development", "fluency"]);
    expect(BAND_STAGE_RANGE.foundation).toEqual([1, 2]);
    expect(BAND_STAGE_RANGE.development).toEqual([3, 4]);
    expect(BAND_STAGE_RANGE.fluency).toEqual([5, 6]);
  });
});

describe("isBridgeItem", () => {
  test("同一帯に収まる範囲は bridge ではない", () => {
    expect(isBridgeItem([1, 2])).toBe(false);
    expect(isBridgeItem([3, 4])).toBe(false);
    expect(isBridgeItem([5, 6])).toBe(false);
    expect(isBridgeItem([2, 2])).toBe(false);
  });

  test("複数帯にまたがる範囲は bridge（既存の広範囲教材の典型形）", () => {
    expect(isBridgeItem([1, 3])).toBe(true); // foundation→development
    expect(isBridgeItem([1, 4])).toBe(true); // foundation→development
    expect(isBridgeItem([2, 4])).toBe(true); // foundation→development
    expect(isBridgeItem([2, 5])).toBe(true); // foundation→development→fluency
    expect(isBridgeItem([3, 5])).toBe(true); // development→fluency
    expect(isBridgeItem([3, 6])).toBe(true); // development→fluency
    expect(isBridgeItem([4, 6])).toBe(true); // development→fluency
    expect(isBridgeItem([1, 6])).toBe(true); // 全帯
  });
});

describe("computeStageCells", () => {
  test("帯内に収まる教材4本ちょうどで quota(topics=4) を満たす", () => {
    const items: CoverageItem[] = [
      { id: "a", domain: "daily", level: [1, 2] },
      { id: "b", domain: "daily", level: [1, 2] },
      { id: "c", domain: "daily", level: [1, 2] },
      { id: "d", domain: "daily", level: [1, 2] },
    ];
    const cells = computeStageCells("topics", items, ["daily"]);
    const stage1 = cells.find((c) => c.stage === 1)!;
    const stage2 = cells.find((c) => c.stage === 2)!;
    expect(stage1.fittingCount).toBe(4);
    expect(stage1.met).toBe(true);
    expect(stage1.shortfall).toBe(0);
    expect(stage2.fittingCount).toBe(4);
    expect(stage2.met).toBe(true);
    // 他stage(3-6)は0本なので不足
    const stage3 = cells.find((c) => c.stage === 3)!;
    expect(stage3.fittingCount).toBe(0);
    expect(stage3.met).toBe(false);
    expect(stage3.shortfall).toBe(4);
  });

  test("bridge教材(範囲が帯をまたぐ)は quota 集計から除外される", () => {
    const items: CoverageItem[] = [
      { id: "bridge1", domain: "daily", level: [1, 4] }, // stage1,2,3,4 いずれもカバーしうるが bridge
      { id: "bridge2", domain: "daily", level: [1, 4] },
      { id: "bridge3", domain: "daily", level: [1, 4] },
      { id: "bridge4", domain: "daily", level: [1, 4] },
    ];
    const cells = computeStageCells("topics", items, ["daily"]);
    for (const stage of [1, 2, 3, 4]) {
      const cell = cells.find((c) => c.stage === stage)!;
      expect(cell.fittingCount).toBe(0);
      expect(cell.met).toBe(false);
    }
  });

  test("片方の stage だけ満たす教材があれば帯内でも stage ごとに met が変わる", () => {
    // [5,5] は stage5 のみ適合。stage6 には適合しない（[5,6]自体は帯内だが範囲が狭いため）
    const items: CoverageItem[] = [
      { id: "s5-1", domain: "it", level: [5, 5] },
      { id: "s5-2", domain: "it", level: [5, 5] },
      { id: "s5-3", domain: "it", level: [5, 5] },
      { id: "s5-4", domain: "it", level: [5, 5] },
    ];
    const cells = computeStageCells("topics", items, ["it"]);
    const stage5 = cells.find((c) => c.stage === 5)!;
    const stage6 = cells.find((c) => c.stage === 6)!;
    expect(stage5.fittingCount).toBe(4);
    expect(stage5.met).toBe(true);
    expect(stage6.fittingCount).toBe(0);
    expect(stage6.met).toBe(false);
  });

  test("[5,6]の1本は stage5・stage6 の両方の適合数にカウントされる", () => {
    const items: CoverageItem[] = [{ id: "wide", domain: "it", level: [5, 6] }];
    const cells = computeStageCells("topics", items, ["it"]);
    const stage5 = cells.find((c) => c.stage === 5)!;
    const stage6 = cells.find((c) => c.stage === 6)!;
    expect(stage5.fittingCount).toBe(1);
    expect(stage6.fittingCount).toBe(1);
    expect(stage5.fittingIds).toEqual(["wide"]);
  });

  test("domain違い・kind違い(quota値違い)は独立して集計する", () => {
    const items: CoverageItem[] = [
      { id: "d1", domain: "daily", level: [1, 2] },
      { id: "d2", domain: "daily", level: [1, 2] },
      { id: "d3", domain: "daily", level: [1, 2] },
      { id: "b1", domain: "business", level: [1, 2] },
    ];
    const cells = computeStageCells("scenarios", items); // scenarios quota=3
    const dailyStage1 = cells.find((c) => c.domain === "daily" && c.stage === 1)!;
    const businessStage1 = cells.find((c) => c.domain === "business" && c.stage === 1)!;
    expect(dailyStage1.quota).toBe(3);
    expect(dailyStage1.fittingCount).toBe(3);
    expect(dailyStage1.met).toBe(true);
    expect(businessStage1.fittingCount).toBe(1);
    expect(businessStage1.met).toBe(false);
    expect(businessStage1.shortfall).toBe(2);
  });

  test("既定 domains は DOMAINS 全件(daily/business/it) を対象にする", () => {
    const cells = computeStageCells("topics", []);
    const domains = new Set(cells.map((c) => c.domain));
    expect(domains).toEqual(new Set(["daily", "business", "it"]));
    expect(cells.length).toBe(3 * 6); // 3domain × 6stage
  });
});

describe("QUOTA_PER_BAND_DOMAIN", () => {
  test("確定数量表と一致する(topics4/scenarios3/listening4)", () => {
    expect(QUOTA_PER_BAND_DOMAIN).toEqual({ topics: 4, scenarios: 3, listening: 4 });
  });
});

describe("findBridgeItems", () => {
  test("bridgeのみ抽出し、非bridgeは含めない", () => {
    const items: CoverageItem[] = [
      { id: "narrow", domain: "daily", level: [1, 2] },
      { id: "wide", domain: "daily", level: [1, 4] },
    ];
    expect(findBridgeItems(items)).toEqual([{ id: "wide", domain: "daily", level: [1, 4] }]);
  });

  test("bridgeが無ければ空配列", () => {
    expect(findBridgeItems([{ id: "narrow", domain: "it", level: [5, 6] }])).toEqual([]);
  });
});

describe("computeCoverageReport", () => {
  test("cells・bridgeItems・shortfalls(不足セルのみ)をまとめて返す", () => {
    const items: CoverageItem[] = [
      { id: "wide", domain: "daily", level: [1, 4] },
      { id: "narrow", domain: "daily", level: [1, 2] },
    ];
    const report = computeCoverageReport("topics", items);
    expect(report.type).toBe("topics");
    expect(report.bridgeItems).toEqual([{ id: "wide", domain: "daily", level: [1, 4] }]);
    // narrowはstage1,2のみ1本(quota4未満)なので daily の全stageが不足
    expect(report.shortfalls.length).toBeGreaterThan(0);
    expect(report.shortfalls.every((c) => c.shortfall > 0)).toBe(true);
    expect(report.cells.length).toBe(3 * 6);
  });

  test("全セルquota充足なら shortfalls は空", () => {
    const items: CoverageItem[] = [];
    for (const domain of ["daily", "business", "it"] as const) {
      for (const level of [[1, 2], [3, 4], [5, 6]] as const) {
        for (let i = 0; i < 4; i++) {
          items.push({ id: `${domain}-${level[0]}-${i}`, domain, level: [level[0], level[1]] });
        }
      }
    }
    const report = computeCoverageReport("topics", items);
    expect(report.shortfalls).toEqual([]);
  });
});
