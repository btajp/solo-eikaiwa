import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { FAKE_SENTENCE, makeFakeSentenceStore, makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";

describe("sentences ルート", () => {
  test("GET /api/sentences は {sentences} を返す", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(getReq("/api/sentences"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sentences: [FAKE_SENTENCE] });
  });

  test("GET /api/sentences/queue は new を検証して {queue} を返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(getReq("/api/sentences/queue?new=5"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ queue: [{ kind: "sentence", ...FAKE_SENTENCE }] });
    const bad = await handler(getReq("/api/sentences/queue?new=abc"));
    expect(bad.status).toBe(400);
    const neg = await handler(getReq("/api/sentences/queue?new=-1"));
    expect(neg.status).toBe(400);
  });

  test("POST /api/sentences/grade は成功で {no,stage,due}", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(postJson("/api/sentences/grade", {
      no: 1, grade: "good", answerId: "answer-route-sentence-1",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ no: 1, stage: 1, due: "2026-07-09" });
  });

  test("POST /api/sentences/grade は不正入力に 400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const badGrade = await handler(postJson("/api/sentences/grade", { no: 1, grade: "perfect" }));
    expect(badGrade.status).toBe(400);
    const badNo = await handler(postJson("/api/sentences/grade", { no: 1.5, grade: "good" }));
    expect(badNo.status).toBe(400);
    const unknownNo = await handler(postJson("/api/sentences/grade", {
      no: 999, grade: "good", answerId: "answer-route-sentence-2",
    }));
    expect(unknownNo.status).toBe(400);
    const missingId = await handler(postJson("/api/sentences/grade", { no: 1, grade: "good" }));
    expect(missingId.status).toBe(400);
    expect((await unknownNo.json()).error).toContain("unknown");
  });

  test("POST /api/sentences/explain は生成して返しキャッシュに保存する", async () => {
    const saved: Array<{ no: number; text: string }> = [];
    let generateCalls = 0;
    const { deps } = makeTestDeps({
      sentenceStore: makeFakeSentenceStore({
        saveExplanation: (no, text) => { saved.push({ no, text }); },
      }),
      explainSentence: async () => { generateCalls++; return { text: "詳しい解説テキスト" }; },
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/sentences/explain", { no: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ no: 1, text: "詳しい解説テキスト" });
    expect(generateCalls).toBe(1);
    expect(saved).toEqual([{ no: 1, text: "詳しい解説テキスト" }]);
  });

  test("POST /api/sentences/explain はキャッシュ命中時に生成しない", async () => {
    let generateCalls = 0;
    const { deps } = makeTestDeps({
      sentenceStore: makeFakeSentenceStore({
        getExplanation: (no) => (no === 1 ? "キャッシュ済み解説" : null),
        saveExplanation: () => { throw new Error("must not save on cache hit"); },
      }),
      explainSentence: async () => { generateCalls++; return { text: "x" }; },
    });
    const res = await makeFetchHandler(deps)(postJson("/api/sentences/explain", { no: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ no: 1, text: "キャッシュ済み解説" });
    expect(generateCalls).toBe(0);
  });

  test("POST /api/sentences/explain は不正・未知の no に 400", async () => {
    const handler = makeFetchHandler(makeTestDeps().deps);
    const badNo = await handler(postJson("/api/sentences/explain", { no: "1" }));
    expect(badNo.status).toBe(400);
    const unknownNo = await handler(postJson("/api/sentences/explain", { no: 999 }));
    expect(unknownNo.status).toBe(400);
    expect((await unknownNo.json()).error).toContain("unknown");
  });
});
