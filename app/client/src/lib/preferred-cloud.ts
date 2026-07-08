import type { CloudTarget } from "./llm-assignments";

const KEY = "llm.preferredCloud";

/** プリセット適用時のクラウド枠に使う優先クラウド（クライアント専用・localStorage永続）。 */
export function loadPreferredCloud(): CloudTarget {
  return localStorage.getItem(KEY) === "codex" ? "codex" : "claude";
}
export function savePreferredCloud(c: CloudTarget): void {
  localStorage.setItem(KEY, c);
}
