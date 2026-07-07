/**
 * レベル/XP/難易度つまみの純粋計算（スペック §3〜§5）。
 * 数値はすべてここで一元定義する — 他ファイルに複製しない。
 */

export type HintLang = "ja" | "en";
export type ModelTalkMode = "auto" | "button";
export type PrepSupport = { chunkCount: number; hintLang: HintLang; modelTalk: ModelTalkMode };

/** プレースメント未実施時の開始レベル（stage 2 のやや下 — 既存の「難しすぎた」フィードバック反映） */
export const DEFAULT_LEVEL = 13;

/** ステージ境界レベル（この level で自動昇格が止まり、提案＋承認になる）。60→61 は同stageなので境界ではない */
export const BOUNDARY_LEVELS: readonly number[] = [10, 20, 30, 40, 50];

/** stage 1..6。Lv61+ は 6 に張り付く（難易度据え置きのおまけレベル帯） */
export function stageOf(level: number): number {
  return Math.min(6, Math.ceil(level / 10));
}

function round5(x: number): number {
  return Math.round(x / 5) * 5;
}

/** 4/3/2 の初回ラウンド秒。Lv1=90 から 1.5秒/レベルで線形、Lv60=180 で頭打ち */
function fttFirstSec(level: number): number {
  return round5(90 + (Math.min(level, 60) - 1) * 1.5);
}

/** 丸め順序は固定: 丸めた first に 0.75/0.5 を掛けてから再度 round5 */
export function fttRoundsSec(level: number): number[] {
  const first = fttFirstSec(level);
  return [first, round5(first * 0.75), round5(first * 0.5)];
}

export function fttMiniRoundsSec(level: number): number[] {
  return fttRoundsSec(level).slice(0, 2);
}

/** 次レベルに必要なXP。stage1..6 → 20,25,30,35,40,45（Lv61+ は 45 のまま） */
export function needXp(level: number): number {
  return 15 + 5 * stageOf(level);
}

const PREP_TABLE: readonly PrepSupport[] = [
  { chunkCount: 8, hintLang: "ja", modelTalk: "auto" },   // stage 1
  { chunkCount: 7, hintLang: "ja", modelTalk: "auto" },   // stage 2
  { chunkCount: 6, hintLang: "ja", modelTalk: "auto" },   // stage 3
  { chunkCount: 5, hintLang: "en", modelTalk: "auto" },   // stage 4
  { chunkCount: 4, hintLang: "en", modelTalk: "button" }, // stage 5
  { chunkCount: 4, hintLang: "en", modelTalk: "button" }, // stage 6（none 廃止: stage6 でも聞く手段を残す）
];

/** stage(1..6) → 準備支援パラメータ。範囲外は端にクランプ */
export function prepParams(stage: number): PrepSupport {
  const i = Math.min(Math.max(Math.trunc(stage), 1), 6) - 1;
  return { ...PREP_TABLE[i] };
}

/** 降格承認時の移動先: 現ステージ最下端の1つ下（例 Lv23→20）。stage1 では呼ばない前提（提案側で抑止） */
export function demotionTargetLevel(level: number): number {
  return (stageOf(level) - 1) * 10;
}

/** 自己評価1枚ごとの努力XP（スペック§4.1: good=2 / soso・bad=1）。routes 側の分散リテラルを一元化 */
export function xpForGrade(grade: "good" | "soso" | "bad"): number {
  return grade === "good" ? 2 : 1;
}

/** プレースメント測定完了の固定XP（スペック§4.1）。progress-store の XP_CAPS.placement と routes の二重定義を一元化 */
export const PLACEMENT_XP = 10;
