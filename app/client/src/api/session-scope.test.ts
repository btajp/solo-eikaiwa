import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchReflection } from "./coach";
import { converse } from "./converse";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("練習session IDのAPI伝播", () => {
  test("converseはLLM resume IDと練習IDを分けて送る", async () => {
    let posted: unknown;
    globalThis.fetch = mock(async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ replyText: "ok", sessionId: "conversation-next" }), { status: 200 });
    }) as unknown as typeof fetch;

    await converse("hello", "practice-1", "conversation-prev", "scenario-1");
    expect(posted).toEqual({
      userText: "hello",
      activitySessionId: "practice-1",
      sessionId: "conversation-prev",
      scenarioId: "scenario-1",
    });
  });

  test("reflectionは対象の練習IDを送る", async () => {
    let posted: unknown;
    globalThis.fetch = mock(async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ goodPhrases: [], fixes: [], noteForTomorrow_ja: "" }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchReflection("practice-1");
    expect(posted).toEqual({ sessionId: "practice-1" });
  });
});
