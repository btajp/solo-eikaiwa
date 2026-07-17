import { describe, expect, test } from "bun:test";
import {
  BOUNDARY_LEVELS, cefrBandLabel, DEFAULT_LEVEL, demotionTargetLevel, fttMiniRoundsSec, fttRoundsSec,
  needXp, PLACEMENT_XP, prepParams, stageAnchorLevel, stageOf, syntaxConstraint, vocabConstraint, xpForGrade,
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

  // #195: stage>=4 の null（=呼び出し点がB1固定文言へフォールバック）を廃止し、B1-B2→B2→B2-C1 の勾配を返す
  test("stage 4/5/6 は B1-B2 / B2 / B2-C1 の語彙勾配文字列を返す（B1頭打ちの廃止）", () => {
    expect(vocabConstraint(4)).toContain("B1-B2");
    expect(vocabConstraint(5)).toContain("CEFR B2");
    expect(vocabConstraint(5)).not.toContain("B1");
    expect(vocabConstraint(6)).toContain("B2-C1");
    expect(new Set([vocabConstraint(4), vocabConstraint(5), vocabConstraint(6)]).size).toBe(3);
  });

  test("stage 5/6 は慣用表現・句動詞を許容する（語彙面の i+1 を上級帯にも作る）", () => {
    expect(vocabConstraint(5)).toContain("idioms");
    expect(vocabConstraint(6)).toContain("idioms");
    // 4 は従来のB1像を保ち、レアな慣用表現は禁止のまま
    expect(vocabConstraint(4)).toContain("No rare idioms");
  });
});

describe("progression: syntaxConstraint", () => {
  test("stage 1〜2 はA2水準・1文6-10語の制約文字列を返す", () => {
    for (const s of [1, 2]) {
      expect(syntaxConstraint(s)).toContain("CEFR A2");
      expect(syntaxConstraint(s)).toContain("6-10 words");
    }
  });

  test("stage 3 はA2-B1水準・1文8-12語の制約文字列を返す", () => {
    expect(syntaxConstraint(3)).toContain("CEFR A2-B1");
    expect(syntaxConstraint(3)).toContain("8-12 words");
  });

  // #195: stage>=4 の構文・文長も勾配化。文長帯は stage3(8-12) から単調に上がり、
  // spoken-register 閾値（intermediate: 平均14語/文・advanced: 16語/文）の内側に収まる値にする
  test("stage 4/5/6 は B1-B2/B2/B2-C1 と単調増加の文長帯（9-13/10-14/11-15語）を返す", () => {
    expect(syntaxConstraint(4)).toContain("CEFR B1-B2");
    expect(syntaxConstraint(4)).toContain("9-13 words");
    expect(syntaxConstraint(5)).toContain("CEFR B2");
    expect(syntaxConstraint(5)).toContain("10-14 words");
    expect(syntaxConstraint(6)).toContain("CEFR B2-C1");
    expect(syntaxConstraint(6)).toContain("11-15 words");
  });

  test("stage 5/6 は複文・条件文などの構文複雑度を明示的に許容する", () => {
    expect(syntaxConstraint(5)).toContain("conditionals");
    expect(syntaxConstraint(6)).toContain("conditionals");
    expect(syntaxConstraint(4)).toContain("subordinate");
  });
});

describe("progression: cefrBandLabel", () => {
  test("stage 1..6 → A2 / A2 / A2-B1 / B1-B2 / B2 / B2-C1（プロンプト難度表記の一元定義）", () => {
    expect(cefrBandLabel(1)).toBe("A2");
    expect(cefrBandLabel(2)).toBe("A2");
    expect(cefrBandLabel(3)).toBe("A2-B1");
    expect(cefrBandLabel(4)).toBe("B1-B2");
    expect(cefrBandLabel(5)).toBe("B2");
    expect(cefrBandLabel(6)).toBe("B2-C1");
  });

  test("範囲外は端にクランプ（Lv61+のstage6張り付きと同じ思想）", () => {
    expect(cefrBandLabel(0)).toBe("A2");
    expect(cefrBandLabel(7)).toBe("B2-C1");
  });
});
