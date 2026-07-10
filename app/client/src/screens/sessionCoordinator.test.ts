import { describe, expect, test } from "bun:test";
import {
  completionRequest,
  makeSessionCoordinator,
  retainFailedCompletion,
  type AttemptPromise,
} from "./sessionCoordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe("sessionCoordinator", () => {
  test("古い世代のmenu responseは無効になりblockを開始できない", () => {
    const c = makeSessionCoordinator();
    const oldGeneration = c.beginGeneration();
    c.invalidateGeneration();
    let startCalls = 0;
    expect(c.isCurrent(oldGeneration)).toBe(false);
    expect(c.open({ id: "old", kind: "reflection", minutes: 5 }, () => {
      startCalls++;
      return Promise.resolve(1);
    }, oldGeneration)).toBe(false);
    expect(startCalls).toBe(0);
    expect(c.takeOpen()).toBeNull();
  });

  test("attempt応答が逆順でも各blockのhandleが混線せず、同じblockは1回だけtakeできる", async () => {
    const c = makeSessionCoordinator();
    const generation = c.beginGeneration();
    const first = deferred<number | null>();
    const second = deferred<number | null>();
    expect(c.open({ id: "b1", kind: "warmup-reading", minutes: 5 }, () => first.promise as AttemptPromise, generation)).toBe(true);
    const firstHandle = c.take("b1")!;
    expect(c.take("b1")).toBeNull();
    expect(c.open({ id: "b2", kind: "reflection", minutes: 5 }, () => second.promise as AttemptPromise, generation)).toBe(true);
    const secondHandle = c.take("b2")!;

    second.resolve(22);
    first.resolve(11);
    expect(await secondHandle.attemptId).toBe(22);
    expect(await firstHandle.attemptId).toBe(11);
    expect(firstHandle.completionId).not.toBe(secondHandle.completionId);
  });

  test("open中の同一blockを重複開始しない", () => {
    const c = makeSessionCoordinator(() => "completion-fixed");
    const generation = c.beginGeneration();
    const attempt = Promise.resolve(1);
    expect(c.open({ id: "b1", kind: "reflection", minutes: 5 }, () => attempt, generation)).toBe(true);
    expect(c.open({ id: "b1", kind: "reflection", minutes: 5 }, () => attempt, generation)).toBe(false);
  });

  test("start失敗時もattemptIdなしの同じcompletion requestを再利用できる", () => {
    const c = makeSessionCoordinator(() => "completion-no-attempt");
    const generation = c.beginGeneration();
    c.open({ id: "b1", kind: "reflection", minutes: 5 }, () => Promise.resolve(null), generation);
    const request = completionRequest(c.take("b1")!, null);
    expect(request).toEqual({
      completionId: "completion-no-attempt", attemptId: null, blockKind: "reflection", amount: 5,
    });
    expect(retainFailedCompletion([], request)).toEqual([request]);
    expect(retainFailedCompletion([request], request)).toEqual([request]);
  });
});
