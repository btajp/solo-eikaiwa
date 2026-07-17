/**
 * 話し言葉系の生成プロンプトへ注入する共通スタイル指示。
 * 監査(docs/superpowers/plans/2026-07-09-spoken-register-pack.md)が指摘した
 * 「短縮形0%の教科書調」「上級帯 平均17.8〜19.4語/文のエッセイ調」を防ぐための共通ブロック。
 */

export type SpokenBand = "beginner" | "intermediate" | "advanced";

export const SPOKEN_STYLE_BLOCK =
  "Spoken-register style: use contractions by default (I'm, don't, it's, we've, that's, can't) — this text will be spoken aloud and listened to, not read as writing. " +
  'Keep it sounding like natural talk, not an essay: do not use written-register connectors like "moreover", "furthermore", "therefore", "in addition", or "utilize" — use "so", "and", "plus", or "but" instead. ' +
  "Do not use bullet points, numbered lists, or headings inside the spoken text — write it as continuous natural speech.";

/**
 * intermediate/advanced の短縮形ノルマ行。beginner の定量ノルマ（T3差し戻しで導入）と同趣旨。
 * #195 の再生成で intermediate 帯も短縮形率ゲート（spoken-register-check の下限0.2）へ系統的に
 * FAILする実例を観測した（reporting-a-bug/stage3: 実測7回連続 0.06〜0.13。過去形の体験談トピック
 * では短縮形が自然に出る構文が減り、緩い指示では系統的に下限を割る）。beginner ブロックで実績の
 * ある mandatory 表現＋定量ノルマに、過去形narration向けの具体例（didn't/wasn't/couldn't）を足して
 * 機械ゲートと同じ期待値をプロンプト側にも明示する（ゲート済みの既存生成物の合否は変わらない＝再生成不要）。
 */
const CONTRACTION_QUOTA =
  "Contractions (I'm, it's, don't, didn't, that's) are mandatory — writing \"I am\" / \"do not\" / \"it is\" throughout turns this into a textbook, not natural speech. " +
  "Use a contraction in at least one of every three sentences (aim for one in every two), even in past-tense narration (didn't, wasn't, couldn't, I'd).";

const LENGTH_CAP_BY_BAND: Record<SpokenBand, string> = {
  beginner:
    "Keep sentences short and simple: mostly 6-10 words, one idea per sentence. " +
    "Simple vocabulary does NOT mean formal style: contractions (I'm, it's, don't, that's, we've) are mandatory even at this level — " +
    'writing "I am" / "do not" / "it is" throughout turns this into a textbook, not natural speech. ' +
    "Use a contraction in at least one of every three sentences (aim for one in every two).",
  intermediate: `Keep sentences short: mostly 9-13 words per sentence. ${CONTRACTION_QUOTA}`,
  advanced:
    `Even at this level, keep sentences short for natural speech: mostly 10-15 words — split a long idea into two short sentences instead of chaining clauses with commas. ${CONTRACTION_QUOTA}`,
};

/** SPOKEN_STYLE_BLOCK に帯別の文長ガイドを足して返す（多聴のような長文生成向け） */
export function spokenStyleFor(band: SpokenBand): string {
  return `${SPOKEN_STYLE_BLOCK} ${LENGTH_CAP_BY_BAND[band]}`;
}

/**
 * stage(1..6) → SpokenBand。content-coverage.ts の BAND_STAGE_RANGE（foundation[1,2]/development[3,4]/
 * fluency[5,6]）と同じ境界を beginner/intermediate/advanced に対応させる（content-gen.ts の
 * SPOKEN_BAND_FOR_BAND と同じ対応をstage単位の入力向けに提供する）。
 */
export function spokenBandForStage(stage: number): SpokenBand {
  if (stage <= 2) return "beginner";
  if (stage <= 4) return "intermediate";
  return "advanced";
}
