/**
 * 週次のポーズ比率・言い直し率カードの信頼性判定。
 * これらはASR（whisper）のセグメント区切りから推定した参考値で、母数が小さい週は
 * 数発話の区切られ方だけで大きく振れる。能力の判定に見えないよう、疎な週は
 * 「データ不足」を明示し、比較対象の週が疎なときは前週比を出さない（Issue #183）。
 */

/** 率と前週比を確定値として見せるのに必要な週あたりの最小発話数 */
export const MIN_WEEKLY_UTTERANCES = 5;

export type WeeklyRateView =
  /** 今週の発話が少なく、値がまだ安定していない */
  | { kind: "insufficient" }
  /** 値は表示できる。trend=null は前週側のデータ不足で比較を出さない */
  | { kind: "value"; trend: "up" | "down" | "flat" | null };

/** 良し悪しの判定ではなく方向だけを返す（±5%は横ばい扱い） */
function trendOf(cur: number, prev: number): "up" | "down" | "flat" {
  if (prev === 0) return cur === 0 ? "flat" : "up";
  const diff = (cur - prev) / prev;
  if (diff > 0.05) return "up";
  if (diff < -0.05) return "down";
  return "flat";
}

export function weeklyRateView(
  current: { utterances: number },
  previous: { utterances: number },
  curValue: number,
  prevValue: number,
): WeeklyRateView {
  if (current.utterances < MIN_WEEKLY_UTTERANCES) return { kind: "insufficient" };
  if (previous.utterances < MIN_WEEKLY_UTTERANCES) return { kind: "value", trend: null };
  return { kind: "value", trend: trendOf(curValue, prevValue) };
}
