import { describe, expect, test } from "bun:test";
import {
  detectBannedCategories,
  looksAbstractTitle,
  checkTopicAnchor,
  auditTopicAnchors,
  BANNED_CATEGORIES,
  LEGACY_UNANCHORED_TOPIC_IDS,
  type TopicAnchorCandidate,
} from "../topic-anchor-check";
import { loadContent } from "../content";
import { TOPICS_DIR } from "../paths";

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
  test("通常の具体的なタイトルはfalse（既定はfalse — 誤検出を避ける設計）", () => {
    expect(looksAbstractTitle("My Morning Coffee Routine")).toBe(false);
    expect(looksAbstractTitle("Fixing a Small Bug")).toBe(false);
    expect(looksAbstractTitle("A Meeting With My Manager")).toBe(false);
    // 実データ較正: 旧実装（no concrete noun heuristic）はここをfalse positiveしていた
    expect(looksAbstractTitle("Data governance in the AI era")).toBe(false);
    expect(looksAbstractTitle("Food you love")).toBe(false);
  });

  test("抽象概念1語のみのタイトルはtrue", () => {
    expect(looksAbstractTitle("Success")).toBe(true);
    expect(looksAbstractTitle("Motivation")).toBe(true);
  });

  test("'The Future of X'型の抽象概念フレーズはtrue", () => {
    expect(looksAbstractTitle("The Meaning of Existence")).toBe(true);
    expect(looksAbstractTitle("The Future of Work")).toBe(true);
  });

  test("複合タイトル('Freedom and Justice')は単語1語一致のパターンに当たらないためfalse（狭いヒューリスティックの既知の限界・false negative）", () => {
    expect(looksAbstractTitle("Freedom and Justice")).toBe(false);
  });
});

describe("looksAbstractTitle: 実データ較正（実在するtopicタイトルが全てPASSすること）", () => {
  test("content/topics/*.md のtitleが1件残らず抽象判定されない（旧実装は14/26でfalse positiveしていた）", () => {
    const topics = loadContent(TOPICS_DIR);
    expect(topics.length).toBeGreaterThanOrEqual(26);
    const flagged = topics.filter((t) => looksAbstractTitle(t.title));
    expect(flagged.map((t) => t.title)).toEqual([]);
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

// #182: 4/3/2候補（content/topics 全件）の「既知の内容」アンカー検証ゲート。
// アンカー未整備の既存お題は LEGACY_UNANCHORED_TOPIC_IDS でgrandfatherし（再生成バッチで解消予定）、
// 一覧に無い未検証お題（新規追加）だけを violation として非ゼロ終了の対象にする。
describe("auditTopicAnchors（4/3/2お題のアンカー検証ゲート・#182）", () => {
  const anchoredTopic = (id: string) => ({
    id,
    title: "Making Coffee at Home",
    experienceAnchor: "毎朝コーヒーをいれる経験から新しい知識なしで話せる。",
    memoryCue: "今朝キッチンでコーヒーをいれた場面を思い出す。",
    commonObjectsOrActions: ["kettle", "mug", "pour hot water"],
  });

  test("checkTopicAnchorをPASSするお題はverifiedに入る", () => {
    const audit = auditTopicAnchors([anchoredTopic("coffee-at-home")]);
    expect(audit.verified).toEqual(["coffee-at-home"]);
    expect(audit.legacyUnanchored).toEqual([]);
    expect(audit.violations).toEqual([]);
  });

  test("#182の再生成完了によりlegacy一覧は空 — かつて grandfather されていた既存idも未アンカーならviolationになる", () => {
    expect(LEGACY_UNANCHORED_TOPIC_IDS).toEqual([]);
    // 再生成完了前は legacyUnanchored として許容されていた id（例: desk-tools）も、一覧が空になった今は
    // アンカー欠落なら violation として非ゼロ終了の対象（grandfather の余地はもう無い）
    const audit = auditTopicAnchors([{ id: "desk-tools", title: "Some Unanchored Topic" }]);
    expect(audit.legacyUnanchored).toEqual([]);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0].id).toBe("desk-tools");
  });

  test("legacy一覧に無い未アンカーお題はviolation（新規お題はアンカー必須）", () => {
    const audit = auditTopicAnchors([{ id: "brand-new-topic", title: "Brand New Topic" }]);
    expect(audit.verified).toEqual([]);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0].id).toBe("brand-new-topic");
    expect(audit.violations[0].reasons.length).toBeGreaterThan(0);
  });

  test("アンカーがあっても禁止カテゴリ該当ならviolation（legacy一覧外）", () => {
    const audit = auditTopicAnchors([{
      ...anchoredTopic("bad-anchor"),
      experienceAnchor: "breaking news about the election を毎日追っている。",
    }]);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0].reasons.some((r) => r.includes("禁止カテゴリ"))).toBe(true);
  });

  test("実在の content/topics 全件がアンカー検証済み（#182受け入れ条件: 4/3/2候補の全お題に検証済みアンカー）", () => {
    const topics = loadContent(TOPICS_DIR);
    expect(topics.length).toBeGreaterThanOrEqual(62);
    const audit = auditTopicAnchors(topics);
    expect(audit.violations).toEqual([]);
    expect(audit.legacyUnanchored).toEqual([]);
    expect(audit.verified.length).toBe(topics.length);
  });
});
