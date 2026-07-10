import { afterEach, describe, expect, mock, test } from "bun:test";
import { onProgressUpdate, progressBlockAbort, progressBlockXp, progressLevelAction, type ProgressSummary } from "./progress";

const SUMMARY: ProgressSummary = {
  level: 3, xp: 10, xpIntoLevel: 10, xpToNext: 5, stage: 1, difficultyMaxed: false, proposal: null,
};

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stubFetchOk(body: unknown): void {
  globalThis.fetch = mock(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }),
  ) as unknown as typeof fetch;
}

describe("progress の summary 自動通知", () => {
  test("progressBlockXp は summary を購読者へ通知し、同じ値を返す", async () => {
    let posted: unknown;
    globalThis.fetch = mock(async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(SUMMARY), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const seen: ProgressSummary[] = [];
    const unsub = onProgressUpdate((s) => seen.push(s));
    const returned = await progressBlockXp({
      amount: 2, attemptId: 1, blockKind: "reflection", completionId: "completion-client-0001",
    });
    unsub();
    expect(returned).toEqual(SUMMARY);
    expect(seen).toEqual([SUMMARY]);
    expect(posted).toEqual({
      kind: "block", amount: 2, attemptId: 1, blockKind: "reflection", completionId: "completion-client-0001",
    });
  });

  test("progressBlockAbort はattemptとblock kindを送る", async () => {
    let posted: unknown;
    globalThis.fetch = mock(async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ status: "aborted" }), { status: 200 });
    }) as unknown as typeof fetch;
    await progressBlockAbort(7, "four-three-two");
    expect(posted).toEqual({ attemptId: 7, blockKind: "four-three-two" });
  });

  test("block-start失敗時はattemptIdを省略し、同じcompletionIdを送れる", async () => {
    let posted: Record<string, unknown> = {};
    globalThis.fetch = mock(async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(SUMMARY), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    await progressBlockXp({
      amount: 5, attemptId: null, blockKind: "reflection", completionId: "completion-client-null",
    });
    expect(posted.attemptId).toBeUndefined();
    expect(posted.completionId).toBe("completion-client-null");
  });

  test("progressLevelAction も同じラッパで通知する", async () => {
    let posted: unknown;
    globalThis.fetch = mock(async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return new Response(JSON.stringify(SUMMARY), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const seen: ProgressSummary[] = [];
    const unsub = onProgressUpdate((s) => seen.push(s));
    await progressLevelAction("accept", undefined, { kind: "down", toLevel: 15 });
    unsub();
    expect(seen).toEqual([SUMMARY]);
    expect(posted).toEqual({ action: "accept", kind: "down", toLevel: 15 });
  });
});
