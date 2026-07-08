import { describe, expect, test } from "bun:test";
import {
  detectBannedCategories,
  looksAbstractTitle,
  checkTopicAnchor,
  BANNED_CATEGORIES,
  type TopicAnchorCandidate,
} from "../topic-anchor-check";

const validCandidate: TopicAnchorCandidate = {
  title: "My Morning Coffee Routine",
  experienceAnchor: "誰でも経験する朝のコーヒーを淹れる場面に接地している",
  memoryCue: "毎朝コーヒーを淹れる自分の姿を思い浮かべる",
  commonObjectsOrActions: ["coffee maker", "mug", "kettle"],
};

describe("checkTopicAnchor: 正常系", () => {
  test("全フィールドが揃い、具体的で禁止カテゴリに該当しなければPASS", () => {
    const result = checkTopicAnchor(validCandidate);
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});

describe("checkTopicAnchor: anchorフィールドの欠落", () => {
  test("experienceAnchorが空文字列ならFAIL", () => {
    const result = checkTopicAnchor({ ...validCandidate, experienceAnchor: "" });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("experienceAnchor"))).toBe(true);
  });

  test("experienceAnchorが未設定(undefined)ならFAIL", () => {
    const result = checkTopicAnchor({ ...validCandidate, experienceAnchor: undefined });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("experienceAnchor"))).toBe(true);
  });

  test("experienceAnchorが空白のみならFAIL", () => {
    const result = checkTopicAnchor({ ...validCandidate, experienceAnchor: "   " });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("experienceAnchor"))).toBe(true);
  });

  test("memoryCueが空文字列ならFAIL", () => {
    const result = checkTopicAnchor({ ...validCandidate, memoryCue: "" });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("memoryCue"))).toBe(true);
  });

  test("memoryCueが文字列でない(数値)ならFAIL", () => {
    const result = checkTopicAnchor({ ...validCandidate, memoryCue: 123 as unknown as string });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("memoryCue"))).toBe(true);
  });
});

describe("checkTopicAnchor: commonObjectsOrActions の境界値", () => {
  test("空配列ならFAIL", () => {
    const result = checkTopicAnchor({ ...validCandidate, commonObjectsOrActions: [] });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("commonObjectsOrActions"))).toBe(true);
  });

  test("配列でない(文字列)ならFAIL", () => {
    const result = checkTopicAnchor({ ...validCandidate, commonObjectsOrActions: "coffee maker" as unknown as string[] });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("commonObjectsOrActions"))).toBe(true);
  });

  test("非文字列要素を含むとFAIL", () => {
    const result = checkTopicAnchor({ ...validCandidate, commonObjectsOrActions: ["mug", 42] as unknown as string[] });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("commonObjectsOrActions"))).toBe(true);
  });

  test("空文字列要素を含むとFAIL", () => {
    const result = checkTopicAnchor({ ...validCandidate, commonObjectsOrActions: ["mug", "  "] });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("commonObjectsOrActions"))).toBe(true);
  });

  test("1件のみでもPASS(非空であればよい)", () => {
    const result = checkTopicAnchor({ ...validCandidate, commonObjectsOrActions: ["mug"] });
    expect(result.pass).toBe(true);
  });
});

describe("detectBannedCategories", () => {
  test("5カテゴリすべてを網羅する定数リスト", () => {
    expect(BANNED_CATEGORIES).toEqual([
      "abstract",
      "specialist",
      "current-affairs",
      "rare-hobby",
      "personal-info-required",
    ]);
  });

  test("abstract: philosophy/metaphysics等を検出", () => {
    expect(detectBannedCategories("A discussion about philosophy and consciousness")).toContain("abstract");
  });

  test("specialist: quantum mechanics等を検出", () => {
    expect(detectBannedCategories("An introduction to quantum mechanics")).toContain("specialist");
  });

  test("current-affairs: breaking news等を検出", () => {
    expect(detectBannedCategories("Breaking news about the election")).toContain("current-affairs");
  });

  test("rare-hobby: falconry等を検出", () => {
    expect(detectBannedCategories("My weekend falconry practice")).toContain("rare-hobby");
  });

  test("personal-info-required: passport number等を検出", () => {
    expect(detectBannedCategories("Please tell me your passport number")).toContain("personal-info-required");
  });

  test("該当なしなら空配列", () => {
    expect(detectBannedCategories("My morning coffee routine before work")).toEqual([]);
  });

  test("複数カテゴリに同時該当する場合は複数返す", () => {
    const hits = detectBannedCategories("Breaking news about quantum mechanics and philosophy");
    expect(hits).toContain("current-affairs");
    expect(hits).toContain("specialist");
    expect(hits).toContain("abstract");
  });
});

describe("looksAbstractTitle", () => {
  test("具体名詞ヒントを含むタイトルはfalse(抽象ではない)", () => {
    expect(looksAbstractTitle("My Morning Coffee Routine")).toBe(false);
    expect(looksAbstractTitle("Fixing a Small Bug")).toBe(false);
    expect(looksAbstractTitle("A Meeting With My Manager")).toBe(false);
  });

  test("具体名詞ヒントを含まないタイトルはtrue(抽象の可能性)", () => {
    expect(looksAbstractTitle("The Meaning of Existence")).toBe(true);
    expect(looksAbstractTitle("Freedom and Justice")).toBe(true);
  });
});

describe("checkTopicAnchor: 禁止カテゴリ・抽象タイトルの統合", () => {
  test("抽象的なタイトル+experienceAnchorが希薄だと複数理由でFAILする", () => {
    const result = checkTopicAnchor({
      title: "The Philosophy of Existence",
      experienceAnchor: "existential philosophy and the nature of consciousness",
      memoryCue: "何かを思い出す",
      commonObjectsOrActions: ["idea"],
    });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("禁止カテゴリ"))).toBe(true);
    expect(result.reasons.some((r) => r.includes("抽象的"))).toBe(true);
  });

  test("具体的な題材はexperienceAnchorに禁止語が無ければ禁止カテゴリの理由は付かない", () => {
    const result = checkTopicAnchor(validCandidate);
    expect(result.reasons.some((r) => r.includes("禁止カテゴリ"))).toBe(false);
  });
});
