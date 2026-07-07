/**
 * レベル/XP/難易度つまみの純粋計算（スペック §3〜§5）。
 * 数値はすべてここで一元定義する — 他ファイルに複製しない。
 */

export type HintLang = "ja" | "en";
export type ModelTalkMode = "auto" | "button";
export type PrepSupport = { chunkCount: number; hintLang: HintLang; modelTalk: ModelTalkMode };

/** プレースメント未実施時の開始レベル（stage 1 の入口。出だしの負荷を下げる — 旧値13は重すぎるとのフィードバック反映） */
export const DEFAULT_LEVEL = 5;

/** ステージ境界レベル（この level で自動昇格が止まり、提案＋承認になる）。60→61 は同stageなので境界ではない */
export const BOUNDARY_LEVELS: readonly number[] = [10, 20, 30, 40, 50];

/** stage 1..6。Lv61+ は 6 に張り付く（難易度据え置きのおまけレベル帯） */
export function stageOf(level: number): number {
  return Math.min(6, Math.ceil(level / 10));
}

function round5(x: number): number {
  return Math.round(x / 5) * 5;
}

/** 4/3/2 初回ラウンド秒の制御点 (level, sec)。区間線形補間・round5。単調非減少・Lv60 で 180 頭打ち。
 *  stage1=60秒開始（初学者の負荷減）、Lv11/13 は現行同値（既存体感維持）。 */
const FTT_FIRST_SEC_POINTS: ReadonlyArray<readonly [number, number]> = [
  [1, 60], [11, 105], [21, 125], [31, 145], [41, 160], [51, 172], [60, 180],
];

/** 4/3/2 の初回ラウンド秒。制御点間を線形補間して round5 で丸める */
function fttFirstSec(level: number): number {
  const L = Math.min(Math.max(level, 1), 60);
  const pts = FTT_FIRST_SEC_POINTS;
  for (let i = 0; i < pts.length - 1; i++) {
    const [l0, s0] = pts[i];
    const [l1, s1] = pts[i + 1];
    if (L <= l1) return round5(s0 + ((L - l0) / (l1 - l0)) * (s1 - s0));
  }
  return round5(pts[pts.length - 1][1]);
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

/**
 * ステージ別の語彙レベリング制約（生成・会話プロンプトに差し込む1文）。
 * 研究知見5: 95%カバレッジ≈2,000〜3,000語族で非母語話者の聴解が安定する。
 * これは「難易度つまみ」の一種であり、閾値(stage<=3)もここに一元化する。
 * stage>=4 は null を返す（制約なし）— 挿入するかどうか・旧文言をどう保つかは各呼び出し点の責任とする。
 */
export function vocabConstraint(stage: number): string | null {
  return stage <= 3
    ? "Use only the most common 2,000–3,000 English word families (everyday high-frequency vocabulary). Avoid rare, academic, or advanced words, and avoid idioms."
    : null;
}

/** stage(1..6) の代表アンカーレベル（各stageの下寄り中央）。降格先・既定開始レベルの基準。 */
export function stageAnchorLevel(stage: number): number {
  const s = Math.min(Math.max(Math.trunc(stage), 1), 6);
  return (s - 1) * 10 + 5; // stage1→5, stage2→15, ..., stage6→55
}

/** 降格承認時の移動先: 一つ下の stage の開始アンカー（体感差を作る）。stage1 では呼ばない前提（提案側で抑止） */
export function demotionTargetLevel(level: number): number {
  return stageAnchorLevel(stageOf(level) - 1);
}

/** 自己評価1枚ごとの努力XP（スペック§4.1: good=2 / soso・bad=1）。routes 側の分散リテラルを一元化 */
export function xpForGrade(grade: "good" | "soso" | "bad"): number {
  return grade === "good" ? 2 : 1;
}

/** プレースメント測定完了の固定XP（スペック§4.1）。progress-store の XP_CAPS.placement と routes の二重定義を一元化 */
export const PLACEMENT_XP = 10;

/** 4/3/2「低産出ラウンド」判定: この秒数以上取り組んで（engaged）、語数がフロア未満なら苦戦とみなす。降格シグナル用 */
export const FTT_ENGAGED_SEC = 20;
export const FTT_WORDS_FLOOR = 8;
