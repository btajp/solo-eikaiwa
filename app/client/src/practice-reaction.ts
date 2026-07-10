/** 自由会話の感想は、利用者が練習を終えたと明示したあとだけ表示する。 */
export function canShowFreeTalkReaction(turnCount: number, practiceFinished: boolean): boolean {
  return practiceFinished && turnCount >= 2;
}
