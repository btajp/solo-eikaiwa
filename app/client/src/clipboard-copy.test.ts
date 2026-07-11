import { describe, expect, test } from "bun:test";
import { canStartClipboardCopy, transitionClipboardCopyStatus } from "./clipboard-copy";

describe("一括コピーの状態", () => {
  test("コピー中の多重開始を防ぐ", () => {
    const copying = transitionClipboardCopyStatus("idle", "start");

    expect(copying).toBe("copying");
    expect(canStartClipboardCopy(copying)).toBe(false);
  });

  test("成功後は完了表示になり、時間経過で初期表示へ戻せる", () => {
    const copied = transitionClipboardCopyStatus("copying", "succeeded");

    expect(copied).toBe("copied");
    expect(transitionClipboardCopyStatus(copied, "reset")).toBe("idle");
  });

  test("失敗後は再試行して成功できる", () => {
    const failed = transitionClipboardCopyStatus("copying", "failed");
    const retried = transitionClipboardCopyStatus(failed, "start");

    expect(failed).toBe("error");
    expect(canStartClipboardCopy(failed)).toBe(true);
    expect(transitionClipboardCopyStatus(retried, "succeeded")).toBe("copied");
  });

  test("現在の状態に合わない完了・失敗・resetイベントは状態を変えない", () => {
    expect(transitionClipboardCopyStatus("idle", "succeeded")).toBe("idle");
    expect(transitionClipboardCopyStatus("copied", "failed")).toBe("copied");
    expect(transitionClipboardCopyStatus("copying", "reset")).toBe("copying");
  });
});
