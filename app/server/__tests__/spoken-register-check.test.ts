import { describe, expect, test } from "bun:test";
import {
  splitSentences,
  countWords,
  countContractions,
  findWrittenVocabHits,
  computeSpokenRegisterMetrics,
  checkSpokenRegister,
  checkModelTalk,
  checkPrepChunk,
  checkScenarioStarter,
  bandForLevel,
  WRITTEN_VOCAB_BAN_LIST,
  THRESHOLDS_BY_BAND,
  PREP_CHUNK_WORD_RANGE,
} from "../spoken-register-check";
import { loadContent } from "../content";
import { loadListening } from "../listening";
import { SCENARIOS_DIR, LISTENING_DIR } from "../paths";

// --- 較正コーパス(共有フィクスチャ・beginner/advanced/intermediateの全較正テストで再利用) ---
// content/sentences/sentences300.json の no.1-10 の en をそのまま抜粋（口語の会話文が並ぶ良好サンプル）
const GOOD_EXCERPT = [
  "I usually skip breakfast and just grab coffee on my way out.",
  "This curry tastes a bit spicy, doesn't it?",
  "My eyesight is getting worse these days, honestly.",
  "My son is always leaving his socks all over the floor.",
  "I'm working from home this week, so just message me anytime.",
  "The weekly meeting starts at nine sharp, so don't be late.",
  "I think we need one more week to finish the report.",
  "I'm meeting a new client on Thursday afternoon.",
  "The deployment is still running, so don't merge anything yet.",
  "This script checks disk usage every five minutes and sends alerts.",
].join(" ");

// content/listening/testing-a-new-app.md 第1段落（初級帯・短縮形0%の教科書調の実例）
const BAD_TEXTBOOK_EXCERPT =
  "I work for a small software company. My job is not to write code. My job is to test the app before other people use it. I look for problems. We call these problems bugs. Every day, I open the app on my phone or my computer and I try different things.";

// content/listening/cleaning-out-the-closet.md 第1段落（上級帯・平均17.7語/文のエッセイ調の実例）
const BAD_ESSAY_EXCERPT =
  "Last Saturday, I finally decided to clean out my closet. It had been a mess for months, and every time I opened the door, something would fall out onto the floor. I told myself I would just spend twenty minutes tidying it up, but of course, that plan didn't work out at all.";

describe("splitSentences", () => {
  test("., !, ? の直後の空白で文を分割する", () => {
    expect(splitSentences("I like coffee. Do you? Yes!")).toEqual(["I like coffee.", "Do you?", "Yes!"]);
  });

  test("Mr. / Dr. などの略語のピリオドでは分割しない", () => {
    expect(splitSentences("Mr. Smith called Dr. Lee. They talked.")).toEqual([
      "Mr. Smith called Dr. Lee.",
      "They talked.",
    ]);
  });

  test("空文字列は空配列", () => {
    expect(splitSentences("")).toEqual([]);
  });
});

describe("countWords", () => {
  test("短縮形は1語として数える", () => {
    expect(countWords("I don't know.")).toBe(3);
  });

  test("空文字列は0語", () => {
    expect(countWords("")).toBe(0);
  });
});

describe("countContractions", () => {
  test("I'm / don't / it's / we've / can't / that's を数える", () => {
    expect(countContractions("I'm sure it's fine. We've tried, but that's not enough — I don't think we can't do it.")).toBe(6);
  });

  test("短縮形が無ければ0", () => {
    expect(countContractions("I am sure it is fine.")).toBe(0);
  });

  test("所有格の's は短縮形として数えない（誤検出防止）", () => {
    expect(countContractions("The manager's desk is clean. My sister's car is red.")).toBe(0);
  });

  test("it's / let's / how's などの既知ホストの's は短縮形として数える", () => {
    expect(countContractions("It's fine.")).toBe(1);
    expect(countContractions("Let's go.")).toBe(1);
    expect(countContractions("How's it going?")).toBe(1);
  });

  test("所有格と短縮形が混在する文でも正しく区別する", () => {
    expect(countContractions("It's the manager's desk, and that's fine.")).toBe(2);
  });
});

describe("findWrittenVocabHits", () => {
  test("禁止語彙（moreover/furthermore/utilize等）を検出する", () => {
    const hits = findWrittenVocabHits("Moreover, we should utilize this. Furthermore, therefore we must act.");
    const terms = hits.map((h) => h.term);
    expect(terms).toContain("moreover");
    expect(terms).toContain("utilize");
    expect(terms).toContain("furthermore");
    expect(terms).toContain("therefore");
  });

  test("フレーズ(in addition)も検出する", () => {
    const hits = findWrittenVocabHits("In addition, we finished early.");
    expect(hits.map((h) => h.term)).toContain("in addition");
  });

  test("禁止語彙が無ければ空配列", () => {
    expect(findWrittenVocabHits("So we just finished it and it's fine.")).toEqual([]);
  });

  test("禁止リストは書き言葉語彙の代表例を含む(Task1 spoken-style.tsのブロックと整合)", () => {
    expect(WRITTEN_VOCAB_BAN_LIST).toContain("moreover");
    expect(WRITTEN_VOCAB_BAN_LIST).toContain("furthermore");
    expect(WRITTEN_VOCAB_BAN_LIST).toContain("utilize");
    expect(WRITTEN_VOCAB_BAN_LIST).toContain("therefore");
  });

  test("活用形（utilized/individually等）でもすり抜けずに検出する", () => {
    const hits = findWrittenVocabHits("We utilized this and individually reviewed it.");
    expect(hits).toEqual([
      { term: "utilize", count: 1 },
      { term: "individual", count: 1 },
    ]);
  });

  test("utilize の他の活用形（utilizes/utilizing/utilization）も検出する", () => {
    expect(findWrittenVocabHits("She utilizes it.").map((h) => h.term)).toContain("utilize");
    expect(findWrittenVocabHits("We are utilizing it.").map((h) => h.term)).toContain("utilize");
    expect(findWrittenVocabHits("The utilization was high.").map((h) => h.term)).toContain("utilize");
  });
});

describe("computeSpokenRegisterMetrics", () => {
  test("文数・語数・平均文長・短縮形率をまとめて返す", () => {
    const metrics = computeSpokenRegisterMetrics("I'm happy. You are not.");
    expect(metrics.sentenceCount).toBe(2);
    expect(metrics.wordCount).toBe(5);
    expect(metrics.avgWordsPerSentence).toBe(2.5);
    expect(metrics.contractionCount).toBe(1);
    expect(metrics.contractionsPerSentence).toBe(0.5);
  });

  test("空文字列は0除算せずゼロを返す", () => {
    const metrics = computeSpokenRegisterMetrics("");
    expect(metrics.sentenceCount).toBe(0);
    expect(metrics.avgWordsPerSentence).toBe(0);
    expect(metrics.contractionsPerSentence).toBe(0);
  });
});

// --- 較正: 実データに対する閾値の固定 ---
// 監査(docs/superpowers/plans/2026-07-09-spoken-register-pack.md)の事実:
//   例文300 = 平均9.58語/文・短縮形37%・書き言葉語彙ほぼ0 → PASS基準のコーパス
//   多聴6本（旧版） = 初級2本 短縮形0%の教科書調 / 上級3本 平均17.8〜19.4語/文のエッセイ調 → FAIL現物
// 閾値: 文長上限は spoken-style.ts の帯別ガイド上限+1語（beginner 11 / intermediate 14 / advanced 16）、
//       短縮形率下限は全帯 0.2（短縮形数/文数）で統一。
// レビュー修正（所有格's除外・禁止語の活用形対応）後の再較正: 所有格除外により例文300コーパスの短縮形率は
// 0.406→0.364へ低下したが閾値0.2に対し十分な余裕(margin+0.164)を維持。多聴6本は全件FAILのまま変わらず、
// うち advanced帯2本(code-review-culture / the-quiet-before-the-deadline)は所有格由来の水増しが消えたことで
// 短縮形率も0.2を下回り、平均文長オーバーに加えて短縮形率不足でも二重にFAILするようになった（詳細は
// .superpowers/sdd/task-2-report.md の「レビュー修正」節の較正表を参照）。
describe("較正: 例文300(実データ抜粋) は PASS する", () => {
  test("beginner帯の閾値でPASSする", () => {
    const result = checkSpokenRegister(GOOD_EXCERPT, "beginner");
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test("平均文長11語未満・短縮形率0.2以上である（数値の固定）", () => {
    const metrics = computeSpokenRegisterMetrics(GOOD_EXCERPT);
    expect(metrics.avgWordsPerSentence).toBeLessThan(THRESHOLDS_BY_BAND.beginner.maxAvgWordsPerSentence);
    expect(metrics.contractionsPerSentence).toBeGreaterThanOrEqual(THRESHOLDS_BY_BAND.beginner.minContractionsPerSentence);
  });
});

describe("較正: 多聴6本(旧版・実データ抜粋)はFAILする", () => {
  test("初級帯: 短縮形率0でFAILする（教科書調）", () => {
    const result = checkSpokenRegister(BAD_TEXTBOOK_EXCERPT, "beginner");
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("短縮形率"))).toBe(true);
  });

  test("上級帯: 平均文長オーバーでFAILする（エッセイ調）", () => {
    const result = checkSpokenRegister(BAD_ESSAY_EXCERPT, "advanced");
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("平均文長"))).toBe(true);
  });
});

describe("bandForLevel", () => {
  test("level[1]<=3 は beginner（[1,2]foundation・[1,3]旧下帯とも該当）", () => {
    expect(bandForLevel([1, 2])).toBe("beginner");
    expect(bandForLevel([1, 3])).toBe("beginner");
  });

  test("level[0]>=4 は advanced（[5,6]fluency・[4,6]旧上帯とも該当）", () => {
    expect(bandForLevel([5, 6])).toBe("advanced");
    expect(bandForLevel([4, 6])).toBe("advanced");
  });

  test("それ以外（development=[3,4]自体・帯をまたぐbridge）は intermediate", () => {
    expect(bandForLevel([3, 4])).toBe("intermediate");
    expect(bandForLevel([1, 4])).toBe("intermediate"); // bridge（foundation→development）
    expect(bandForLevel([3, 6])).toBe("intermediate"); // bridge（development→fluency）
    expect(bandForLevel([1, 6])).toBe("intermediate"); // 全帯bridge
  });
});

// --- intermediate帯(development=[3,4])の初期較正 ---
// 設計doc(docs/superpowers/specs/2026-07-09-content-ladder-design.md §5)の制約:
//   「旧素材FAIL + 例文300 PASS + v0.25再生成listening PASS」を満たす範囲で緩め設定から開始する。
// THRESHOLDS_BY_BAND.intermediate は spoken-style.ts の LENGTH_CAP_BY_BAND.intermediate
// （「9-13 words per sentence」）に1語の余裕を足した14語/文（beginnerの11語・advancedの16語の中間）を
// 採用済み。以下はこの値を実データ・既存FAIL実例に対して固定するための較正テスト。
describe("較正: intermediate帯(development=[3,4])の閾値", () => {
  test("beginner(11) < intermediate(14) < advanced(16) の段階性を持つ", () => {
    expect(THRESHOLDS_BY_BAND.intermediate.maxAvgWordsPerSentence).toBeGreaterThan(
      THRESHOLDS_BY_BAND.beginner.maxAvgWordsPerSentence,
    );
    expect(THRESHOLDS_BY_BAND.intermediate.maxAvgWordsPerSentence).toBeLessThan(
      THRESHOLDS_BY_BAND.advanced.maxAvgWordsPerSentence,
    );
  });

  test("短縮形率下限は全帯と同じ0.2で統一されている", () => {
    expect(THRESHOLDS_BY_BAND.intermediate.minContractionsPerSentence).toBe(0.2);
  });

  test("例文300(実データ抜粋)はintermediate帯でもPASSする", () => {
    const result = checkSpokenRegister(GOOD_EXCERPT, "intermediate");
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  test("旧FAIL実例（教科書調・0%短縮形）はintermediate帯でもFAILする", () => {
    const result = checkSpokenRegister(BAD_TEXTBOOK_EXCERPT, "intermediate");
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("短縮形率"))).toBe(true);
  });

  test("旧FAIL実例（エッセイ調・平均17.7語/文）はintermediate帯でもFAILする（advancedより厳しい閾値のため同じ理由で確実にFAIL）", () => {
    const result = checkSpokenRegister(BAD_ESSAY_EXCERPT, "intermediate");
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("平均文長"))).toBe(true);
  });
});

describe("較正: v0.25再生成listening 6本の実データがそれぞれの帯(bandForLevel)でPASSする（サンイティアンカー）", () => {
  test("content/listening/*.md 全件が bandForLevel で決まる帯の閾値でPASSする", () => {
    const items = loadListening(LISTENING_DIR);
    expect(items.length).toBeGreaterThanOrEqual(6);
    const failures = items
      .map((it) => ({ id: it.id, result: checkSpokenRegister(it.paragraphs.join("\n\n"), bandForLevel(it.level)) }))
      .filter(({ result }) => !result.pass);
    expect(failures).toEqual([]);
  });
});

describe("較正: 所有格'sを含む実データ抜粋で誤検出しない", () => {
  // content/listening/code-review-culture.md 第3段落。"other people's code" の所有格'sが
  // 修正前の実装では短縮形として誤カウントされていた（it's と合わせて2件になってしまう）実例。
  const excerptWithPossessive =
    "Now that I have more experience, I also review other people's code regularly. I try to remember how it felt to receive harsh comments early in my career, so I always start with something positive before mentioning problems. If I disagree with an approach, I ask a question instead of simply saying it's wrong. Something like, have you considered handling this error differently, works much better than telling someone their solution is bad. I have noticed that when reviews are written this way, people actually read them carefully instead of getting defensive.";

  test("people's は数えず、it's のみ短縮形1件として数える", () => {
    const metrics = computeSpokenRegisterMetrics(excerptWithPossessive);
    expect(metrics.contractionCount).toBe(1);
  });
});

describe("checkSpokenRegister: 書き言葉語彙ヒットでFAILする", () => {
  test("禁止語彙が1つでもあればFAILする（帯を問わず）", () => {
    const text =
      "I usually skip breakfast. Moreover, I don't eat much at lunch either, so I'm always hungry by dinner.";
    const result = checkSpokenRegister(text, "beginner");
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("書き言葉語彙"))).toBe(true);
  });
});

describe("checkModelTalk", () => {
  test("checkSpokenRegisterと同一の判定を返す（同じ3指標・同じ帯別閾値）", () => {
    const good =
      "I usually skip breakfast and just grab coffee on my way out. This curry tastes a bit spicy, doesn't it?";
    const bad =
      "I work for a small software company. My job is not to write code. My job is to test the app before other people use it.";
    expect(checkModelTalk(good, "beginner")).toEqual(checkSpokenRegister(good, "beginner"));
    expect(checkModelTalk(bad, "beginner")).toEqual(checkSpokenRegister(bad, "beginner"));
    expect(checkModelTalk(bad, "beginner").pass).toBe(false);
  });
});

describe("checkPrepChunk", () => {
  test("正常系: 完全な文・語数範囲内・placeholderなしはPASS", () => {
    const result = checkPrepChunk({ en: "The main problem we had was a slow database query.", ja: "主な問題は遅いDBクエリでした。" });
    expect(result.pass).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.wordCount).toBe(10);
  });

  test("小文字始まりはFAIL（大文字始まりでない）", () => {
    const result = checkPrepChunk({ en: "the main problem was a slow query.", ja: "ja" });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("完全な文"))).toBe(true);
  });

  test("句読点で終わらない断片はFAIL", () => {
    const result = checkPrepChunk({ en: "The main problem we had was a slow query", ja: "ja" });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("完全な文"))).toBe(true);
  });

  test("感嘆符・疑問符で終わる短い相槌的発話もPASSする（文法完全性は要求しない）", () => {
    expect(checkPrepChunk({ en: "Sounds good to me!", ja: "いいですね！" }).reasons.some((r) => r.includes("完全な文"))).toBe(false);
  });

  test(`語数が下限(${PREP_CHUNK_WORD_RANGE.minWords}語)未満はFAIL`, () => {
    const result = checkPrepChunk({ en: "Sure thing.", ja: "了解。" });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("語数"))).toBe(true);
  });

  test(`語数が上限(${PREP_CHUNK_WORD_RANGE.maxWords}語)超はFAIL`, () => {
    const en =
      "The main problem we had was a very slow database query that kept timing out during peak traffic hours every single day.";
    const result = checkPrepChunk({ en, ja: "ja" });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("語数"))).toBe(true);
  });

  test("[X]のようなplaceholderトークンを検出する", () => {
    const result = checkPrepChunk({ en: "The main problem was [specific issue] we found.", ja: "ja" });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("placeholder"))).toBe(true);
  });

  test("<topic>のような山括弧placeholderも検出する", () => {
    const result = checkPrepChunk({ en: "We talked about <topic> during the meeting today.", ja: "ja" });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("placeholder"))).toBe(true);
  });

  test("省略記号(...)を検出する（coach.tsのNo ellipses規則に対応）", () => {
    const result = checkPrepChunk({ en: "The main problem was... something we found later.", ja: "ja" });
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("placeholder"))).toBe(true);
  });

  test("TODO/TBDトークンを検出する", () => {
    expect(checkPrepChunk({ en: "This is a TODO placeholder sentence for now.", ja: "ja" }).pass).toBe(false);
  });

  test("空文字列は完全な文でも語数範囲内でもなくFAIL", () => {
    const result = checkPrepChunk({ en: "", ja: "" });
    expect(result.pass).toBe(false);
    expect(result.wordCount).toBe(0);
  });
});

describe("checkScenarioStarter", () => {
  test("短縮形を含む発話はPASS", () => {
    const result = checkScenarioStarter("I'd like to check in, please.");
    expect(result.pass).toBe(true);
    expect(result.hasContraction).toBe(true);
  });

  test("短縮形が無くても、書き言葉調の定型句や語数超過が無ければPASS（短縮形は必須要件にしない）", () => {
    const result = checkScenarioStarter("Excuse me, is this seat taken?");
    expect(result.hasContraction).toBe(false);
    expect(result.pass).toBe(true);
  });

  test("丁寧な依頼表現は短縮形が無くても自然な話しことばとしてPASSする（実データ較正のポイント）", () => {
    // 実在starterの典型例（"Hi, could I see the menu, please?"型）。短縮形の有無ではなく
    // 定型句/語数/書き言葉語彙のみで判定するため、丁寧表現がそのままFAILすることはない。
    const result = checkScenarioStarter("Could you tell me a bit about your background?");
    expect(result.hasContraction).toBe(false);
    expect(result.pass).toBe(true);
  });

  test("書き言葉語彙は長さに関わらずFAILする", () => {
    const result = checkScenarioStarter("Moreover, I'd like to start.");
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("書き言葉語彙"))).toBe(true);
  });
});

describe("checkScenarioStarter: 書き言葉調の定型句・語数超過で構成したFAIL例文（固定ピン留め）", () => {
  test("'I would like to inquire ...' はFAIL", () => {
    const result = checkScenarioStarter("I would like to inquire about the possibility of moving our meeting.");
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("定型句"))).toBe(true);
  });

  test("'It is necessary that ...' はFAIL", () => {
    const result = checkScenarioStarter("It is necessary that we discuss this matter before the deadline.");
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("定型句"))).toBe(true);
  });

  test("'Please be advised ...' はFAIL", () => {
    const result = checkScenarioStarter("Please be advised that the meeting has been rescheduled.");
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("定型句"))).toBe(true);
  });

  test("極端に長い単一発話(20語超)はFAIL", () => {
    const long =
      "I would really appreciate it if you could possibly find some time in your schedule to meet with me sometime this week or next.";
    const result = checkScenarioStarter(long);
    expect(result.pass).toBe(false);
    expect(result.reasons.some((r) => r.includes("語数"))).toBe(true);
  });
});

describe("checkScenarioStarter: 実データ較正（実在するシナリオ起点セリフが全てPASSすること）", () => {
  test("content/scenarios/*.md の starters が1件残らずPASSする（旧実装は28/54でFAILしていた）", () => {
    const scenarios = loadContent(SCENARIOS_DIR);
    const starters = scenarios.flatMap((s) => s.starters);
    expect(starters.length).toBeGreaterThanOrEqual(54);
    const failures = starters
      .map((starter) => ({ starter, result: checkScenarioStarter(starter) }))
      .filter(({ result }) => !result.pass);
    expect(failures).toEqual([]);
  });
});
