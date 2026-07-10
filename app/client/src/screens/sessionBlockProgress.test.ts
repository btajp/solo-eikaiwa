import { describe, expect, test } from "bun:test";
import {
  blockCompletionGate,
  initialBlockProgress,
  markBlockReady,
  markValidAttempt,
  requiresInternalCompletion,
  SESSION_BLOCK_KINDS,
} from "./sessionBlockProgress";

describe("session block progress", () => {
  test("準備前・有効な実施前には完了できない", () => {
    const initial = initialBlockProgress();
    expect(blockCompletionGate(initial)).toBe("preparing");
    expect(markValidAttempt(initial)).toEqual(initial);

    const ready = markBlockReady(initial);
    expect(blockCompletionGate(ready)).toBe("needs-attempt");
    expect(markValidAttempt(ready)).toEqual({ ready: true, validAttempt: true });
  });

  test("主要なセッション種別は準備済みかつ有効な実施があったときだけ完了対象になる", () => {
    for (const kind of SESSION_BLOCK_KINDS) {
      const ready = markBlockReady(initialBlockProgress());
      expect(blockCompletionGate(ready), kind).toBe("needs-attempt");
      expect(blockCompletionGate(markValidAttempt(ready)), kind).toBe("ready");
    }
  });

  test("4/3/2だけは内部ラウンドを終えるまで親の完了導線を出さない", () => {
    expect(requiresInternalCompletion("four-three-two")).toBe(true);
    for (const kind of SESSION_BLOCK_KINDS.filter((kind) => kind !== "four-three-two")) {
      expect(requiresInternalCompletion(kind), kind).toBe(false);
    }
  });
});
