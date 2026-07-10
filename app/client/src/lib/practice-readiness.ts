/** 録音を伴う練習で開始前に必要となる実行環境。 */
export type PracticeCapability = "stt" | "llm";

/** health 応答のうち、開始可否に必要な最小部分。古いサーバでは各項目が無いことがある。 */
export type PracticeHealth = {
  modelFile?: boolean;
  llmReady?: boolean;
} | null;

/** ホーム・サイドバーから開始できる機能の、事前確認に必要な最小形。 */
export type ReadinessStartSelection =
  | { type: "free" | "placement" | "library" }
  | { type: "session"; source: { type: "daily" | "quick"; drill?: string } };

/** 録音開始と、その後の会話・採点まで完了するための要件。 */
export const RECORDING_PRACTICE_CAPABILITIES: readonly PracticeCapability[] = ["stt", "llm"];

/**
 * 明示的に false と報告された機能だけを不足として返す。
 *
 * health が未取得・旧サーバでフィールドが無い場合まで開始不能にすると、既存の動作を壊すため、
 * その場合は従来どおり実行してサーバ側のエラーを扱う。
 */
export function missingPracticeCapabilities(
  health: PracticeHealth,
  required: readonly PracticeCapability[] = RECORDING_PRACTICE_CAPABILITIES,
): PracticeCapability[] {
  if (health === null) return [];
  return required.filter((capability) => {
    if (capability === "stt") return health.modelFile === false;
    return health.llmReady === false;
  });
}

/** 録音を伴う開始操作を進めてよいか。UIのガードと単体テストで共用する。 */
export function canStartRecordingPractice(health: PracticeHealth): boolean {
  return missingPracticeCapabilities(health).length === 0;
}

/**
 * ホームの開始CTAで、直ちに録音する練習だけを判定する。
 * 通しセッションは非録音ブロックもあるため、4/3/2・ロールプレイの実際の開始ボタンでも同じ確認を行う。
 */
export function startSelectionNeedsRecordingReadiness(selection: ReadinessStartSelection): boolean {
  if (selection.type === "free" || selection.type === "placement") return true;
  return selection.type === "session" && selection.source.type === "quick"
    && (selection.source.drill === "ftt-mini" || selection.source.drill === "roleplay");
}
