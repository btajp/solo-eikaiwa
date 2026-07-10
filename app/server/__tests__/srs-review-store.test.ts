import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureSrsReviewSchema, makeSrsReviewStore } from "../srs-review-store";

const INPUT = {
  answerId: "answer-00000001",
  targetKind: "sentence" as const,
  targetId: 1,
  grade: "good" as const,
};

describe("srs-review-store", () => {
  test("同じanswerIdの再送は初回結果を返し、mutationを1回だけ実行する", () => {
    const db = new Database(":memory:");
    ensureSrsReviewSchema(db);
    const store = makeSrsReviewStore(db);
    let calls = 0;
    const mutate = () => {
      calls++;
      return { stage: 1, due: "2026-07-11" };
    };

    expect(store.apply(INPUT, mutate)).toEqual({ status: "applied", stage: 1, due: "2026-07-11" });
    expect(store.apply(INPUT, mutate)).toEqual({ status: "duplicate", stage: 1, due: "2026-07-11" });
    expect(calls).toBe(1);
  });

  test("同じanswerIdを別の対象・評価へ使い回した場合はconflictにする", () => {
    const db = new Database(":memory:");
    ensureSrsReviewSchema(db);
    const store = makeSrsReviewStore(db);
    store.apply(INPUT, () => ({ stage: 1, due: "2026-07-11" }));

    expect(store.apply({ ...INPUT, targetId: 2 }, () => ({ stage: 2, due: "2026-07-12" }))).toEqual({ status: "conflict" });
    expect(store.apply({ ...INPUT, grade: "bad" }, () => ({ stage: 0, due: "2026-07-11" }))).toEqual({ status: "conflict" });
  });

  test("mutation失敗・対象不在ではledgerを残さず再試行できる", () => {
    const db = new Database(":memory:");
    ensureSrsReviewSchema(db);
    const store = makeSrsReviewStore(db);

    expect(() => store.apply(INPUT, () => { throw new Error("xp failed"); })).toThrow("xp failed");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM srs_review_events").get()!.n).toBe(0);
    expect(store.apply(INPUT, () => null)).toEqual({ status: "missing" });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM srs_review_events").get()!.n).toBe(0);
    expect(store.apply(INPUT, () => ({ stage: 1, due: "2026-07-11" })).status).toBe("applied");
  });
});
