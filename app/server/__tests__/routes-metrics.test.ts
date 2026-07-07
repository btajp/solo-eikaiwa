import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { readEvents } from "../session-log";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq } from "./helpers/http";

describe("routes: metrics", () => {
  test("GET /api/metrics/summary はデフォルト14日で summary を返す", async () => {
    const res = await makeFetchHandler(makeTestDeps().deps)(getReq("/api/metrics/summary"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toHaveLength(14);
    expect(body.level.current).toBe(13);
  });

  test("GET /api/metrics/summary の days は 1..90 の整数のみ", async () => {
    const handler = makeFetchHandler(makeTestDeps().deps);
    expect((await handler(getReq("/api/metrics/summary?days=7"))).status).toBe(200);
    for (const bad of ["0", "91", "abc", "7.5"]) {
      const res = await handler(getReq(`/api/metrics/summary?days=${bad}`));
      expect(res.status).toBe(400);
    }
  });

  test("POST /api/stt は text と metrics を返し stt_result を記録する", async () => {
    const { deps, logFile } = makeTestDeps({
      transcribe: async () => ({
        text: "I usually skip breakfast and grab coffee",
        segments: [
          { fromMs: 0, toMs: 2000, text: " I usually skip breakfast" },
          { fromMs: 2500, toMs: 4000, text: " and grab coffee" },
        ],
      }),
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/stt", {
      method: "POST", body: new Uint8Array([1, 2, 3]),
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("I usually skip breakfast and grab coffee");
    expect(body.metrics.articulationRateWpm).toBe(120);
    const events = readEvents(logFile);
    const stt = events.filter((e) => e.type === "stt_result");
    expect(stt).toHaveLength(1);
    expect((stt[0].meta as { metrics: { words: number } }).metrics.words).toBe(7);
  });
});
