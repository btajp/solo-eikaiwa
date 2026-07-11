import type { ErrorAction } from "../lib/user-error";
import type { ConversationPipelineFailure } from "./free-talk-flow";

/** 再試行する段階に合わせて、安全な利用者向け失敗案内の操作名を選ぶ。 */
export function pipelineFailureAction(
  failure: Exclude<ConversationPipelineFailure, "stt-empty">,
  hasCachedAudio: boolean,
): ErrorAction {
  return failure === "audio" && hasCachedAudio ? "play" : "request";
}
