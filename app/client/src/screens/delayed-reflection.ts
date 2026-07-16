/**
 * クイック・ロールプレイと自由会話の任意の遅延訂正ループ (#179)。
 * 会話中は訂正せず（流暢さ優先・converse/coach のプロンプトで担保）、終了後の明示操作でのみ
 * 振り返りを取得・表示する。未実施でも警告・減点・未完了扱いにしない（binding 制約）。
 */

/** 提示する訂正の上限。既存の振り返り（Reflection）プロンプトの「3件まで」と揃える。 */
export const DELAYED_REFLECTION_MAX_FIXES = 3;

/**
 * 自由会話: 利用者が「この練習を終える」を明示し、かつ自分の発話が1回以上あるときだけ
 * 任意の振り返り導線を出す。発話ゼロでは訂正材料がなく、空の振り返りを生成させない。
 */
export function canOfferDelayedReflection(practiceFinished: boolean, learnerTurnCount: number): boolean {
  return practiceFinished && learnerTurnCount >= 1;
}

/**
 * クイックドリル: 完了画面で任意の振り返り導線を出すのは会話を伴うロールプレイだけ。
 * 4/3/2 には既存の AE フィードバック、通しセッションには専用の振り返りブロックがあるため出さない。
 */
export function shouldOfferQuickSessionReflection(
  source: { type: "daily" | "quick"; drill?: string },
  done: boolean,
): boolean {
  return done && source.type === "quick" && source.drill === "roleplay";
}

/** 訂正の提示は最大3件（サーバのプロンプト上限と同じ値をクライアントでも保証する）。 */
export function limitDelayedReflectionFixes<T>(fixes: T[]): T[] {
  return fixes.slice(0, DELAYED_REFLECTION_MAX_FIXES);
}
