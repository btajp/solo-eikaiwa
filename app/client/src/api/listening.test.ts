import { afterEach, describe, expect, mock, test } from "bun:test";
import { logListening } from "./listening";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("logListening", () => {
  test("itemIdとclient生成attempt IDを同じPOSTで送る", async () => {
    let posted: unknown;
    globalThis.fetch = mock(async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ weeklyCount: 4 }), { status: 200 });
    }) as unknown as typeof fetch;

    expect(await logListening("item-a", "listen-client-0001")).toEqual({ weeklyCount: 4 });
    expect(posted).toEqual({ itemId: "item-a", attemptId: "listen-client-0001" });
  });
});
