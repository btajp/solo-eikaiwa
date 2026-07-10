import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { makeListeningStore } from "../listening-store";
import { makeFetchHandler } from "../routes";
import { FAKE_LISTENING_ITEM, makeFakeListeningStore, makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";

describe("listening API", () => {
  test("GET /api/listening は本文（paragraphs）を除いたメタ一覧 + weeklyCount を返す", async () => {
    const { deps } = makeTestDeps({
      listeningStore: makeFakeListeningStore({ countSince: () => 3 }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/listening"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<Record<string, unknown>>; weeklyCount: number };
    expect(body.weeklyCount).toBe(3);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe("morning-routine");
    expect(body.items[0]).not.toHaveProperty("paragraphs"); // 一覧は本文を含めない
  });

  test("GET /api/listening は countSince が投げても weeklyCount 0 で一覧を返す（bestEffort）", async () => {
    const { deps } = makeTestDeps({
      listeningStore: makeFakeListeningStore({ countSince: () => { throw new Error("db down"); } }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/listening"));
    expect(res.status).toBe(200);
    expect((await res.json() as { weeklyCount: number }).weeklyCount).toBe(0);
  });

  test("GET /api/listening/:id は既知素材の本文を返し、未知は404", async () => {
    const { deps } = makeTestDeps();
    const ok = await makeFetchHandler(deps)(getReq("/api/listening/morning-routine"));
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { item: { id: string; paragraphs: string[] } };
    expect(body.item.id).toBe("morning-routine");
    expect(body.item.paragraphs.length).toBeGreaterThan(0);
    const notFound = await makeFetchHandler(deps)(getReq("/api/listening/nope"));
    expect(notFound.status).toBe(404);
  });

  test("POST /api/listening/log は記録して weeklyCount を返す", async () => {
    const logged: Array<{ itemId: string; ymd: string; attemptId: string }> = [];
    const { deps } = makeTestDeps({
      listeningStore: makeFakeListeningStore({
        log: (itemId, ymd, attemptId) => {
          logged.push({ itemId, ymd, attemptId });
          return { status: "recorded", row: { id: 1, ts: "t", ymd, itemId } };
        },
        countSince: () => 5,
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/listening/log", {
      itemId: "morning-routine", attemptId: "listen-route-0001",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ weeklyCount: 5 });
    expect(logged).toHaveLength(1);
    expect(logged[0].itemId).toBe("morning-routine");
    expect(logged[0].ymd).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(logged[0].attemptId).toBe("listen-route-0001");
  });

  test("保存後の応答生成に失敗して同じattempt IDを再送してもログと週カウントは1回分", async () => {
    const db = openDb(":memory:");
    const realStore = makeListeningStore(db);
    let failAfterCommit = true;
    const { deps } = makeTestDeps({
      listeningStore: {
        log: realStore.log,
        countSince: (fromYmd) => {
          if (failAfterCommit) {
            failAfterCommit = false;
            throw new Error("response lost after commit");
          }
          return realStore.countSince(fromYmd);
        },
      },
    });
    const handler = makeFetchHandler(deps);
    const body = { itemId: "morning-routine", attemptId: "listen-response-lost" };

    const lostResponse = await handler(postJson("/api/listening/log", body));
    expect(lostResponse.status).toBe(500);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM listening_logs").get()?.n).toBe(1);
    const retry = await handler(postJson("/api/listening/log", body));

    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ weeklyCount: 1 });
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM listening_logs").get()?.n).toBe(1);
  });

  test("別素材に使われたattempt IDは409にする", async () => {
    const { deps } = makeTestDeps({
      listeningStore: makeFakeListeningStore({ log: () => ({ status: "conflict" }) }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/listening/log", {
      itemId: "morning-routine", attemptId: "listen-conflict-0001",
    }));
    expect(res.status).toBe(409);
  });

  test("POST /api/listening/log の400系: 空 itemId・未知 itemId・不正JSON", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      listeningStore: makeFakeListeningStore({
        log: (itemId, ymd) => {
          saved.push(itemId);
          return { status: "recorded", row: { id: 1, ts: "t", ymd, itemId } };
        },
      }),
    });
    const handler = makeFetchHandler(deps);
    expect((await handler(postJson("/api/listening/log", { itemId: "  ", attemptId: "listen-route-0002" }))).status).toBe(400);
    expect((await handler(postJson("/api/listening/log", { itemId: "nope", attemptId: "listen-route-0003" }))).status).toBe(400);
    expect((await handler(postJson("/api/listening/log", { itemId: "morning-routine" }))).status).toBe(400);
    expect((await handler(postJson("/api/listening/log", {
      itemId: "morning-routine", attemptId: "short",
    }))).status).toBe(400);
    const badJson = await handler(new Request("http://localhost/api/listening/log", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{",
    }));
    expect(badJson.status).toBe(400);
    expect(saved).toHaveLength(0); // 400 系では記録しない
  });
});
