import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { makeListeningStore } from "../listening-store";

function memStore() {
  return makeListeningStore(openDb(":memory:"));
}

function memDbStore() {
  const db = openDb(":memory:");
  return { db, store: makeListeningStore(db) };
}

describe("listening-store", () => {
  test("log して countSince で数えられる（スキーマ自動作成・採番）", () => {
    const store = memStore();
    const result = store.log("item-a", "2026-07-07", "listen-attempt-0001");
    expect(result.status).toBe("recorded");
    if (result.status === "conflict") throw new Error("unexpected conflict");
    const { row } = result;
    expect(typeof row.id).toBe("number");
    expect(row.itemId).toBe("item-a");
    expect(row.ymd).toBe("2026-07-07");
    expect(row.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(store.countSince("2026-07-01")).toBe(1);
  });

  test("countSince は fromYmd を含み、それ以前を除外する", () => {
    const store = memStore();
    store.log("a", "2026-06-30", "listen-attempt-0002"); // 窓の外
    store.log("b", "2026-07-01", "listen-attempt-0003"); // 境界（含む）
    store.log("c", "2026-07-05", "listen-attempt-0004");
    expect(store.countSince("2026-07-01")).toBe(2);
  });

  test("同一素材の複数聴取もすべて数える（回数カウントであり distinct ではない）", () => {
    const store = memStore();
    store.log("a", "2026-07-07", "listen-attempt-0005");
    store.log("a", "2026-07-07", "listen-attempt-0006");
    expect(store.countSince("2026-07-01")).toBe(2);
  });

  test("同じattempt IDの再送は初回行を返し、聴取回数を二重加算しない", () => {
    const store = memStore();
    const first = store.log("a", "2026-07-07", "listen-attempt-0007");
    const retry = store.log("a", "2026-07-08", "listen-attempt-0007");

    expect(first.status).toBe("recorded");
    expect(retry.status).toBe("replayed");
    if (first.status === "conflict" || retry.status === "conflict") throw new Error("unexpected conflict");
    expect(retry.row).toEqual(first.row);
    expect(store.countSince("2026-07-01")).toBe(1);
  });

  test("同じattempt IDを別素材へ使い回すとconflictになり、初回ログだけを残す", () => {
    const store = memStore();
    expect(store.log("a", "2026-07-07", "listen-attempt-0008").status).toBe("recorded");
    expect(store.log("b", "2026-07-07", "listen-attempt-0008")).toEqual({ status: "conflict" });
    expect(store.countSince("2026-07-01")).toBe(1);
  });

  test("attempt台帳のcommit前失敗はログもロールバックし、同じIDで再試行できる", () => {
    const { db, store } = memDbStore();
    db.run(`CREATE TRIGGER fail_listening_attempt
      BEFORE INSERT ON listening_log_attempts BEGIN SELECT RAISE(ABORT, 'fault'); END`);

    expect(() => store.log("a", "2026-07-07", "listen-attempt-fault")).toThrow("fault");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM listening_logs").get()?.n).toBe(0);

    db.run("DROP TRIGGER fail_listening_attempt");
    expect(store.log("a", "2026-07-07", "listen-attempt-fault").status).toBe("recorded");
    expect(store.countSince("2026-07-01")).toBe(1);
  });
});
