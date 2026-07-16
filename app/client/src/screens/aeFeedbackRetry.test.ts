import { describe, expect, test } from "bun:test";
import { canRetryAeFeedback } from "./aeFeedbackRetry";

describe("4/3/2 AEフィードバックの再試行導線 (#200)", () => {
  test("取得失敗後、transcript が残っていれば再試行を提示する", () => {
    expect(canRetryAeFeedback({ errorMsg: "request failed", aeLoading: false, transcript: "I talked about my project." })).toBe(true);
  });

  test("エラーが出ていないときは再試行を出さない", () => {
    expect(canRetryAeFeedback({ errorMsg: "", aeLoading: false, transcript: "I talked about my project." })).toBe(false);
  });

  test("再試行中（取得中）はボタンを出さない", () => {
    expect(canRetryAeFeedback({ errorMsg: "request failed", aeLoading: true, transcript: "I talked about my project." })).toBe(false);
  });

  test("transcript が空・空白のみなら再試行しても意味がないため出さない", () => {
    expect(canRetryAeFeedback({ errorMsg: "request failed", aeLoading: false, transcript: "" })).toBe(false);
    expect(canRetryAeFeedback({ errorMsg: "request failed", aeLoading: false, transcript: "   " })).toBe(false);
  });
});
