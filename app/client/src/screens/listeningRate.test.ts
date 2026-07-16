import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LISTENING_PLAYBACK_RATE,
  LISTENING_PLAYBACK_RATES,
  formatPlaybackRate,
} from "./listeningRate";

describe("リスニング再生速度 (#194 UI側)", () => {
  test("入門帯の実測話速(約190WPM)を140WPM以下へ落とせる選択肢がある", () => {
    // 実測最大 212WPM でも 0.7x なら 148WPM、平均 189WPM なら 132WPM ≤ 140WPM
    const slowest = Math.min(...LISTENING_PLAYBACK_RATES);
    expect(slowest).toBeLessThanOrEqual(0.7);
    expect(189 * slowest).toBeLessThanOrEqual(140);
  });

  test("既定は等速 1x（既存の聴取体験を変えない）", () => {
    expect(DEFAULT_LISTENING_PLAYBACK_RATE).toBe(1);
    expect(LISTENING_PLAYBACK_RATES).toContain(DEFAULT_LISTENING_PLAYBACK_RATE);
  });

  test("選択肢は遅い→速いの順で並び、重複がない", () => {
    const sorted = [...LISTENING_PLAYBACK_RATES].sort((a, b) => a - b);
    expect([...LISTENING_PLAYBACK_RATES]).toEqual(sorted);
    expect(new Set(LISTENING_PLAYBACK_RATES).size).toBe(LISTENING_PLAYBACK_RATES.length);
  });

  test("ボタン表記は 0.7x / 1x のような短い倍率表記になる", () => {
    expect(formatPlaybackRate(0.7)).toBe("0.7x");
    expect(formatPlaybackRate(0.85)).toBe("0.85x");
    expect(formatPlaybackRate(1)).toBe("1x");
    expect(formatPlaybackRate(1.25)).toBe("1.25x");
  });
});
