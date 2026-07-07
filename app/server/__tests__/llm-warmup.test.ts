import { describe, expect, test } from "bun:test";
import { makeWarmup } from "../llm-warmup";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq } from "./helpers/http";

type Call = { url: string; body: any; headers: Record<string, string> };

function fakeWarmFetch(calls: Call[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    calls.push({ url, body: JSON.parse(String(init.body)), headers });
    return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("makeWarmup", () => {
  test("target=null（非 openai-compat）なら何もしない", async () => {
    const calls: Call[] = [];
    const w = makeWarmup({ fetchFn: fakeWarmFetch(calls) });
    w.setTarget(null);
    w.maybeWarm(0);
    await flush();
    expect(calls.length).toBe(0);
  });

  test("スロットル: 240秒窓内は1回だけ・窓を越えると再度温める（クロック注入）", async () => {
    const calls: Call[] = [];
    const w = makeWarmup({ fetchFn: fakeWarmFetch(calls), windowMs: 240_000 });
    w.setTarget({ baseUrl: "http://localhost:11434/v1", model: "m" });

    w.maybeWarm(0); await flush();
    expect(calls.length).toBe(1);

    w.maybeWarm(100_000); await flush();
    expect(calls.length).toBe(1); // 窓内 → no-op

    w.maybeWarm(239_999); await flush();
    expect(calls.length).toBe(1); // 窓ぎりぎり内 → no-op

    w.maybeWarm(240_000); await flush();
    expect(calls.length).toBe(2); // 窓に到達 → 再warm
  });
});

describe("makeFetchHandler warm フック", () => {
  test("受信時に warmLlm を fire-and-forget で1回呼ぶ", async () => {
    let called = 0;
    const { deps } = makeTestDeps({ warmLlm: () => { called++; } });
    await makeFetchHandler(deps)(getReq("/api/health"));
    expect(called).toBe(1);
  });

  test("warmLlm が throw してもリクエスト処理は成功する（影響ゼロ）", async () => {
    const { deps } = makeTestDeps({ warmLlm: () => { throw new Error("boom warm"); } });
    const res = await makeFetchHandler(deps)(getReq("/api/health"));
    expect(res.status).toBe(200);
  });
});
