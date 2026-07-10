import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeFakeFeedbackStore, makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";
import type { FeedbackInput } from "../feedback-store";

describe("feedback API", () => {
  test("POST /api/feedback は context を保存して {ok:true} を返す", async () => {
    const saved: FeedbackInput[] = [];
    const { deps } = makeTestDeps({
      feedbackStore: makeFakeFeedbackStore({
        save: (input) => { saved.push(input); return { id: 1, ts: "t", ...input }; },
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/feedback", {
      blockKind: "session", refId: "daily-60", level: 13, stage: 2, rating: "hard", note: "きつめ",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ blockKind: "session", refId: "daily-60", level: 13, stage: 2, rating: "hard", note: "きつめ" });
    expect(saved[0].ymd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("POST は refId/level/stage/note 省略時に null/'' で保存する", async () => {
    const saved: FeedbackInput[] = [];
    const { deps } = makeTestDeps({
      feedbackStore: makeFakeFeedbackStore({ save: (input) => { saved.push(input); return { id: 1, ts: "t", ...input }; } }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/feedback", { blockKind: "free-talk", rating: "easy" }));
    expect(res.status).toBe(200);
    expect(saved[0]).toMatchObject({ refId: null, level: null, stage: null, note: "" });
  });

  test("POST の400系: 空 blockKind・不正 rating・長すぎ note・非整数 level・不正JSON", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      feedbackStore: makeFakeFeedbackStore({ save: (input) => { saved.push(input); return { id: 1, ts: "t", ...input }; } }),
    });
    const handler = makeFetchHandler(deps);
    expect((await handler(postJson("/api/feedback", { blockKind: "  ", rating: "hard" }))).status).toBe(400);
    expect((await handler(postJson("/api/feedback", { blockKind: "session", rating: "nope" }))).status).toBe(400);
    expect((await handler(postJson("/api/feedback", { blockKind: "session", rating: "hard", note: "x".repeat(301) }))).status).toBe(400);
    expect((await handler(postJson("/api/feedback", { blockKind: "session", rating: "hard", level: 1.5 }))).status).toBe(400);
    const badJson = await handler(new Request("http://localhost/api/feedback", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }));
    expect(badJson.status).toBe(400);
    expect(saved).toHaveLength(0); // 400 系では記録しない
  });

  test("GET /api/feedback は store.list の結果を items で返す（日付降順）", async () => {
    const rows = [
      { id: 2, ts: "t2", ymd: "2026-07-07", blockKind: "session", refId: "daily-60", level: 13, stage: 2, rating: "hard" as const, note: "b" },
      { id: 1, ts: "t1", ymd: "2026-07-06", blockKind: "free-talk", refId: null, level: null, stage: null, rating: "easy" as const, note: "" },
    ];
    const { deps } = makeTestDeps({ feedbackStore: makeFakeFeedbackStore({ list: () => rows }) });
    const res = await makeFetchHandler(deps)(getReq("/api/feedback"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: rows });
  });
});
