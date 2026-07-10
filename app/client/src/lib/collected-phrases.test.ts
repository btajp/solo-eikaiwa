import { describe, expect, test } from "bun:test";
import { collectedPhrasesNoticeKind } from "./collected-phrases";

describe("自動収集表現の表示状態", () => {
  test("実際に保存された表現があるときだけ保存済みとして表示する", () => {
    expect(collectedPhrasesNoticeKind({
      collectedChunks: 1,
      collectedChunkItems: [{ id: 1, promptText: "I go", en: "I went" }],
      collectedChunkStatus: "saved",
    })).toBe("saved");
  });

  test("重複・日次上限などで追加がない場合は保存済みと表示しない", () => {
    expect(collectedPhrasesNoticeKind({
      collectedChunks: 0, collectedChunkItems: [], collectedChunkStatus: "none",
    })).toBe("none");
  });

  test("保存失敗と不整合な成功応答を区別して成功表示を避ける", () => {
    expect(collectedPhrasesNoticeKind({
      collectedChunks: 0, collectedChunkItems: [], collectedChunkStatus: "failed",
    })).toBe("failed");
    expect(collectedPhrasesNoticeKind({
      collectedChunks: 1, collectedChunkItems: [], collectedChunkStatus: "saved",
    })).toBe("none");
  });
});
