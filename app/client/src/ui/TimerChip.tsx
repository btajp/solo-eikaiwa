import { formatMmSs } from "../useCountdown";

/** 等幅数字のカウントダウンチップ。残りわずかで色が変わる（情報として） */
export function TimerChip({
  remaining, expired, warnAt = 30, note, ariaLabel,
}: {
  remaining: number; expired: boolean; warnAt?: number; note?: string; ariaLabel?: string;
}) {
  const cls = expired ? " is-expired" : remaining <= warnAt ? " is-warn" : "";
  return (
    <span className={`timer-chip${cls}`} {...(ariaLabel ? { role: "timer", "aria-label": ariaLabel } : {})}>
      ⏱ {formatMmSs(remaining)}
      {expired && note && <span> — {note}</span>}
    </span>
  );
}
