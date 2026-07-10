export type ConversationRecordingStatus =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

/** 録音開始待ちと録音中だけ、会話に送らず安全に破棄できる。 */
export function canDiscardConversationRecording(status: ConversationRecordingStatus): boolean {
  return status === "starting" || status === "recording";
}

/** レベル測定は既存回答がある場合、次の録音でその回答を置き換える。 */
export function placementRecordingAction(hasAnswer: boolean): "start" | "replace" {
  return hasAnswer ? "replace" : "start";
}
