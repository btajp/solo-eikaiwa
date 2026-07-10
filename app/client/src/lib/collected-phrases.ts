import type { CollectedChunks } from "../api/coach";

export type CollectedPhrasesNoticeKind = "saved" | "none" | "failed";

/** サーバの保存結果を、利用者に誤解なく見せる3状態へ正規化する。 */
export function collectedPhrasesNoticeKind(summary: CollectedChunks): CollectedPhrasesNoticeKind {
  if (summary.collectedChunkStatus === "failed") return "failed";
  if (
    summary.collectedChunkStatus === "saved"
    && summary.collectedChunks > 0
    && summary.collectedChunks === summary.collectedChunkItems.length
  ) return "saved";
  return "none";
}
