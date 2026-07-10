import { describe, expect, test } from "bun:test";
import { resolvePendingAnswer } from "./answerRequest";

describe("resolvePendingAnswer", () => {
  test("同じcardの再試行はanswerIdと最初の評価を保持する", () => {
    const first = resolvePendingAnswer(null, "sentence:1", "good", () => "answer-first");
    const retry = resolvePendingAnswer(first, "sentence:1", "bad", () => "answer-second");
    expect(retry).toBe(first);
    expect(retry).toEqual({ itemKey: "sentence:1", answerId: "answer-first", grade: "good" });
  });

  test("次のcardでは新しいanswerIdを発行する", () => {
    const first = resolvePendingAnswer(null, "sentence:1", "good", () => "answer-first");
    const next = resolvePendingAnswer(first, "chunk:2", "soso", () => "answer-next");
    expect(next).toEqual({ itemKey: "chunk:2", answerId: "answer-next", grade: "soso" });
  });
});
