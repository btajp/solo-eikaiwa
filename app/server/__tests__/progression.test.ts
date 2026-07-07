import { describe, expect, test } from "bun:test";
import {
  BOUNDARY_LEVELS, DEFAULT_LEVEL, demotionTargetLevel, fttMiniRoundsSec, fttRoundsSec,
  needXp, PLACEMENT_XP, prepParams, stageOf, xpForGrade,
} from "../progression";

describe("progression: stageOf", () => {
  test("境界値: Lv1,10,11,20,21,60,61,100", () => {
    expect(stageOf(1)).toBe(1);
    expect(stageOf(10)).toBe(1);
    expect(stageOf(11)).toBe(2);
    expect(stageOf(20)).toBe(2);
    expect(stageOf(21)).toBe(3);
    expect(stageOf(60)).toBe(6);
    expect(stageOf(61)).toBe(6);
    expect(stageOf(100)).toBe(6);
  });
});

describe("progression: fttRoundsSec", () => {
  test("丸め順序込みの検算値（丸めたfirstに0.75/0.5を掛けて再round5）", () => {
    expect(fttRoundsSec(1)).toEqual([90, 70, 45]);
    expect(fttRoundsSec(10)).toEqual([105, 80, 55]);
    expect(fttRoundsSec(11)).toEqual([105, 80, 55]);
    expect(fttRoundsSec(13)).toEqual([110, 85, 55]);
    expect(fttRoundsSec(21)).toEqual([120, 90, 60]); // 現行固定値と一致
    expect(fttRoundsSec(60)).toEqual([180, 135, 90]);
  });
  test("Lv61以降は難易度据え置き（Lv60と同値）", () => {
    expect(fttRoundsSec(61)).toEqual(fttRoundsSec(60));
    expect(fttRoundsSec(100)).toEqual(fttRoundsSec(60));
  });
  test("ミニ版は先頭2ラウンド", () => {
    expect(fttMiniRoundsSec(13)).toEqual([110, 85]);
    expect(fttMiniRoundsSec(21)).toEqual([120, 90]);
  });
});

describe("progression: needXp", () => {
  test("stage別の必要XPとLv61+の一定値", () => {
    expect(needXp(1)).toBe(20);
    expect(needXp(10)).toBe(20);
    expect(needXp(11)).toBe(25);
    expect(needXp(60)).toBe(45);
    expect(needXp(61)).toBe(45);
    expect(needXp(100)).toBe(45);
  });
});

describe("progression: prepParams", () => {
  test("stage 1..6 の支援パラメータ表", () => {
    expect(prepParams(1)).toEqual({ chunkCount: 8, hintLang: "ja", modelTalk: "auto" });
    expect(prepParams(3)).toEqual({ chunkCount: 6, hintLang: "ja", modelTalk: "auto" });
    expect(prepParams(4)).toEqual({ chunkCount: 5, hintLang: "en", modelTalk: "auto" });
    expect(prepParams(5)).toEqual({ chunkCount: 4, hintLang: "en", modelTalk: "button" });
    expect(prepParams(6)).toEqual({ chunkCount: 4, hintLang: "en", modelTalk: "button" });
  });
});

describe("progression: 定数と降格先", () => {
  test("DEFAULT_LEVEL は 13（stage 2）", () => {
    expect(DEFAULT_LEVEL).toBe(13);
    expect(stageOf(DEFAULT_LEVEL)).toBe(2);
  });
  test("境界レベルは 10,20,30,40,50（60は含まない: 60→61は同stage）", () => {
    expect([...BOUNDARY_LEVELS]).toEqual([10, 20, 30, 40, 50]);
  });
  test("降格先は現ステージ最下端の1つ下（例: Lv23→20、Lv75→50）", () => {
    expect(demotionTargetLevel(23)).toBe(20);
    expect(demotionTargetLevel(11)).toBe(10);
    expect(demotionTargetLevel(75)).toBe(50);
  });
  test("XP換算は good=2・soso=1・bad=1（bad でも参加XPは付く）・placement=10", () => {
    expect(xpForGrade("good")).toBe(2);
    expect(xpForGrade("soso")).toBe(1);
    expect(xpForGrade("bad")).toBe(1);
    expect(PLACEMENT_XP).toBe(10);
  });
});
