import { describe, expect, test } from "bun:test";
import {
  extractJson, generateAeFeedback, generateFixExplanation, generateModelTalk, generatePhraseHints, generatePrepPack, generateReflection, generateTalkExplanation, generateUtteranceTranslation, roleplayPrompt,
  type AeFeedback, type PrepPack,
} from "../coach";
import type { ClaudeRunner } from "../converse";
import { syntaxConstraint, vocabConstraint } from "../progression";
import type { SessionEvent } from "../session-log";
import { SPOKEN_STYLE_BLOCK, spokenStyleFor } from "../spoken-style";

function runnerReturning(text: string): { runner: ClaudeRunner; seen: Array<{ prompt: string; systemPrompt?: string }> } {
  const seen: Array<{ prompt: string; systemPrompt?: string }> = [];
  const runner: ClaudeRunner = async (prompt, _resumeId, opts) => {
    seen.push({ prompt, systemPrompt: opts?.systemPrompt });
    return { text, sessionId: "coach-sess" };
  };
  return { runner, seen };
}

describe("extractJson", () => {
  test("素のJSONを取り出す", () => {
    expect(extractJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
  test("```json フェンス付きでも取り出す", () => {
    expect(extractJson<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  test("前後に文が付いていても最初の{から最後の}までを試す", () => {
    expect(extractJson<{ a: number }>('Here you go: {"a":1} hope it helps')).toEqual({ a: 1 });
  });
  test("JSONが無ければ null", () => {
    expect(extractJson("no json here")).toBeNull();
  });
});

describe("generateAeFeedback", () => {
  const valid: AeFeedback = {
    items: [{ quote: "I go yesterday", issue: "past tense", better: "I went yesterday", why_ja: "過去の出来事はwent。" }],
    praise: "Clear structure!",
  };

  test("正常系: JSONを構造化して返し、transcriptとtopicがプロンプトに入る", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    const result = await generateAeFeedback({ transcript: "I go yesterday to office", topicTitle: "My week", stage: 5 }, runner);
    expect(result).toEqual(valid);
    expect(seen[0].prompt).toContain("I go yesterday to office");
    expect(seen[0].prompt).toContain("My week");
    expect(seen[0].systemPrompt).toBeTruthy(); // AE専用プロンプトで呼ばれている
  });

  test("JSONパース失敗時は素のテキストを1itemに包むフォールバック", async () => {
    const { runner } = runnerReturning("Sorry, here is some prose feedback instead.");
    const result = await generateAeFeedback({ transcript: "t", topicTitle: "x", stage: 5 }, runner);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].why_ja).toContain("prose feedback");
  });

  // #195 難度勾配ロック: stage5 は CEFR B2 の学習者像 + B2語彙勾配（vocabConstraint(5)）を含む現行文字列に固定
  test("stage 5 の systemPrompt は B2 学習者像+語彙勾配込みの現行文字列と完全一致する（回帰ロック）", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generateAeFeedback({ transcript: "t", topicTitle: "x", stage: 5 }, runner);
    expect(seen[0].systemPrompt).toBe(
      "You are an English error-correction coach for a Japanese IT professional (CEFR B2).\n" +
      "You receive the transcript of the learner's spoken monologue (round 1 of a 4/3/2 fluency task).\n" +
      "Pick the 3-5 most impactful language problems (grammar, word choice, unnatural phrasing). Ignore filler words and small slips.\n" +
      `${vocabConstraint(5)}\n` +
      "Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:\n" +
      '{"items":[{"quote":"<the learner\'s exact words>","issue":"<short English label>","better":"<corrected natural version>","why_ja":"<1〜2文の簡潔な日本語解説>"}],"praise":"<one short encouraging sentence in English>"}\n' +
      `For "better": ${SPOKEN_STYLE_BLOCK}\n` +
      "Do not use any tools — reply directly with text only.",
    );
  });

  test("言い直し例の難度も stage 4/5/6 で勾配になる（B1-B2/B2/B2-C1・#195）", async () => {
    const prompts: string[] = [];
    for (const stage of [4, 5, 6]) {
      const { runner, seen } = runnerReturning(JSON.stringify(valid));
      await generateAeFeedback({ transcript: "t", topicTitle: "x", stage }, runner);
      prompts.push(seen[0].systemPrompt!);
    }
    expect(prompts[0]).toContain("(CEFR B1-B2)");
    expect(prompts[1]).toContain("(CEFR B2)");
    expect(prompts[2]).toContain("(CEFR B2-C1)");
    expect(new Set(prompts).size).toBe(3);
    // 「betterを1節で言い切れる短さに」の支援行は低ステージ専用のまま（上級帯は自然さ優先）
    expect(prompts[1]).not.toContain("one clause when possible");
  });

  test("stage 1 の systemPrompt は高頻度語彙制約と one clause 制約を含む", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generateAeFeedback({ transcript: "t", topicTitle: "x", stage: 1 }, runner);
    expect(seen[0].systemPrompt).toContain("word families");
    expect(seen[0].systemPrompt).toContain("one clause");
  });

  test("systemPrompt は better欄向けに口語スタイルブロックを含む（stage不問）", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generateAeFeedback({ transcript: "t", topicTitle: "x", stage: 5 }, runner);
    expect(seen[0].systemPrompt).toContain(SPOKEN_STYLE_BLOCK);
  });
});

describe("generateModelTalk", () => {
  test("topicTitleとhintsがプロンプトに入り、textを返す", async () => {
    const { runner, seen } = runnerReturning("This is a model talk.");
    const result = await generateModelTalk({ topicTitle: "Zero trust", hints: ["definition", "example"], stage: 2 }, runner);
    expect(result.text).toBe("This is a model talk.");
    expect(seen[0].prompt).toContain("Zero trust");
    expect(seen[0].prompt).toContain("definition");
  });

  test("低ステージは systemPrompt に高頻度語彙制約(word families)が入る", async () => {
    const { runner, seen } = runnerReturning("x");
    await generateModelTalk({ topicTitle: "t", hints: [], stage: 2 }, runner);
    expect(seen[0].systemPrompt).toContain("word families");
  });

  // #195: 旧実装は stage4/5/6 が完全同一のB1固定プロンプト（fluency帯に難度勾配が無い）だった
  test("stage 4/5/6 の systemPrompt は互いに異なり、B1-B2/B2/B2-C1 の勾配ラベルを持つ（#195）", async () => {
    const prompts: string[] = [];
    for (const stage of [4, 5, 6]) {
      const { runner, seen } = runnerReturning("x");
      await generateModelTalk({ topicTitle: "t", hints: [], stage }, runner);
      prompts.push(seen[0].systemPrompt!);
    }
    expect(prompts[0]).toContain("(CEFR B1-B2)");
    expect(prompts[1]).toContain("(CEFR B2)");
    expect(prompts[2]).toContain("(CEFR B2-C1)");
    expect(new Set(prompts).size).toBe(3);
    for (const p of prompts) expect(p).not.toContain("word families");
  });

  test("語数指示も stage 単調に増える（120-150 → 130-160 → 140-170・#195）", async () => {
    const prompts: string[] = [];
    for (const stage of [4, 5, 6]) {
      const { runner, seen } = runnerReturning("x");
      await generateModelTalk({ topicTitle: "t", hints: [], stage }, runner);
      prompts.push(seen[0].systemPrompt!);
    }
    expect(prompts[0]).toContain("120-150 words");
    expect(prompts[1]).toContain("130-160 words");
    expect(prompts[2]).toContain("140-170 words");
  });

  // #195 難度勾配ロック: stage5 の実出力を固定（vocab/syntaxConstraint(5) 込み）。
  // 旧ロック（stage4-6共通のB1固定文言）は難度頭打ちの原因だったため意図的に更新した。
  test("stage 5 の systemPrompt は現行文字列と完全一致する（回帰ロック）", async () => {
    const { runner, seen } = runnerReturning("x");
    await generateModelTalk({ topicTitle: "t", hints: [], stage: 5 }, runner);
    expect(seen[0].systemPrompt).toBe(
      "You produce a model monologue for an English learner (CEFR B2) to shadow.\n" +
      `Rules: 130-160 words, spoken register, first person. ${vocabConstraint(5)} ${syntaxConstraint(5)}\n` +
      `${spokenStyleFor("advanced")}\n` +
      "No headings, no lists — just the monologue text.\n" +
      "Do not use any tools — reply directly with text only.",
    );
  });

  test("systemPrompt は帯別のspokenStyleForを含む(短縮形ガイド・stageに応じた帯)", async () => {
    const { runner, seen } = runnerReturning("x");
    await generateModelTalk({ topicTitle: "t", hints: [], stage: 1 }, runner);
    await generateModelTalk({ topicTitle: "t", hints: [], stage: 3 }, runner);
    await generateModelTalk({ topicTitle: "t", hints: [], stage: 5 }, runner);
    expect(seen[0].systemPrompt).toContain(spokenStyleFor("beginner"));
    expect(seen[1].systemPrompt).toContain(spokenStyleFor("intermediate"));
    expect(seen[2].systemPrompt).toContain(spokenStyleFor("advanced"));
  });

  test("stage 1 の systemPrompt は構文制約(6-10 words・A2)を含み、B1 level は含まない", async () => {
    const { runner, seen } = runnerReturning("x");
    await generateModelTalk({ topicTitle: "t", hints: [], stage: 1 }, runner);
    expect(seen[0].systemPrompt).toContain("6-10 words");
    expect(seen[0].systemPrompt).toContain("CEFR A2");
    expect(seen[0].systemPrompt).not.toContain("B1 level");
  });
});

describe("generateReflection", () => {
  test("user_utterance がプロンプトに入り、構造化して返す", async () => {
    const reflection = {
      goodPhrases: ["agree next steps"],
      fixes: [{ original: "I go", better: "I went" }],
      noteForTomorrow_ja: "過去形に注意。",
    };
    const { runner, seen } = runnerReturning(JSON.stringify(reflection));
    const events: SessionEvent[] = [
      { ts: "t1", type: "session_start", sessionId: "s1" },
      { ts: "t2", type: "user_utterance", sessionId: "s1", text: "I go to the meeting yesterday" },
      { ts: "t3", type: "assistant_reply", sessionId: "s1", text: "Oh, how was it?" },
    ];
    const result = await generateReflection({ events }, runner);
    expect(result).toEqual(reflection);
    expect(seen[0].prompt).toContain("I go to the meeting yesterday");
  });

  test("パース失敗時はフォールバック（noteに素のテキスト）", async () => {
    const { runner } = runnerReturning("just prose");
    const result = await generateReflection({ events: [] }, runner);
    expect(result.goodPhrases).toEqual([]);
    expect(result.noteForTomorrow_ja).toContain("just prose");
  });
});

describe("generatePrepPack", () => {
  // LLM の生JSON出力を模したフィクスチャ（hintDefault はサーバ側で args.hintLang から計算される別物なので含めない）
  // satisfies で chunks/outline の形状ドリフトはコンパイル時に検出する
  const valid = {
    chunks: [
      { en: "The main problem we had was ...", ja: "一番の問題は…でした" },
      { en: "What worked well was ...", ja: "うまくいったのは…です" },
    ],
    outline: ["Opening: what the topic is", "Point 1", "Wrap-up"],
  } satisfies Omit<PrepPack, "hintDefault">;

  test("正常系: JSONを構造化して返し、topicとhintsがプロンプトに入る", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    const result = await generatePrepPack({ topicTitle: "Zero trust", hints: ["definition — 定義", "example — 例"], stage: 3 }, runner);
    expect(result).toEqual({ ...valid, hintDefault: "ja" });
    expect(seen[0].prompt).toContain("Zero trust");
    expect(seen[0].prompt).toContain("definition");
    expect(seen[0].systemPrompt).toContain("STRICT JSON");
    expect(seen[0].systemPrompt).toContain("No ellipses");
  });

  test("systemPrompt は口語スタイルブロックを含む", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generatePrepPack({ topicTitle: "t", hints: [], stage: 3 }, runner);
    expect(seen[0].systemPrompt).toContain(SPOKEN_STYLE_BLOCK);
  });

  test("```フェンス付きJSONでも取り出す", async () => {
    const { runner } = runnerReturning("```json\n" + JSON.stringify(valid) + "\n```");
    const result = await generatePrepPack({ topicTitle: "t", hints: [], stage: 3 }, runner);
    expect(result.chunks).toHaveLength(2);
  });

  test("パース失敗時は素のテキストをoutlineに包むフォールバック（chunksは空）", async () => {
    const { runner } = runnerReturning("just prose, no json");
    const result = await generatePrepPack({ topicTitle: "t", hints: [], stage: 3 }, runner);
    expect(result.chunks).toEqual([]);
    expect(result.outline.join(" ")).toContain("just prose");
  });

  test("hintLang \"en\" でも ja はデータとして残し、hintDefault で表示既定だけを伝える（データ削除しない）", async () => {
    const { runner } = runnerReturning(JSON.stringify(valid));
    const result = await generatePrepPack({ topicTitle: "t", hints: [], hintLang: "en", stage: 3 }, runner);
    expect(result.chunks.map((c) => c.ja)).toEqual(valid.chunks.map((c) => c.ja)); // ja は空にしない
    expect(result.hintDefault).toBe("en"); // 表示既定は en（上級者は既定で英語のみ表示）
  });

  test("hintLang 省略時の hintDefault は ja（最大サポート側の既定）", async () => {
    const { runner } = runnerReturning(JSON.stringify(valid));
    const result = await generatePrepPack({ topicTitle: "t", hints: [], stage: 3 }, runner);
    expect(result.hintDefault).toBe("ja");
  });

  test("chunkCount がシステムプロンプトの \"Exactly N chunks\" に反映される", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generatePrepPack({ topicTitle: "t", hints: [], chunkCount: 4, stage: 3 }, runner);
    expect(seen[0].systemPrompt).toContain("Exactly 4 chunks");
  });

  test("不正な項目をサニタイズ: 無効なchunksと非文字列outlineを除外", async () => {
    const malformed = {
      chunks: [
        { en: "The main problem", ja: "一番の問題" },  // valid
        { en: 123, ja: "wrong" },                      // en not string
        { en: "only english" },                        // ja missing
        "junk",                                        // not an object
      ],
      outline: ["good", 42, null],                    // 42 and null are not strings
    };
    const { runner } = runnerReturning(JSON.stringify(malformed));
    const result = await generatePrepPack({ topicTitle: "t", hints: [], stage: 3 }, runner);
    // Only the fully valid chunk should remain
    expect(result.chunks).toEqual([{ en: "The main problem", ja: "一番の問題" }]);
    // Only "good" string should remain in outline
    expect(result.outline).toEqual(["good"]);
  });

  test("低ステージは systemPrompt に word families 制約が入る", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generatePrepPack({ topicTitle: "t", hints: [], stage: 2 }, runner);
    expect(seen[0].systemPrompt).toContain("word families");
  });

  // #195: 旧実装は stage4/5/6 が完全同一のB1固定プロンプト（準備チャンクの難度勾配が無い）だった
  test("stage 4/5/6 は語彙・構文バレットが勾配で入り、チャンク語数指示も単調に上がる（#195）", async () => {
    const prompts: string[] = [];
    for (const stage of [4, 5, 6]) {
      const { runner, seen } = runnerReturning(JSON.stringify(valid));
      await generatePrepPack({ topicTitle: "t", hints: [], stage }, runner);
      prompts.push(seen[0].systemPrompt!);
    }
    expect(prompts[0]).toContain("B1-B2 level");
    expect(prompts[0]).toContain("roughly 9-14 words");
    expect(prompts[1]).toContain("B2 level");
    expect(prompts[1]).toContain("roughly 10-15 words");
    expect(prompts[2]).toContain("B2-C1 level");
    expect(prompts[2]).toContain("roughly 11-16 words");
    expect(new Set(prompts).size).toBe(3);
    for (const p of prompts) expect(p).not.toContain("word families");
  });

  // #195 難度勾配ロック: stage5 の実出力(chunkCount既定6・vocab/syntaxバレット込み)を固定。
  // 旧ロック（stage4-6共通のB1固定文言）は難度頭打ちの原因だったため意図的に更新した。
  test("stage 5 の systemPrompt は現行文字列と完全一致する（回帰ロック）", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generatePrepPack({ topicTitle: "t", hints: [], stage: 5 }, runner);
    expect(seen[0].systemPrompt).toBe(
      "You prepare a Japanese IT professional (CEFR B2) for a short English monologue.\n" +
      "You receive a topic and hint angles. Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:\n" +
      '{"chunks":[{"en":"<complete, speakable sentence, B2 level>","ja":"<自然な日本語訳>"}],"outline":["<short English bullet>"]}\n' +
      "Rules:\n" +
      '- Exactly 6 chunks. Each "en" MUST be a complete, speakable sentence of roughly 10-15 words that the learner can read aloud as-is.\n' +
      '  No ellipses ("..."), no blanks, and no placeholders like [X] — always fill the slot with a concrete, topic-relevant\n' +
      "  example a B2-level IT professional could plausibly say, using the given topic and hints for the content\n" +
      '  (e.g. "The main problem we had was a slow database query.", "What worked well was splitting the task into smaller steps.").\n' +
      `- ${vocabConstraint(5)}\n` +
      `- ${syntaxConstraint(5)}\n` +
      "- Keep the reusable sentence frame recognizable at the START of each sentence (sentence-starter + filled example), so the\n" +
      "  learner can reuse that same frame with their own content in the next exercise.\n" +
      '- ja: the natural full-sentence Japanese translation of "en" (not a fragment).\n' +
      "- outline: 3-4 bullets forming a simple talk skeleton (opening → 1-2 points → wrap-up), tied to the given hints.\n" +
      `- ${SPOKEN_STYLE_BLOCK}\n` +
      "Do not use any tools — reply directly with text only.",
    );
  });

  test("stage 1 の systemPrompt は構文制約(6-10 words・A2 level)を含み、B1 level は含まない", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generatePrepPack({ topicTitle: "t", hints: [], stage: 1 }, runner);
    expect(seen[0].systemPrompt).toContain("6-10 words");
    expect(seen[0].systemPrompt).toContain("A2 level");
    expect(seen[0].systemPrompt).not.toContain("B1 level");
    // 例文の難易度シグナルも levelLabel と同じ stage 連動にする（stage 非依存の B1-level 固定を防ぐ回帰チェック）
    expect(seen[0].systemPrompt).toContain("a A2-level IT professional");
    expect(seen[0].systemPrompt).not.toContain("B1-level");
  });
});

describe("generatePhraseHints", () => {
  const valid = {
    suggestions: [
      { en: "I haven't tried that feature yet.", ja: "まだ試していない、の言い方" },
      { en: "That's still on my to-do list.", ja: "これからやる予定、のニュアンス" },
    ],
  };

  test("正常系: history がLearner/Partnerラベル付きでプロンプトに入り、jaTextも入る", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    const result = await generatePhraseHints({
      jaText: "その機能はまだ試していません",
      history: [
        { role: "ai", text: "Have you tried the new dashboard?" },
        { role: "you", text: "Not yet." },
      ],
    }, runner);
    expect(result).toEqual(valid);
    expect(seen[0].prompt).toContain("Partner: Have you tried the new dashboard?");
    expect(seen[0].prompt).toContain("Learner: Not yet.");
    expect(seen[0].prompt).toContain("その機能はまだ試していません");
    expect(seen[0].systemPrompt).toContain("STRICT JSON");
  });

  test("systemPrompt は口語スタイルブロックを含む", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generatePhraseHints({ jaText: "はい" }, runner);
    expect(seen[0].systemPrompt).toContain(SPOKEN_STYLE_BLOCK);
  });

  test("history省略時は会話部分を含めずjaTextのみプロンプトに入る", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    await generatePhraseHints({ jaText: "少し考える時間をください" }, runner);
    expect(seen[0].prompt).not.toContain("Recent conversation");
    expect(seen[0].prompt).toContain("少し考える時間をください");
  });

  test("JSONパース失敗時は素のテキストを1件（ja空）に包むフォールバック", async () => {
    const { runner } = runnerReturning("Sorry, here is some prose instead of JSON.");
    const result = await generatePhraseHints({ jaText: "はい" }, runner);
    expect(result.suggestions).toEqual([{ en: "Sorry, here is some prose instead of JSON.", ja: "" }]);
  });

  test("不正なsuggestion項目をサニタイズ: en欠落・非文字列・空文字を除外", async () => {
    const malformed = {
      suggestions: [
        { en: "Could you give me a moment?", ja: "少し時間をもらう言い方" }, // valid
        { en: 123, ja: "wrong" },                                          // en not string
        { ja: "only japanese" },                                          // en missing
        { en: "", ja: "empty en" },                                       // en falsy
        "junk",                                                           // not an object
      ],
    };
    const { runner } = runnerReturning(JSON.stringify(malformed));
    const result = await generatePhraseHints({ jaText: "はい" }, runner);
    expect(result.suggestions).toEqual([{ en: "Could you give me a moment?", ja: "少し時間をもらう言い方" }]);
  });

  test("ja 欠落・非文字列でも en が有効なら ja:'' で採用する", async () => {
    const malformed = { suggestions: [
      { en: "Give me a second." },       // ja missing
      { en: "Let me think.", ja: 123 },   // ja not a string
    ] };
    const { runner } = runnerReturning(JSON.stringify(malformed));
    const result = await generatePhraseHints({ jaText: "はい" }, runner);
    expect(result.suggestions).toEqual([
      { en: "Give me a second.", ja: "" },
      { en: "Let me think.", ja: "" },
    ]);
  });
});

describe("generateUtteranceTranslation", () => {
  test("本文がプロンプトに入り、翻訳用 systemPrompt でトリムした訳を返す", async () => {
    const { runner, seen } = runnerReturning("  私はたいていコーヒーで一日を始めます。  ");
    const result = await generateUtteranceTranslation({ text: "I usually start my day with coffee." }, runner);
    expect(result.text).toBe("私はたいていコーヒーで一日を始めます。");
    expect(seen[0].prompt).toBe("I usually start my day with coffee.");
    expect(seen[0].systemPrompt).toContain("translate");
  });
});

describe("generateFixExplanation", () => {
  test("original/better/note がプロンプトに入り、trim したテキストを返す", async () => {
    const { runner, seen } = runnerReturning("  過去形は went。  ");
    const result = await generateFixExplanation({ original: "I go", better: "I went", note: "past tense" }, runner);
    expect(result.text).toBe("過去形は went。");
    expect(seen[0].prompt).toContain("I go");
    expect(seen[0].prompt).toContain("I went");
    expect(seen[0].prompt).toContain("past tense");
    expect(seen[0].systemPrompt).toContain("JAPANESE");
  });

  test("note 省略時は Issue 行を含めない", async () => {
    const { runner, seen } = runnerReturning("x");
    await generateFixExplanation({ original: "a", better: "b" }, runner);
    expect(seen[0].prompt).not.toContain("Issue:");
  });
});

describe("roleplayPrompt", () => {
  test("シナリオのタイトルとセットアップ・短文/日本語禁止ルールを含む", () => {
    const p = roleplayPrompt({ title: "Vendor meeting", hints: ["You are the customer", "Goal: agree next steps"] }, 5);
    expect(p).toContain("Vendor meeting");
    expect(p).toContain("You are the customer");
    expect(p).toContain("Never switch to Japanese");
  });

  test("低ステージ(1〜3)は高頻度語彙制約(word families)を課す", () => {
    const p = roleplayPrompt({ title: "t", hints: ["h"] }, 2);
    expect(p).toContain("word families");
    expect(p).not.toContain("B1 level");
  });

  // #195: 旧実装は stage4-6 が同一の「B1 level」フォールバックで、fluency帯の難度勾配が無かった
  test("stage 4/5/6 は B1-B2/B2/B2-C1 の語彙勾配を課し、互いに異なる（#195）", () => {
    const p4 = roleplayPrompt({ title: "t", hints: ["h"] }, 4);
    const p5 = roleplayPrompt({ title: "t", hints: ["h"] }, 5);
    const p6 = roleplayPrompt({ title: "t", hints: ["h"] }, 6);
    expect(p4).toContain(vocabConstraint(4));
    expect(p5).toContain(vocabConstraint(5));
    expect(p6).toContain(vocabConstraint(6));
    expect(p5).toContain("(CEFR B2)");
    expect(new Set([p4, p5, p6]).size).toBe(3);
    for (const p of [p4, p5, p6]) {
      expect(p).not.toContain("word families");
      expect(p).not.toContain("Use plain, high-frequency English (B1 level)");
    }
  });
});

describe("coach: AbortSignal を runner opts.signal へ伝播する（HTTP中断がLLM実行まで届く配線・#189）", () => {
  const cases: Array<[string, (runner: ClaudeRunner, signal: AbortSignal) => Promise<unknown>]> = [
    ["generateAeFeedback", (r, s) => generateAeFeedback({ transcript: "t", topicTitle: "x", stage: 2, signal: s }, r)],
    ["generateModelTalk", (r, s) => generateModelTalk({ topicTitle: "x", hints: ["h"], stage: 2, signal: s }, r)],
    ["generateReflection", (r, s) => generateReflection({ events: [], signal: s }, r)],
    ["generatePrepPack", (r, s) => generatePrepPack({ topicTitle: "x", hints: ["h"], stage: 2, signal: s }, r)],
    ["generatePhraseHints", (r, s) => generatePhraseHints({ jaText: "助けて", signal: s }, r)],
    ["generateFixExplanation", (r, s) => generateFixExplanation({ original: "a", better: "b", signal: s }, r)],
    ["generateUtteranceTranslation", (r, s) => generateUtteranceTranslation({ text: "hi", signal: s }, r)],
    ["generateTalkExplanation", (r, s) => generateTalkExplanation({ text: "hi", signal: s }, r)],
  ];
  for (const [name, invoke] of cases) {
    test(`${name} は args.signal を runner へ渡す`, async () => {
      const captured: Array<AbortSignal | undefined> = [];
      const runner: ClaudeRunner = async (_prompt, _resumeId, opts) => {
        captured.push(opts?.signal);
        return { text: "{}", sessionId: "s" };
      };
      const ac = new AbortController();
      await invoke(runner, ac.signal);
      expect(captured[0]).toBe(ac.signal);
    });
  }
});
