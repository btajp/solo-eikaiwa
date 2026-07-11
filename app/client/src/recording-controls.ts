export type ConversationRecordingStatus =
  | "idle"
  | "starting"
  | "recording"
  | "transcribing"
  | "stt-retry"
  | "thinking"
  | "reply-retry"
  | "synthesizing"
  | "speaking"
  | "audio-retry";

export type ConversationPrimaryAction = "record" | "stop" | "retry-stt" | "retry-reply" | "retry-audio" | "busy";

/** 現在の段階に対応する主CTA。失敗時は録音へ戻さず、失敗した段階だけを再試行する。 */
export function conversationPrimaryAction(status: ConversationRecordingStatus): ConversationPrimaryAction {
  switch (status) {
    case "idle": return "record";
    case "recording": return "stop";
    case "stt-retry": return "retry-stt";
    case "reply-retry": return "retry-reply";
    case "audio-retry": return "retry-audio";
    case "starting":
    case "transcribing":
    case "thinking":
    case "synthesizing":
    case "speaking": return "busy";
  }
}

/** 録音開始待ちと録音中だけ、会話に送らず安全に破棄できる。 */
export function canDiscardConversationRecording(status: ConversationRecordingStatus): boolean {
  return status === "starting" || status === "recording";
}

/** レベル測定は既存回答がある場合、次の録音でその回答を置き換える。 */
export function placementRecordingAction(hasAnswer: boolean): "start" | "replace" {
  return hasAnswer ? "replace" : "start";
}
