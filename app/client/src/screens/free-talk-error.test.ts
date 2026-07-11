import { describe, expect, test } from "bun:test";
import { pipelineFailureAction } from "./free-talk-error";

describe("自由会話の再試行エラー案内", () => {
  test("STTと会話応答の失敗は録音ではなくリクエストの再試行として案内する", () => {
    expect(pipelineFailureAction("stt", false)).toBe("request");
    expect(pipelineFailureAction("reply", false)).toBe("request");
  });

  test("音声取得失敗と再生失敗を保持済み音声の有無で区別する", () => {
    expect(pipelineFailureAction("audio", false)).toBe("request");
    expect(pipelineFailureAction("audio", true)).toBe("play");
  });
});
