import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { FAKE_SENTENCE, makeFakeChunkStore, makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson, putJson } from "./helpers/http";

describe("chunks: 収集フックと API", () => {
  test("AEフィードバック成功時に quote/better 非空の item だけが collect に渡り、件数がレスポンスに載る", async () => {
    const got: unknown[] = [];
    const saved = {
      id: 7, created: "2026-07-10", source: "ae" as const,
      promptText: "I go office", en: "I went to the office", note: "過去形にします",
      srs: { stage: 0, due: "2026-07-11", reviews: 0 },
    };
    const { deps } = makeTestDeps({
      aeFeedback: async () => ({
        items: [
          { quote: "I go office", issue: "tense", better: "I went to the office", why_ja: "過去形にします" },
          { quote: "", issue: "feedback", better: "", why_ja: "fallback item" },
        ],
        praise: "Nice!",
      }),
      chunkStore: makeFakeChunkStore({
        collect: (c) => { got.push(...c); return [saved]; },
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/feedback/ae", { transcript: "I go office", topicTitle: "t" }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      collectedChunks: number;
      collectedChunkItems: Array<typeof saved>;
      collectedChunkStatus: string;
    };
    expect(body.collectedChunks).toBe(1);
    expect(body.collectedChunkItems).toEqual([saved]);
    expect(body.collectedChunkStatus).toBe("saved");
    expect(got).toEqual([
      { source: "ae", promptText: "I go office", en: "I went to the office", note: "過去形にします" },
    ]);
  });

  test("collect が throw しても AE フィードバックは 200で返り、保存失敗を区別できる", async () => {
    const { deps } = makeTestDeps({
      chunkStore: makeFakeChunkStore({
        collect: () => { throw new Error("db boom"); },
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/feedback/ae", { transcript: "hello" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      collectedChunks: 0, collectedChunkItems: [], collectedChunkStatus: "failed",
    });
  });

  test("振り返りの fixes からも収集され collectedChunks が載る", async () => {
    const got: unknown[] = [];
    const { deps } = makeTestDeps({
      reflection: async () => ({
        goodPhrases: [],
        fixes: [{ original: "he go", better: "he goes" }, { original: "", better: "x" }],
        noteForTomorrow_ja: "メモ",
      }),
      chunkStore: makeFakeChunkStore({
        collect: (c) => { got.push(...c); return []; },
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/reflection", { sessionId: "practice-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      collectedChunks: 0, collectedChunkItems: [], collectedChunkStatus: "none",
    });
    expect(got).toEqual([{ source: "reflection", promptText: "he go", en: "he goes", note: "" }]);
  });

  test("queue: 期限到来チャンクが復習例文より先頭に kind 付きで混ざる", async () => {
    const { deps } = makeTestDeps({
      chunkStore: makeFakeChunkStore({
        dueChunks: () => [{
          id: 3, created: "2026-07-05", source: "ae" as const,
          promptText: "I go office", en: "I went to the office", note: "過去形",
          srs: { stage: 0, due: "2026-07-06", reviews: 0 },
        }],
      }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/sentences/queue?new=1"));
    const body = await res.json() as { queue: unknown[] };
    expect(body.queue[0]).toEqual({
      kind: "chunk", id: 3, promptText: "I go office", en: "I went to the office", note: "過去形",
      srs: { stage: 0, due: "2026-07-06", reviews: 0 },
    });
    expect(body.queue[1]).toEqual({ kind: "sentence", ...FAKE_SENTENCE });
  });

  test("queue: dueChunks が throw しても例文キューだけで 200", async () => {
    const { deps } = makeTestDeps({
      chunkStore: makeFakeChunkStore({
        dueChunks: () => { throw new Error("boom"); },
      }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/sentences/queue?new=1"));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { queue: unknown[] }).queue).toEqual([{ kind: "sentence", ...FAKE_SENTENCE }]);
  });

  test("GET /api/chunks は一覧を返す", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(getReq("/api/chunks"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chunks: [] });
  });

  test("GET /api/chunks?visibility=hidden は非表示一覧を返す", async () => {
    const hidden = [{
      id: 3, created: "2026-07-05", source: "ae" as const,
      promptText: "I go office", en: "I went to the office", note: "過去形",
      srs: { stage: 0, due: "2026-07-06", reviews: 0 },
    }];
    const { deps } = makeTestDeps({ chunkStore: makeFakeChunkStore({ listHidden: () => hidden }) });
    const h = makeFetchHandler(deps);
    const res = await h(getReq("/api/chunks?visibility=hidden"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ chunks: hidden });
    expect((await h(getReq("/api/chunks?visibility=all"))).status).toBe(400);
  });

  test("POST /api/chunks/grade: 正常時は遷移を返し srs-grade XP が付与される", async () => {
    const xp: Array<{ kind: string; amount: number }> = [];
    const { deps } = makeTestDeps();
    const base = deps.progressStore;
    deps.progressStore = {
      ...base,
      addXp: (kind, amount, meta) => { xp.push({ kind: kind as string, amount }); return base.addXp(kind, amount, meta); },
    };
    const res = await makeFetchHandler(deps)(postJson("/api/chunks/grade", {
      id: 1, grade: "good", answerId: "answer-route-chunk-001",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 1, stage: 1, due: "2026-07-09" });
    expect(xp).toEqual([{ kind: "srs-grade", amount: 2 }]);
  });

  test("POST /api/chunks/grade: 未知idは400・不正gradeは400", async () => {
    const { deps } = makeTestDeps();
    const h = makeFetchHandler(deps);
    const r1 = await h(postJson("/api/chunks/grade", {
      id: 999, grade: "good", answerId: "answer-route-chunk-002",
    }));
    expect(r1.status).toBe(400);
    const r2 = await h(postJson("/api/chunks/grade", { id: 1, grade: "great" }));
    expect(r2.status).toBe(400);
  });

  test("PUT /api/chunks/:id/visibility: 非表示・復元を切り替える", async () => {
    const calls: Array<{ id: number; hidden: boolean }> = [];
    const { deps } = makeTestDeps({
      chunkStore: makeFakeChunkStore({
        setHidden: (id, hidden) => { calls.push({ id, hidden }); return id === 1; },
      }),
    });
    const h = makeFetchHandler(deps);
    expect((await h(putJson("/api/chunks/1/visibility", { hidden: true }))).status).toBe(200);
    expect((await h(putJson("/api/chunks/1/visibility", { hidden: false }))).status).toBe(200);
    expect(calls).toEqual([{ id: 1, hidden: true }, { id: 1, hidden: false }]);
    expect((await h(putJson("/api/chunks/999/visibility", { hidden: true }))).status).toBe(404);
    expect((await h(putJson("/api/chunks/abc/visibility", { hidden: true }))).status).toBe(400);
    expect((await h(putJson("/api/chunks/1/visibility", { hidden: "yes" }))).status).toBe(400);
  });

  test("DELETE /api/chunks/:id は物理削除せず 404", async () => {
    let changed = false;
    const { deps } = makeTestDeps({
      chunkStore: makeFakeChunkStore({ setHidden: () => { changed = true; return true; } }),
    });
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/chunks/1", { method: "DELETE" }));
    expect(res.status).toBe(404);
    expect(changed).toBe(false);
  });
});
