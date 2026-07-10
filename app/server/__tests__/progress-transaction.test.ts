import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { makeProgressStore } from "../progress-store";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { postJson } from "./helpers/http";

describe("block completion transaction", () => {
  test("同じcompletionIdの並列再送でもattempt完了とXPを1回だけcommitする", async () => {
    const db = openDb(":memory:");
    const progressStore = makeProgressStore(db);
    const { attemptId } = progressStore.blockStart("reflection", "2026-07-10");
    const h = makeFetchHandler(makeTestDeps({ progressStore }).deps);
    const body = {
      kind: "block",
      amount: 5,
      attemptId,
      blockKind: "reflection",
      completionId: "completion-parallel-001",
    };

    const responses = await Promise.all(Array.from({ length: 4 }, () => h(postJson("/api/progress/xp", body))));
    expect(responses.map((res) => res.status)).toEqual([200, 200, 200, 200]);
    expect(progressStore.getSummary("2026-07-10").xp).toBe(5);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM xp_events WHERE kind = 'block'").get()!.n).toBe(1);
    expect(db.query<{ completed: number }, [number]>(
      "SELECT completed FROM block_attempts WHERE id = ?",
    ).get(attemptId)!.completed).toBe(1);
  });

  test("block-start失敗相当のattemptIdなしでも同じcompletionIdを安全に再試行できる", async () => {
    const db = openDb(":memory:");
    const progressStore = makeProgressStore(db);
    const h = makeFetchHandler(makeTestDeps({ progressStore }).deps);
    const body = {
      kind: "block",
      amount: 5,
      blockKind: "reflection",
      completionId: "completion-without-attempt",
    };
    expect((await h(postJson("/api/progress/xp", body))).status).toBe(200);
    expect((await h(postJson("/api/progress/xp", body))).status).toBe(200);
    expect(progressStore.getSummary("2026-07-10").xp).toBe(5);
  });
});
