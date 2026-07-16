import { describe, expect, test } from "bun:test";
import { MIN_WEEKLY_UTTERANCES, weeklyRateView } from "./metric-reliability";

const week = (utterances: number) => ({ utterances });

describe("週次率カードの信頼性表示", () => {
  test("今週の発話が閾値未満なら値を確定表示しない（データ不足状態）", () => {
    expect(weeklyRateView(week(MIN_WEEKLY_UTTERANCES - 1), week(20), 0.2, 0.1))
      .toEqual({ kind: "insufficient" });
  });

  test("空データ（発話0件）もデータ不足状態", () => {
    expect(weeklyRateView(week(0), week(0), 0, 0)).toEqual({ kind: "insufficient" });
  });

  test("今週は十分・前週が疎なら値は出すが前週比は出さない", () => {
    expect(weeklyRateView(week(MIN_WEEKLY_UTTERANCES), week(1), 0.2, 0.9))
      .toEqual({ kind: "value", trend: null });
  });

  test("両週十分: ±5%超で上下、以内は横ばい", () => {
    expect(weeklyRateView(week(10), week(10), 0.12, 0.1)).toEqual({ kind: "value", trend: "up" });
    expect(weeklyRateView(week(10), week(10), 0.08, 0.1)).toEqual({ kind: "value", trend: "down" });
    expect(weeklyRateView(week(10), week(10), 0.102, 0.1)).toEqual({ kind: "value", trend: "flat" });
  });

  test("前週の値が0のときは、今週も0なら横ばい・正なら上向き（ゼロ除算しない）", () => {
    expect(weeklyRateView(week(10), week(10), 0, 0)).toEqual({ kind: "value", trend: "flat" });
    expect(weeklyRateView(week(10), week(10), 0.05, 0)).toEqual({ kind: "value", trend: "up" });
  });
});
