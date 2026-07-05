import { describe, expect, test } from "bun:test";
import {
  extractJson, generateAeFeedback, generateModelTalk, generatePrepPack, generateReflection, roleplayPrompt,
  type AeFeedback, type PrepPack,
} from "../coach";
import type { ClaudeRunner } from "../converse";
import type { SessionEvent } from "../session-log";

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
    const result = await generateAeFeedback({ transcript: "I go yesterday to office", topicTitle: "My week" }, runner);
    expect(result).toEqual(valid);
    expect(seen[0].prompt).toContain("I go yesterday to office");
    expect(seen[0].prompt).toContain("My week");
    expect(seen[0].systemPrompt).toBeTruthy(); // AE専用プロンプトで呼ばれている
  });

  test("JSONパース失敗時は素のテキストを1itemに包むフォールバック", async () => {
    const { runner } = runnerReturning("Sorry, here is some prose feedback instead.");
    const result = await generateAeFeedback({ transcript: "t", topicTitle: "x" }, runner);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].why_ja).toContain("prose feedback");
  });
});

describe("generateModelTalk", () => {
  test("topicTitleとhintsがプロンプトに入り、textを返す", async () => {
    const { runner, seen } = runnerReturning("This is a model talk.");
    const result = await generateModelTalk({ topicTitle: "Zero trust", hints: ["definition", "example"] }, runner);
    expect(result.text).toBe("This is a model talk.");
    expect(seen[0].prompt).toContain("Zero trust");
    expect(seen[0].prompt).toContain("definition");
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
  const valid: PrepPack = {
    chunks: [
      { en: "The main problem we had was ...", ja: "一番の問題は…でした" },
      { en: "What worked well was ...", ja: "うまくいったのは…です" },
    ],
    outline: ["Opening: what the topic is", "Point 1", "Wrap-up"],
  };

  test("正常系: JSONを構造化して返し、topicとhintsがプロンプトに入る", async () => {
    const { runner, seen } = runnerReturning(JSON.stringify(valid));
    const result = await generatePrepPack({ topicTitle: "Zero trust", hints: ["definition — 定義", "example — 例"] }, runner);
    expect(result).toEqual(valid);
    expect(seen[0].prompt).toContain("Zero trust");
    expect(seen[0].prompt).toContain("definition");
    expect(seen[0].systemPrompt).toContain("STRICT JSON");
    expect(seen[0].systemPrompt).toContain("No ellipses");
  });

  test("```フェンス付きJSONでも取り出す", async () => {
    const { runner } = runnerReturning("```json\n" + JSON.stringify(valid) + "\n```");
    const result = await generatePrepPack({ topicTitle: "t", hints: [] }, runner);
    expect(result.chunks).toHaveLength(2);
  });

  test("パース失敗時は素のテキストをoutlineに包むフォールバック（chunksは空）", async () => {
    const { runner } = runnerReturning("just prose, no json");
    const result = await generatePrepPack({ topicTitle: "t", hints: [] }, runner);
    expect(result.chunks).toEqual([]);
    expect(result.outline.join(" ")).toContain("just prose");
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
    const result = await generatePrepPack({ topicTitle: "t", hints: [] }, runner);
    // Only the fully valid chunk should remain
    expect(result.chunks).toEqual([{ en: "The main problem", ja: "一番の問題" }]);
    // Only "good" string should remain in outline
    expect(result.outline).toEqual(["good"]);
  });
});

describe("roleplayPrompt", () => {
  test("シナリオのタイトルとセットアップ・B1/短文/日本語禁止ルールを含む", () => {
    const p = roleplayPrompt({ title: "Vendor meeting", hints: ["You are the customer", "Goal: agree next steps"] });
    expect(p).toContain("Vendor meeting");
    expect(p).toContain("You are the customer");
    expect(p).toContain("B1");
    expect(p).toContain("Never switch to Japanese");
  });
});
