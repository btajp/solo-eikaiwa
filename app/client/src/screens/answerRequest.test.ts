import { describe, expect, test } from "bun:test";
import { isAnswerConflict, resolvePendingAnswer } from "./answerRequest";
import { extractErrorMessage } from "../api/http";

describe("resolvePendingAnswer", () => {
  test("同じcardの再試行はanswerIdを保持しつつ最新の評価を採用する", () => {
    const first = resolvePendingAnswer(null, "sentence:1", "good", () => "answer-first");
    const retry = resolvePendingAnswer(first, "sentence:1", "bad", () => "answer-second");
    expect(retry).toEqual({ itemKey: "sentence:1", answerId: "answer-first", grade: "bad" });
  });

  test("同じcard・同じ評価の再試行はanswerIdと評価を維持する", () => {
    const first = resolvePendingAnswer(null, "sentence:1", "good", () => "answer-first");
    const retry = resolvePendingAnswer(first, "sentence:1", "good", () => "answer-second");
    expect(retry).toEqual({ itemKey: "sentence:1", answerId: "answer-first", grade: "good" });
  });

  test("次のcardでは新しいanswerIdを発行する", () => {
    const first = resolvePendingAnswer(null, "sentence:1", "good", () => "answer-first");
    const next = resolvePendingAnswer(first, "chunk:2", "soso", () => "answer-next");
    expect(next).toEqual({ itemKey: "chunk:2", answerId: "answer-next", grade: "soso" });
  });
});

describe("isAnswerConflict", () => {
  async function errorFromStatus(status: number): Promise<Error> {
    const res = new Response(JSON.stringify({ error: "x" }), { status });
    return new Error(`grade failed: ${await extractErrorMessage(res)}`);
  }

  test("評価APIの409(初回評価が記録済み)を判別する", async () => {
    expect(isAnswerConflict(await errorFromStatus(409))).toBe(true);
  });

  test("409以外のHTTPエラーはconflictではない", async () => {
    expect(isAnswerConflict(await errorFromStatus(500))).toBe(false);
    expect(isAnswerConflict(await errorFromStatus(400))).toBe(false);
  });

  test("ネットワーク例外(statusなし)はconflictではない", () => {
    expect(isAnswerConflict(new TypeError("Failed to fetch"))).toBe(false);
  });
});
