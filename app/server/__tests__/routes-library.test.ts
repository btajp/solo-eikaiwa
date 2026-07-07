import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeFakeLibraryStore, makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";

describe("library", () => {
  test("model-talk 成功時に libraryStore.saveModelTalk が topicTitle 付きで呼ばれ、レスポンスは {text} のみ", async () => {
    const saved: Array<{ topicId: string; topicTitle: string; text: string }> = [];
    const { deps } = makeTestDeps({
      modelTalk: async (topicId: string) =>
        topicId === "known-topic" ? { text: "model talk", topicTitle: "Known Topic" } : null,
      libraryStore: makeFakeLibraryStore({ saveModelTalk: (e) => saved.push(e) }),
    });
    const res = await makeFetchHandler(deps)(
      postJson("/api/coach/model-talk", { topicId: "known-topic" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "model talk" }); // topicTitle を漏らさない
    expect(saved).toEqual([{ topicId: "known-topic", topicTitle: "Known Topic", text: "model talk" }]);
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

  test("GET /api/library/model-talks が {entries} を返す", async () => {
    const entry = { id: 1, createdAt: "2026-07-06T00:00:00.000Z", topicId: "t1", topicTitle: "T", text: "talk" };
    const { deps } = makeTestDeps({
      libraryStore: makeFakeLibraryStore({ listModelTalks: () => [entry] }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/library/model-talks"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [entry] });
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
