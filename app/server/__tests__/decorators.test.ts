import { describe, expect, test } from "bun:test";
import { withTimeout } from "../providers/decorators";
import { TransportError } from "../providers/errors";
import type { ClaudeRunner } from "../converse";

describe("withTimeout", () => {
  test("期限内はそのまま解決し、超過時は TransportError で reject する", async () => {
    const slow: ClaudeRunner = () =>
      new Promise((r) => setTimeout(() => r({ text: "ok", sessionId: "s" }), 50));

    await expect(withTimeout(slow, 1000)("x")).resolves.toEqual({ text: "ok", sessionId: "s" });
    await expect(withTimeout(slow, 10)("x")).rejects.toBeInstanceOf(TransportError);
  });

  test("解決後にタイマーが必ず clear される（setTimeout/clearTimeout をモックして検証）", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    let capturedId: ReturnType<typeof setTimeout> | undefined;
    const clearedIds: unknown[] = [];

    // @ts-expect-error: テスト用に一時的にグローバルの型を緩めてラップする
    globalThis.setTimeout = (fn: (...args: unknown[]) => void, ms?: number) => {
      capturedId = originalSetTimeout(fn, ms);
      return capturedId;
    };
    globalThis.clearTimeout = (id: unknown) => {
      clearedIds.push(id);
      return originalClearTimeout(id as Parameters<typeof clearTimeout>[0]);
    };

    try {
      const fast: ClaudeRunner = () => Promise.resolve({ text: "ok", sessionId: "s" });
      await withTimeout(fast, 1000)("x");
      expect(capturedId).toBeDefined();
      expect(clearedIds).toContain(capturedId);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
