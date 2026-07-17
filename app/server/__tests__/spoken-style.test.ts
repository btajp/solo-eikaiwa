import { describe, expect, test } from "bun:test";
import { SPOKEN_STYLE_BLOCK, spokenStyleFor } from "../spoken-style";

describe("SPOKEN_STYLE_BLOCK", () => {
  test("短縮形をデフォルトにする指示を含む", () => {
    expect(SPOKEN_STYLE_BLOCK).toContain("contractions");
    expect(SPOKEN_STYLE_BLOCK).toContain("I'm");
    expect(SPOKEN_STYLE_BLOCK).toContain("don't");
  });

  test("書き言葉語彙の禁止例(moreover/utilize/furthermore/therefore)を含む", () => {
    expect(SPOKEN_STYLE_BLOCK).toContain("moreover");
    expect(SPOKEN_STYLE_BLOCK).toContain("furthermore");
    expect(SPOKEN_STYLE_BLOCK).toContain("utilize");
    expect(SPOKEN_STYLE_BLOCK).toContain("therefore");
    expect(SPOKEN_STYLE_BLOCK).toContain("so");
  });

  test("「実際に声に出して話すように書く」の指示を含む", () => {
    expect(SPOKEN_STYLE_BLOCK).toContain("spoken aloud");
    expect(SPOKEN_STYLE_BLOCK).toContain("listened to");
  });

  test("リスト・見出し形式の禁止を含む", () => {
    expect(SPOKEN_STYLE_BLOCK).toContain("bullet points");
    expect(SPOKEN_STYLE_BLOCK).toContain("headings");
  });
});

describe("spokenStyleFor", () => {
  test("どの帯でも SPOKEN_STYLE_BLOCK 本体を含む", () => {
    for (const band of ["beginner", "intermediate", "advanced"] as const) {
      expect(spokenStyleFor(band)).toContain(SPOKEN_STYLE_BLOCK);
    }
  });

  test("帯ごとに異なる文長ガイドを返す", () => {
    const beginner = spokenStyleFor("beginner");
    const intermediate = spokenStyleFor("intermediate");
    const advanced = spokenStyleFor("advanced");
    expect(beginner).not.toBe(intermediate);
    expect(intermediate).not.toBe(advanced);
    expect(beginner).not.toBe(advanced);
  });

  test("beginner は最短の文長上限(6-10 words)を提示する", () => {
    expect(spokenStyleFor("beginner")).toContain("6-10 words");
  });

  test("advanced も長文エッセイ化を防ぐ文長上限(10-15 words)を持つ", () => {
    expect(spokenStyleFor("advanced")).toContain("10-15 words");
  });

  // T3差し戻し: beginner帯が短縮形率チェック(閾値0.2)に系統的にFAILしたため、
  // 「簡単な語彙 ≠ 丁寧体」の優先順位明示 + 定量ノルマを追加する。
  test("beginner は「簡単な語彙は丁寧体を意味しない・短縮形は必須」という優先順位を明示する", () => {
    const beginner = spokenStyleFor("beginner");
    expect(beginner).toContain("does NOT mean formal");
    expect(beginner).toContain("mandatory");
    expect(beginner).toContain("textbook");
  });

  test("beginner は短縮形の定量ノルマ(3文に1回以上・目安2文に1回)を含む", () => {
    const beginner = spokenStyleFor("beginner");
    expect(beginner).toContain("one of every three sentences");
    expect(beginner).toContain("one in every two");
  });

  // #195再生成で intermediate 帯も短縮形率チェック(閾値0.2)に系統的にFAILする実例を観測した
  // （reporting-a-bug/stage3: 実測7回連続 0.06〜0.13。過去形の体験談トピックで顕著）。beginner で
  // 実績のある mandatory 表現+定量ノルマを intermediate/advanced にも足す（機械ゲート0.2と整合）。
  test("intermediate/advanced も短縮形の mandatory 表現と定量ノルマ(3文に1回以上)を含む", () => {
    for (const band of ["intermediate", "advanced"] as const) {
      expect(spokenStyleFor(band)).toContain("mandatory");
      expect(spokenStyleFor(band)).toContain("one of every three sentences");
      // 過去形narrationでも短縮形が出るよう具体例を明示（実測FAILは過去形体験談で発生した）
      expect(spokenStyleFor(band)).toContain("past-tense narration");
    }
  });

  test("intermediate/advanced の文長ガイドは現行文字列と完全一致する（回帰ロック）", () => {
    const quota =
      "Contractions (I'm, it's, don't, didn't, that's) are mandatory — writing \"I am\" / \"do not\" / \"it is\" throughout turns this into a textbook, not natural speech. " +
      "Use a contraction in at least one of every three sentences (aim for one in every two), even in past-tense narration (didn't, wasn't, couldn't, I'd).";
    expect(spokenStyleFor("intermediate")).toBe(
      `${SPOKEN_STYLE_BLOCK} Keep sentences short: mostly 9-13 words per sentence. ${quota}`,
    );
    expect(spokenStyleFor("advanced")).toBe(
      `${SPOKEN_STYLE_BLOCK} Even at this level, keep sentences short for natural speech: mostly 10-15 words — split a long idea into two short sentences instead of chaining clauses with commas. ${quota}`,
    );
  });
});
