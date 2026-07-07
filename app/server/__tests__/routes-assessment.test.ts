import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeFakeAssessmentStore, makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";

describe("routes: assessment", () => {
  const post = (body: unknown) =>
    postJson("/api/assessment/generate", body);

  test("POST /api/assessment/generate は生成して保存し cached:false", async () => {
    const saved: Array<{ ymd: string; text: string }> = [];
    const { deps } = makeTestDeps({
      assessmentStore: makeFakeAssessmentStore({
        save: (r) => {
          saved.push({ ymd: r.ymd, text: r.text });
          return { id: 9, ts: "t", ymd: r.ymd, text: r.text };
        },
      }),
    });
    const res = await makeFetchHandler(deps)(post({}));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cached).toBe(false);
    expect(body.report.text).toBe("今月の振り返りテキスト");
    expect(saved).toHaveLength(1);
  });

  test("同一月に既存があれば cached:true で再生成しない（force で再生成）", async () => {
    let generated = 0;
    const existing = { id: 1, ts: "t", ymd: "2026-07-01", text: "既存" };
    const { deps } = makeTestDeps({
      assessmentStore: makeFakeAssessmentStore({
        save: (r) => ({ id: 2, ts: "t2", ymd: r.ymd, text: r.text }),
        latest: () => existing, findByMonth: () => existing,
      }),
      generateMonthlyReport: async () => { generated++; return "新レポート"; },
    });
    const handler = makeFetchHandler(deps);
    const r1 = await handler(post({}));
    expect((await r1.json())).toEqual({ report: existing, cached: true });
    expect(generated).toBe(0);
    const r2 = await handler(post({ force: true }));
    const b2 = await r2.json();
    expect(b2.cached).toBe(false);
    expect(b2.report.text).toBe("新レポート");
    expect(generated).toBe(1);
  });

  test("生成が空なら 502 で保存しない", async () => {
    let saveCalls = 0;
    const { deps } = makeTestDeps({
      generateMonthlyReport: async () => null,
      assessmentStore: makeFakeAssessmentStore({
        save: () => { saveCalls++; return { id: 1, ts: "t", ymd: "y", text: "x" }; },
      }),
    });
    const res = await makeFetchHandler(deps)(post({}));
    expect(res.status).toBe(502);
    expect(saveCalls).toBe(0);
  });

  test("GET latest / list の形", async () => {
    const row = { id: 1, ts: "t", ymd: "2026-07-06", text: "本文" };
    const { deps } = makeTestDeps({
      assessmentStore: makeFakeAssessmentStore({
        save: () => row, latest: () => row,
        list: () => [{ ...row, preview: "本文" }],
      }),
    });
    const handler = makeFetchHandler(deps);
    expect(await (await handler(getReq("/api/assessment/latest"))).json()).toEqual({ report: row });
    expect(await (await handler(getReq("/api/assessment/list"))).json()).toEqual({ reports: [{ ...row, preview: "本文" }] });
  });
});
