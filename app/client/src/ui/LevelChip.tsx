import { STR, type Lang } from "../i18n";

/** 難易度の実態を1語で開示するチップ。kind は事実マップに厳密対応（嘘のチップは信頼を壊す）。 */
export function LevelChip({ kind, lang }: { kind: "auto" | "band" | "all"; lang: Lang }) {
  const t = STR[lang].levelChip;
  return <span className="level-chip">{kind === "auto" ? t.auto : kind === "band" ? t.band : t.all}</span>;
}
