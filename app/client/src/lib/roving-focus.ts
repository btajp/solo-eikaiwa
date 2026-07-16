/**
 * WAI-ARIA APG の複合ウィジェット（tablist / radiogroup）向けの roving tabindex 用キーボード移動。
 * 呼び出し側は戻り値の index へフォーカスを移し、選択を追従させる（selection follows focus）。
 */
export type RovingOrientation = "horizontal" | "both";

/**
 * 矢印キー・Home・End の移動先 index を返す。対象外のキーや不正な現在位置は null
 * （呼び出し側はブラウザ既定の動作を妨げない）。矢印は端で反対側へ折り返す（APG 推奨）。
 */
export function rovingTargetIndex(
  key: string, current: number, count: number, orientation: RovingOrientation = "both",
): number | null {
  if (count <= 0 || current < 0 || current >= count) return null;
  const forward = key === "ArrowRight" || (orientation === "both" && key === "ArrowDown");
  const backward = key === "ArrowLeft" || (orientation === "both" && key === "ArrowUp");
  if (forward) return (current + 1) % count;
  if (backward) return (current - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return null;
}
