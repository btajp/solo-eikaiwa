export type AnswerGrade = "good" | "soso" | "bad";
export type PendingAnswer = { itemKey: string; answerId: string; grade: AnswerGrade };

/** response消失後は同じitemの最初のrequestを再送し、新しいitemだけ新IDを発行する。 */
export function resolvePendingAnswer(
  current: PendingAnswer | null,
  itemKey: string,
  requestedGrade: AnswerGrade,
  makeId: () => string = () => crypto.randomUUID(),
): PendingAnswer {
  return current?.itemKey === itemKey
    ? current
    : { itemKey, answerId: makeId(), grade: requestedGrade };
}
