import { afterEach, describe, expect, mock, test } from "bun:test";
import { fetchChunks, setChunkVisibility } from "./sentences";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("chunk visibility API", () => {
  test("通常一覧と非表示一覧を別のURLから取得する", async () => {
    const urls: string[] = [];
    globalThis.fetch = mock(async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ chunks: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchChunks();
    await fetchChunks("hidden");
    expect(urls).toEqual(["/api/chunks", "/api/chunks?visibility=hidden"]);
  });

  test("表示状態の変更はPUTでbooleanを送る", async () => {
    let request: { url: string; method?: string; body?: unknown } | undefined;
    globalThis.fetch = mock(async (url, init) => {
      request = { url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({ ok: true, hidden: true }), { status: 200 });
    }) as unknown as typeof fetch;

    await setChunkVisibility(7, true);
    expect(request).toEqual({ url: "/api/chunks/7/visibility", method: "PUT", body: { hidden: true } });
  });
});
