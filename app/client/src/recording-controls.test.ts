import { describe, expect, test } from "bun:test";
import { canDiscardConversationRecording, conversationPrimaryAction, placementRecordingAction } from "./recording-controls";

describe("会話録音の破棄可能状態", () => {
  test("マイク準備中と録音中だけ、会話に送らず破棄できる", () => {
    expect(canDiscardConversationRecording("starting")).toBe(true);
    expect(canDiscardConversationRecording("recording")).toBe(true);
    expect(canDiscardConversationRecording("idle")).toBe(false);
    expect(canDiscardConversationRecording("transcribing")).toBe(false);
    expect(canDiscardConversationRecording("stt-retry")).toBe(false);
    expect(canDiscardConversationRecording("thinking")).toBe(false);
    expect(canDiscardConversationRecording("reply-retry")).toBe(false);
    expect(canDiscardConversationRecording("synthesizing")).toBe(false);
    expect(canDiscardConversationRecording("speaking")).toBe(false);
    expect(canDiscardConversationRecording("audio-retry")).toBe(false);
  });
});

describe("会話の主CTA", () => {
  test("失敗段階だけ再試行し、処理中は操作を待機状態として示す", () => {
    expect(conversationPrimaryAction("idle")).toBe("record");
    expect(conversationPrimaryAction("recording")).toBe("stop");
    expect(conversationPrimaryAction("stt-retry")).toBe("retry-stt");
    expect(conversationPrimaryAction("reply-retry")).toBe("retry-reply");
    expect(conversationPrimaryAction("audio-retry")).toBe("retry-audio");
    expect(conversationPrimaryAction("transcribing")).toBe("busy");
    expect(conversationPrimaryAction("synthesizing")).toBe("busy");
  });
});

describe("レベル測定の再録音表示", () => {
  test("回答済みなら置き換え操作として扱う", () => {
    expect(placementRecordingAction(false)).toBe("start");
    expect(placementRecordingAction(true)).toBe("replace");
  });
});
