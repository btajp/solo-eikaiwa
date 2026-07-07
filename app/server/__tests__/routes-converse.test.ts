import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { postJson } from "./helpers/http";

describe("routes: converse", () => {
  test("userTextが空なら400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      postJson("/api/converse", {}),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "userText is required" });
  });

  test("正常系: {replyText, sessionId} を返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      postJson("/api/converse", { userText: "Hi", sessionId: "s1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ replyText: "echo: Hi", sessionId: "s1" });
  });

  test("不正なJSONボディは400（500にならない）", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/converse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });
});

describe("routes: converse + scenarioId", () => {
  test("既知の scenarioId は systemPromptOverride 付きで converse に渡る", async () => {
    const seen: Array<{ systemPromptOverride?: string }> = [];
    const { deps } = makeTestDeps({
      converse: async (args) => {
        seen.push({ systemPromptOverride: args.systemPromptOverride });
        return { replyText: "ok", sessionId: "s1" };
      },
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/converse", { userText: "hi", scenarioId: "known-scenario" }));
    expect(res.status).toBe(200);
    expect(seen[0].systemPromptOverride).toBe("ROLEPLAY PROMPT");
  });

  test("未知の scenarioId は400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/converse", { userText: "hi", scenarioId: "nope" }));
    expect(res.status).toBe(400);
  });

  test("scenarioId なしは自由会話プロンプト（stage 別語彙制約）を override として渡す", async () => {
    const seen: Array<{ systemPromptOverride?: string }> = [];
    const { deps } = makeTestDeps({
      converse: async (args) => {
        seen.push({ systemPromptOverride: args.systemPromptOverride });
        return { replyText: "ok", sessionId: "s1" };
      },
    });
    const handler = makeFetchHandler(deps);
    await handler(postJson("/api/converse", { userText: "hi" }));
    // route-deps の conversationStage() は 2（低ステージ）→ 高頻度語彙制約が入る
    expect(seen[0].systemPromptOverride).toContain("word families");
  });
});
