import { describe, expect, test } from "bun:test";
import { healthRetryDelay } from "./health-retry";

describe("health の限定再接続", () => {
  test("3回まで待機時間を返し、それ以降は自動再試行しない", () => {
    expect(healthRetryDelay(1)).toBe(1_000);
    expect(healthRetryDelay(2)).toBe(3_000);
    expect(healthRetryDelay(3)).toBe(10_000);
    expect(healthRetryDelay(4)).toBeNull();
  });

  test("不正な試行回数では自動再試行しない", () => {
    expect(healthRetryDelay(0)).toBeNull();
    expect(healthRetryDelay(1.5)).toBeNull();
  });
});
