import { describe, expect, test } from "bun:test";
import { resolvePendingListeningLog } from "./listeningLogRequest";

describe("resolvePendingListeningLog", () => {
  test("初回完了でattempt IDを発行し、保存再試行では同じIDを保持する", () => {
    const first = resolvePendingListeningLog(null, "item-a", () => "listen-first-id");
    const retry = resolvePendingListeningLog(first, "item-a", () => "listen-should-not-change");

    expect(first).toEqual({ itemId: "item-a", attemptId: "listen-first-id" });
    expect(retry).toEqual(first);
  });

  test("保存成功後の次回完了と別素材には新しいattempt IDを発行する", () => {
    const afterSuccess = resolvePendingListeningLog(null, "item-a", () => "listen-next-id");
    const otherItem = resolvePendingListeningLog(afterSuccess, "item-b", () => "listen-other-id");

    expect(afterSuccess.attemptId).toBe("listen-next-id");
    expect(otherItem).toEqual({ itemId: "item-b", attemptId: "listen-other-id" });
  });
});
