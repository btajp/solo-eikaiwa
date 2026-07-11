import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeFakeLibraryStore, makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";

describe("library", () => {
  test("model-talk 成功時に libraryStore.saveModelTalk が両言語題名付きで呼ばれ、レスポンスは {text} のみ", async () => {
    const saved: Array<{ topicId: string; topicTitle: string; topicTitleJa: string; text: string }> = [];
    const { deps } = makeTestDeps({
      modelTalk: async (topicId: string) =>
        topicId === "known-topic" ? { text: "model talk", topicTitle: "Known Topic", topicTitleJa: "既知の題名" } : null,
      libraryStore: makeFakeLibraryStore({ saveModelTalk: (e) => saved.push(e) }),
    });
    const res = await makeFetchHandler(deps)(
      postJson("/api/coach/model-talk", { topicId: "known-topic" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "model talk" }); // topicTitle を漏らさない
    expect(saved).toEqual([{ topicId: "known-topic", topicTitle: "Known Topic", topicTitleJa: "既知の題名", text: "model talk" }]);
  });

  test("unknown topicId (404) では保存しない", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      libraryStore: makeFakeLibraryStore({ saveModelTalk: (e) => saved.push(e) }),
    });
    const res = await makeFetchHandler(deps)(
      postJson("/api/coach/model-talk", { topicId: "nope" }),
    );
    expect(res.status).toBe(404);
    expect(saved).toHaveLength(0);
  });

  test("GET /api/library/model-talks は現在の教材から両言語題名を返す", async () => {
    const entry = { id: 1, createdAt: "2026-07-06T00:00:00.000Z", topicId: "t1", topicTitle: "T", topicTitleJa: "", text: "talk" };
    const { deps } = makeTestDeps({
      libraryStore: makeFakeLibraryStore({ listModelTalks: () => [entry] }),
      libraryTopics: () => new Map([["t1", { title: "English title", titleJa: "日本語の題名" }]]),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/library/model-talks"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [{ ...entry, topicTitle: "English title", topicTitleJa: "日本語の題名" }],
    });
  });

  test("空のライブラリでは題名補完用の全教材読込をしない", async () => {
    let topicReads = 0;
    const { deps } = makeTestDeps({
      libraryStore: makeFakeLibraryStore({ listModelTalks: () => [] }),
      libraryTopics: () => {
        topicReads++;
        return new Map();
      },
    });

    const res = await makeFetchHandler(deps)(getReq("/api/library/model-talks"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [] });
    expect(topicReads).toBe(0);
  });

  test("saveModelTalk が例外を投げても POST /api/coach/model-talk は200で {text} を返す", async () => {
    const { deps } = makeTestDeps({
      libraryStore: makeFakeLibraryStore({
        saveModelTalk: () => {
          throw new Error("disk full");
        },
      }),
    });
    const res = await makeFetchHandler(deps)(
      postJson("/api/coach/model-talk", { topicId: "known-topic" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "model talk" });
  });
});
