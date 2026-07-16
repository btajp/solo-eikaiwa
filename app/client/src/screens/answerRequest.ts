import { describeClientError } from "../api/http";

export type AnswerGrade = "good" | "soso" | "bad";
export type PendingAnswer = { itemKey: string; answerId: string; grade: AnswerGrade };

/**
 * response消失後の再試行では同じitemのanswerIdを維持して二重適用を防ぎつつ、
 * gradeは常に最新の選択を採用する（初回requestが未着なら選び直しがそのまま記録される）。
 */
export function resolvePendingAnswer(
  current: PendingAnswer | null,
  itemKey: string,
  requestedGrade: AnswerGrade,
  makeId: () => string = () => crypto.randomUUID(),
): PendingAnswer {
  if (current?.itemKey !== itemKey) return { itemKey, answerId: makeId(), grade: requestedGrade };
  return { ...current, grade: requestedGrade };
}

/**
 * 評価APIの409 = 同じanswerIdが別のgradeで台帳に記録済み。
 * このフローでは「初回の送信は実は届いていて、responseだけ消失した」ことを意味する。
 * 前提: grade系ルートが409を返すのはsrs台帳conflictのみで、statusはthrow直後の
 * 同期的なcatchで参照するため保持キャッシュから必ず復元できる。
 */
export function isAnswerConflict(error: unknown): boolean {
  return describeClientError(error).status === 409;
}
