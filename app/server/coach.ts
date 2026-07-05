import { query } from "@anthropic-ai/claude-agent-sdk";
import { makeClaudeRunner, type ClaudeRunner } from "./converse";
import type { SessionEvent } from "./session-log";

export type AeItem = { quote: string; issue: string; better: string; why_ja: string };
export type AeFeedback = { items: AeItem[]; praise: string };
export type Reflection = {
  goodPhrases: string[];
  fixes: Array<{ original: string; better: string }>;
  noteForTomorrow_ja: string;
};

const defaultRunner: ClaudeRunner = makeClaudeRunner(query);

/** LLM出力からJSONを取り出す。```フェンス除去→最初の{から最後の}までをparse。失敗はnull */
export function extractJson<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

const AE_SYSTEM = `You are an English error-correction coach for a Japanese IT professional (CEFR A2-B1).
You receive the transcript of the learner's spoken monologue (round 1 of a 4/3/2 fluency task).
Pick the 3-5 most impactful language problems (grammar, word choice, unnatural phrasing). Ignore filler words and small slips.
Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:
{"items":[{"quote":"<the learner's exact words>","issue":"<short English label>","better":"<corrected natural version>","why_ja":"<1〜2文の簡潔な日本語解説>"}],"praise":"<one short encouraging sentence in English>"}
Do not use any tools — reply directly with text only.`;

export async function generateAeFeedback(
  args: { transcript: string; topicTitle: string },
  runner: ClaudeRunner = defaultRunner,
): Promise<AeFeedback> {
  const prompt = `Topic: ${args.topicTitle}\n\nLearner's transcript:\n${args.transcript}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: AE_SYSTEM });
  const parsed = extractJson<AeFeedback>(text);
  if (parsed && Array.isArray(parsed.items)) return parsed;
  // パース失敗時のフォールバック: 素のテキストを1itemに包んでUIに出せる形にする
  return { items: [{ quote: "", issue: "feedback", better: "", why_ja: text }], praise: "" };
}

const MODEL_TALK_SYSTEM = `You produce a model monologue for an English learner (CEFR B1) to shadow.
Rules: 120-150 words, spoken register, first person, plain high-frequency vocabulary, short sentences.
No headings, no lists — just the monologue text.
Do not use any tools — reply directly with text only.`;

export async function generateModelTalk(
  args: { topicTitle: string; hints: string[] },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ text: string }> {
  const prompt = `Topic: ${args.topicTitle}\nCover these angles:\n${args.hints.map((h) => `- ${h}`).join("\n")}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: MODEL_TALK_SYSTEM });
  return { text };
}

const REFLECTION_SYSTEM = `You review one day of an English learner's speaking practice (CEFR A2-B1, Japanese IT professional).
You receive the learner's utterances from today's session log.
Reply with STRICT JSON only — no markdown fences — exactly this shape:
{"goodPhrases":["<up to 3 phrases the learner used well>"],"fixes":[{"original":"<learner's words>","better":"<natural version>"}],"noteForTomorrow_ja":"<明日に向けた1〜2文の日本語メモ>"}
Keep fixes to the 3 most useful items.
Do not use any tools — reply directly with text only.`;

export async function generateReflection(
  args: { events: SessionEvent[] },
  runner: ClaudeRunner = defaultRunner,
): Promise<Reflection> {
  const utterances = args.events
    .filter((e) => e.type === "user_utterance" && e.text)
    .map((e) => `- ${e.text}`)
    .join("\n");
  const prompt = `Today's learner utterances:\n${utterances || "(none)"}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: REFLECTION_SYSTEM });
  const parsed = extractJson<Reflection>(text);
  if (parsed && Array.isArray(parsed.goodPhrases)) return parsed;
  return { goodPhrases: [], fixes: [], noteForTomorrow_ja: text };
}

export type PrepPack = { chunks: Array<{ en: string; ja: string }>; outline: string[] };

const PREP_SYSTEM = `You prepare a Japanese IT professional (CEFR A2-B1) for a short English monologue.
You receive a topic and hint angles. Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:
{"chunks":[{"en":"<complete, speakable sentence, B1 level>","ja":"<自然な日本語訳>"}],"outline":["<short English bullet>"]}
Rules:
- 6-8 chunks. Each "en" MUST be a complete, speakable sentence of roughly 8-16 words that the learner can read aloud as-is.
  No ellipses ("..."), no blanks, and no placeholders like [X] — always fill the slot with a concrete, topic-relevant
  example a B1-level IT professional could plausibly say, using the given topic and hints for the content
  (e.g. "The main problem we had was a slow database query.", "What worked well was splitting the task into smaller steps.").
- Keep the reusable sentence frame recognizable at the START of each sentence (sentence-starter + filled example), so the
  learner can reuse that same frame with their own content in the next exercise.
- ja: the natural full-sentence Japanese translation of "en" (not a fragment).
- outline: 3-4 bullets forming a simple talk skeleton (opening → 1-2 points → wrap-up), tied to the given hints.
Do not use any tools — reply directly with text only.`;

export async function generatePrepPack(
  args: { topicTitle: string; hints: string[] },
  runner: ClaudeRunner = defaultRunner,
): Promise<PrepPack> {
  const prompt = `Topic: ${args.topicTitle}\nHint angles:\n${args.hints.map((h) => `- ${h}`).join("\n")}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: PREP_SYSTEM });
  const parsed = extractJson<PrepPack>(text);
  if (parsed && Array.isArray(parsed.chunks) && Array.isArray(parsed.outline)) {
    // Sanitize chunks: keep only items where both en and ja are strings
    const sanitizedChunks = parsed.chunks
      .filter((item) => typeof item?.en === "string" && item.en && typeof item?.ja === "string")
      .map((item) => ({ en: item.en, ja: item.ja }));
    // Sanitize outline: keep only string elements
    const sanitizedOutline = parsed.outline.filter((el) => typeof el === "string");
    return { chunks: sanitizedChunks, outline: sanitizedOutline };
  }
  // パース失敗時のフォールバック: チャンクなし・素のテキストをアウトラインとして表示できる形
  return { chunks: [], outline: [text] };
}

export function roleplayPrompt(scenario: { title: string; hints: string[] }): string {
  return `You are an English roleplay partner for a Japanese IT professional (CEFR A2-B1).
Scenario: ${scenario.title}
Setup:
${scenario.hints.map((h) => `- ${h}`).join("\n")}
Rules:
- Stay in your assigned role for the whole conversation. Do not break character.
- Keep every reply SHORT: 2-4 sentences, then ask ONE question or make ONE request.
- Use plain, high-frequency English (B1 level). No rare idioms.
- Do NOT correct the learner's errors explicitly; respond naturally.
- Never switch to Japanese.
- Do not use any tools — reply directly with text only.`;
}
