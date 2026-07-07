import { defaultRunner, type ClaudeRunner } from "./converse";
import { vocabConstraint, type HintLang } from "./progression";
import type { SessionEvent } from "./session-log";

export type AeItem = { quote: string; issue: string; better: string; why_ja: string };
export type AeFeedback = { items: AeItem[]; praise: string };
export type Reflection = {
  goodPhrases: string[];
  fixes: Array<{ original: string; better: string }>;
  noteForTomorrow_ja: string;
};

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

const EXPLAIN_SYSTEM = `You are an English grammar coach for a Japanese learner (CEFR A2-B1).
You receive one example sentence (with its Japanese translation and a one-line grammar note).
Write a deeper explanation IN JAPANESE covering, in this order:
1. なぜその形を使うのか（文法ポイントの核心を1〜2文で）
2. 使い回し例: 同じ骨組みの別場面の英文を2つ、それぞれ日本語訳付きで
3. よくある間違い: 日本人学習者がやりがちな誤り方を1つ、誤→正の形で
Plain text only (no markdown, no headings). Keep it within 8 lines. Write English example sentences in English; everything else in Japanese.
Do not use any tools — reply directly with text only.`;

/** 例文の詳しい解説を生成する（プレーンテキスト・日本語）。routes 側でキャッシュされる */
export async function generateSentenceExplanation(
  args: { en: string; ja: string; note: string },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ text: string }> {
  const prompt = `Sentence: ${args.en}\nJapanese: ${args.ja}\nGrammar note: ${args.note}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: EXPLAIN_SYSTEM });
  return { text: text.trim() };
}

const TALK_EXPLAIN_SYSTEM = `You are an English coach for a Japanese learner (CEFR A2-B1).
You receive a short English model talk the learner is shadowing.
Reply IN JAPANESE with exactly this structure (plain text, no markdown):
1. 「日本語訳:」の行に続けて、全文の自然な日本語訳（直訳調にしない）
2. 空行を1つ
3. 「表現ポイント:」の行に続けて、この文章から学ぶ価値のある表現を3つ、各行「- <英語表現> — <日本語で使い方の説明1文>」の形式で
Keep the whole reply within 15 lines.
Do not use any tools — reply directly with text only.`;

/** モデルトークの日本語訳＋表現ポイント解説（routes 側で本文ハッシュをキーにキャッシュされる） */
export async function generateTalkExplanation(
  args: { text: string },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ text: string }> {
  const { text } = await runner(args.text, undefined, { systemPrompt: TALK_EXPLAIN_SYSTEM });
  return { text: text.trim() };
}

const TRANSLATE_SYSTEM = `You translate one short English line from a live conversation into natural Japanese for a Japanese learner (CEFR A2-B1).
Reply with ONLY the Japanese translation — no English, no notes, no labels, no quotes — plain text on a single line.
Do not correct or comment on the English; just translate its meaning naturally.
Do not use any tools — reply directly with text only.`;

/** AI発話の日本語訳のみを生成する（表現解説は付けない・routes 側で本文ハッシュをキーにキャッシュされる） */
export async function generateUtteranceTranslation(
  args: { text: string },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ text: string }> {
  const { text } = await runner(args.text, undefined, { systemPrompt: TRANSLATE_SYSTEM });
  return { text: text.trim() };
}

export type PhraseHint = { en: string; ja: string };

const PHRASE_HINT_SYSTEM = `You help a Japanese learner (CEFR A2-B1) say something in English during a live conversation.
You receive: (1) what the learner wants to say, written in Japanese, and optionally (2) the recent conversation so far.
Offer 2-3 natural English ways to express that meaning, matching the register of the conversation.
Do NOT correct the learner and do NOT judge their level. Only provide the wording they asked for.
Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:
{"suggestions":[{"en":"<natural, speakable English phrase or short sentence>","ja":"<日本語で使い方やニュアンスを1文>"}]}
Give 2 or 3 suggestions.
Do not use any tools — reply directly with text only.`;

/** 言い方ヒント: 言いたい日本語＋直近履歴から英語表現を2〜3個提案する（キャッシュしない） */
export async function generatePhraseHints(
  args: { jaText: string; history?: Array<{ role: "you" | "ai"; text: string }> },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ suggestions: PhraseHint[] }> {
  const context = (args.history ?? [])
    .map((h) => `${h.role === "you" ? "Learner" : "Partner"}: ${h.text}`)
    .join("\n");
  const prompt = context
    ? `Recent conversation:\n${context}\n\nThe learner wants to say (in Japanese):\n${args.jaText}`
    : `The learner wants to say (in Japanese):\n${args.jaText}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: PHRASE_HINT_SYSTEM });
  const parsed = extractJson<{ suggestions: PhraseHint[] }>(text);
  if (parsed && Array.isArray(parsed.suggestions)) {
    const suggestions = parsed.suggestions
      .filter((s) => typeof s?.en === "string" && s.en)
      .map((s) => ({ en: s.en, ja: typeof s.ja === "string" ? s.ja : "" }));
    if (suggestions.length > 0) return { suggestions };
  }
  // パース失敗時のフォールバック: 素のテキストを1件に包んでUIに出せる形にする
  return { suggestions: [{ en: text.trim(), ja: "" }] };
}

const FIX_EXPLAIN_SYSTEM = `You are an English coach for a Japanese learner (CEFR A2-B1).
The learner said something that was corrected. You receive the original wording, the corrected ("better") version, and optionally a short note about the issue.
Explain IN JAPANESE, plain text (no markdown, no headings), within 8 lines, in this order:
1. なぜ better の言い方の方が自然・正しいのか（核心を1〜2文で）
2. 使い回し例: 同じ直し方が効く別の英文を1つ、日本語訳付きで
3. 覚え方のヒントを1文
Write English example sentences in English; everything else in Japanese. Do not scold the learner.
Do not use any tools — reply directly with text only.`;

/** 訂正（original→better）の詳しい日本語解説を生成する（プレーンテキスト・キャッシュしない・ボタン起点） */
export async function generateFixExplanation(
  args: { original: string; better: string; note?: string },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ text: string }> {
  const noteLine = args.note?.trim() ? `\nIssue: ${args.note.trim()}` : "";
  const prompt = `Original: ${args.original}\nBetter: ${args.better}${noteLine}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: FIX_EXPLAIN_SYSTEM });
  return { text: text.trim() };
}

function modelTalkSystem(stage: number): string {
  const vocab = vocabConstraint(stage);
  // stage>=4（vocab===null）は旧文言を一字一句維持する（上級者の挙動不変）
  const rules = vocab
    ? `Rules: 120-150 words, spoken register, first person, short sentences. ${vocab}`
    : "Rules: 120-150 words, spoken register, first person, plain high-frequency vocabulary, short sentences.";
  return `You produce a model monologue for an English learner (CEFR B1) to shadow.
${rules}
No headings, no lists — just the monologue text.
Do not use any tools — reply directly with text only.`;
}

export async function generateModelTalk(
  args: { topicTitle: string; hints: string[]; stage: number },
  runner: ClaudeRunner = defaultRunner,
): Promise<{ text: string }> {
  const prompt = `Topic: ${args.topicTitle}\nCover these angles:\n${args.hints.map((h) => `- ${h}`).join("\n")}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: modelTalkSystem(args.stage) });
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

export type PrepPack = { chunks: Array<{ en: string; ja: string }>; outline: string[]; hintDefault: HintLang };

function prepSystem(chunkCount: number, stage: number): string {
  const vocab = vocabConstraint(stage);
  // stage>=4（vocab===null）はバレット自体を挿入しない（元々このバレットは存在しなかった＝上級者の挙動不変）
  const vocabBullet = vocab ? `\n- ${vocab}` : "";
  return `You prepare a Japanese IT professional (CEFR A2-B1) for a short English monologue.
You receive a topic and hint angles. Reply with STRICT JSON only — no markdown fences, no commentary — exactly this shape:
{"chunks":[{"en":"<complete, speakable sentence, B1 level>","ja":"<自然な日本語訳>"}],"outline":["<short English bullet>"]}
Rules:
- Exactly ${chunkCount} chunks. Each "en" MUST be a complete, speakable sentence of roughly 8-16 words that the learner can read aloud as-is.
  No ellipses ("..."), no blanks, and no placeholders like [X] — always fill the slot with a concrete, topic-relevant
  example a B1-level IT professional could plausibly say, using the given topic and hints for the content
  (e.g. "The main problem we had was a slow database query.", "What worked well was splitting the task into smaller steps.").${vocabBullet}
- Keep the reusable sentence frame recognizable at the START of each sentence (sentence-starter + filled example), so the
  learner can reuse that same frame with their own content in the next exercise.
- ja: the natural full-sentence Japanese translation of "en" (not a fragment).
- outline: 3-4 bullets forming a simple talk skeleton (opening → 1-2 points → wrap-up), tied to the given hints.
Do not use any tools — reply directly with text only.`;
}

export async function generatePrepPack(
  args: { topicTitle: string; hints: string[]; chunkCount?: number; hintLang?: HintLang; stage: number },
  runner: ClaudeRunner = defaultRunner,
): Promise<PrepPack> {
  const chunkCount = args.chunkCount ?? 6;
  // hintLang は「表示既定の供給者」。ja のデータ自体は常に返し、表示するかはクライアントが決める。
  const hintDefault: HintLang = args.hintLang ?? "ja";
  const prompt = `Topic: ${args.topicTitle}\nHint angles:\n${args.hints.map((h) => `- ${h}`).join("\n")}`;
  const { text } = await runner(prompt, undefined, { systemPrompt: prepSystem(chunkCount, args.stage) });
  const parsed = extractJson<PrepPack>(text);
  if (parsed && Array.isArray(parsed.chunks) && Array.isArray(parsed.outline)) {
    // Sanitize chunks: keep only items where both en and ja are strings（ja は空にしない）
    const chunks = parsed.chunks
      .filter((item) => typeof item?.en === "string" && item.en && typeof item?.ja === "string")
      .map((item) => ({ en: item.en, ja: item.ja }));
    // Sanitize outline: keep only string elements
    const outline = parsed.outline.filter((el) => typeof el === "string");
    return { chunks, outline, hintDefault };
  }
  // パース失敗時のフォールバック: チャンクなし・素のテキストをアウトラインとして表示できる形
  return { chunks: [], outline: [text], hintDefault };
}

export function roleplayPrompt(scenario: { title: string; hints: string[] }, stage: number): string {
  return `You are an English roleplay partner for a Japanese IT professional (CEFR A2-B1).
Scenario: ${scenario.title}
Setup:
${scenario.hints.map((h) => `- ${h}`).join("\n")}
Rules:
- Stay in your assigned role for the whole conversation. Do not break character.
- Keep every reply SHORT: 2-4 sentences, then ask ONE question or make ONE request.
- ${vocabConstraint(stage) ?? "Use plain, high-frequency English (B1 level). No rare idioms."}
- Do NOT correct the learner's errors explicitly; respond naturally.
- Never switch to Japanese.
- Do not use any tools — reply directly with text only.`;
}
