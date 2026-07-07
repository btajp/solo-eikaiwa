import { describe, expect, test } from "bun:test";
import {
  BOUNDARY_LEVELS, DEFAULT_LEVEL, demotionTargetLevel, fttMiniRoundsSec, fttRoundsSec,
  needXp, PLACEMENT_XP, prepParams, stageAnchorLevel, stageOf, vocabConstraint, xpForGrade,
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
  test("stage駆動の非線形カーブ（丸め順序込みの検算値）", () => {
    expect(fttRoundsSec(1)).toEqual([60, 45, 30]);
    expect(fttRoundsSec(5)).toEqual([80, 60, 40]);   // DEFAULT_LEVEL(stage1)
    expect(fttRoundsSec(10)).toEqual([100, 75, 50]);
    expect(fttRoundsSec(11)).toEqual([105, 80, 55]); // stage2 開始（現行と同値）
    expect(fttRoundsSec(13)).toEqual([110, 85, 55]); // 既存ユーザー帯（現行と同値）
    expect(fttRoundsSec(21)).toEqual([125, 95, 65]);
    expect(fttRoundsSec(60)).toEqual([180, 135, 90]); // 上限維持
  });
  test("Lv61以降は難易度据え置き（Lv60と同値）", () => {
    expect(fttRoundsSec(61)).toEqual(fttRoundsSec(60));
    expect(fttRoundsSec(100)).toEqual(fttRoundsSec(60));
  });
  test("ミニ版は先頭2ラウンド", () => {
    expect(fttMiniRoundsSec(13)).toEqual([110, 85]);
    expect(fttMiniRoundsSec(21)).toEqual([125, 95]);
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
  test("DEFAULT_LEVEL は 5（stage 1・測定しない初学者の出だしを軽くする）", () => {
    expect(DEFAULT_LEVEL).toBe(5);
    expect(stageOf(DEFAULT_LEVEL)).toBe(1);
  });
  test("境界レベルは 10,20,30,40,50（60は含まない: 60→61は同stage）", () => {
    expect([...BOUNDARY_LEVELS]).toEqual([10, 20, 30, 40, 50]);
  });
  test("降格先は一つ下のstageの開始アンカー（例: Lv23→15、Lv13→5、Lv75→45）", () => {
    expect(demotionTargetLevel(23)).toBe(15);
    expect(demotionTargetLevel(13)).toBe(5);
    expect(demotionTargetLevel(75)).toBe(45);
  });
  test("stageAnchorLevel は各stageの代表アンカー（(stage-1)*10+5）", () => {
    expect(stageAnchorLevel(1)).toBe(5);
    expect(stageAnchorLevel(2)).toBe(15);
    expect(stageAnchorLevel(6)).toBe(55);
  });
  test("XP換算は good=2・soso=1・bad=1（bad でも参加XPは付く）・placement=10", () => {
    expect(xpForGrade("good")).toBe(2);
    expect(xpForGrade("soso")).toBe(1);
    expect(xpForGrade("bad")).toBe(1);
    expect(PLACEMENT_XP).toBe(10);
  });
});

describe("progression: vocabConstraint", () => {
  test("stage 1〜3 は高頻度語彙(word families)制約の文字列を返す", () => {
    for (const s of [1, 2, 3]) {
      expect(vocabConstraint(s)).toContain("word families");
    }
  });

  test("stage 4+ は null（制約なし。各呼び出し点が自サイトの旧文言をそのまま使う）", () => {
    for (const s of [4, 5, 6]) {
      expect(vocabConstraint(s)).toBeNull();
    }
  });
});
