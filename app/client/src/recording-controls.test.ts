import { describe, expect, test } from "bun:test";
import { canDiscardConversationRecording, placementRecordingAction } from "./recording-controls";

describe("会話録音の破棄可能状態", () => {
  test("マイク準備中と録音中だけ、会話に送らず破棄できる", () => {
    expect(canDiscardConversationRecording("starting")).toBe(true);
    expect(canDiscardConversationRecording("recording")).toBe(true);
    expect(canDiscardConversationRecording("idle")).toBe(false);
    expect(canDiscardConversationRecording("transcribing")).toBe(false);
    expect(canDiscardConversationRecording("thinking")).toBe(false);
    expect(canDiscardConversationRecording("speaking")).toBe(false);
    expect(canDiscardConversationRecording("error")).toBe(false);
  });
});

describe("レベル測定の再録音表示", () => {
  test("回答済みなら置き換え操作として扱う", () => {
    expect(placementRecordingAction(false)).toBe("start");
    expect(placementRecordingAction(true)).toBe("replace");
  });
});
