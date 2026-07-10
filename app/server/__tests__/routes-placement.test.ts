import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { FAKE_SUMMARY, makeFakePlacementStore, makeFakeProgressStore, makeTestDeps } from "./helpers/route-deps";
import { getReq } from "./helpers/http";

describe("placement API", () => {
  const VALID_TASKS = [
    { taskId: "self-intro", transcript: "I am an engineer.", durationSec: 40, wordCount: 4 },
    { taskId: "describe-situation", transcript: "My laptop restarted before the meeting.", durationSec: 60, wordCount: 6 },
    { taskId: "give-opinion", transcript: "I agree because commuting takes time.", durationSec: 35, wordCount: 6 },
  ];

  test("GET /api/placement/tasks は3タスク定義を返す", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(getReq("/api/placement/tasks"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { tasks: Array<{ id: string; durationSec: number; instructionJa: string; promptText: string }> };
    expect(body.tasks).toHaveLength(3);
    expect(body.tasks.map((t) => t.id)).toEqual(["self-intro", "describe-situation", "give-opinion"]);
  });

  test("POST submit: 評価結果を保存して返し、placement XP(10) を内部付与する", async () => {
    const xpCalls: Array<{ kind: string; amount: number }> = [];
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      progressStore: makeFakeProgressStore({
        addXp: (kind, amount) => { xpCalls.push({ kind, amount }); return FAKE_SUMMARY; },
      }),
      placementStore: makeFakePlacementStore({
        save: (r) => { saved.push(r); return { id: 1, ts: "t", stage: 2, startLevel: 13, rationale: "r" }; },
      }),
    });
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/placement/submit", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks: VALID_TASKS }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stage: 2, startLevel: 13, rationale: "簡単な文は安定しています。" });
    expect(saved).toHaveLength(1);
    expect(xpCalls).toEqual([{ kind: "placement", amount: 10 }]);
  });

  test("POST submit の400系: 件数不足・未知taskId・重複taskId・空transcript・不正duration/wordCount", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const post = (tasks: unknown) =>
      handler(new Request("http://localhost/api/placement/submit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks }) }));
    expect((await post(VALID_TASKS.slice(0, 2))).status).toBe(400);
    expect((await post([{ ...VALID_TASKS[0], taskId: "nope" }, VALID_TASKS[1], VALID_TASKS[2]])).status).toBe(400);
    expect((await post([VALID_TASKS[0], VALID_TASKS[0], VALID_TASKS[2]])).status).toBe(400);
    expect((await post([{ ...VALID_TASKS[0], transcript: "  " }, VALID_TASKS[1], VALID_TASKS[2]])).status).toBe(400);
    expect((await post([{ ...VALID_TASKS[0], durationSec: 0 }, VALID_TASKS[1], VALID_TASKS[2]])).status).toBe(400);
    expect((await post([{ ...VALID_TASKS[0], wordCount: -1 }, VALID_TASKS[1], VALID_TASKS[2]])).status).toBe(400);
  });

  test("POST submit: 評価が null なら 502 で保存しない", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      evaluatePlacement: async () => null,
      placementStore: makeFakePlacementStore({
        save: (r) => { saved.push(r); return { id: 1, ts: "t", stage: 2, startLevel: 13, rationale: "r" }; },
      }),
    });
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/placement/submit", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tasks: VALID_TASKS }),
    }));
    expect(res.status).toBe(502);
    expect(saved).toHaveLength(0);
  });

  test("POST confirm: accept=false は summary を返すだけ（レベル操作なし・キャッシュ無効化なし）", async () => {
    const invalidated: string[] = [];
    const placementSetCalls: number[] = [];
    const { deps } = makeTestDeps({
      invalidateMenuCache: () => { invalidated.push("x"); },
      progressStore: makeFakeProgressStore({
        placementSet: (l) => { placementSetCalls.push(l); return { status: "applied", summary: FAKE_SUMMARY, levelChanged: true }; },
      }),
    });
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/placement/confirm", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept: false }),
    }));
    expect(res.status).toBe(200);
    expect(placementSetCalls).toHaveLength(0);
    expect(invalidated).toHaveLength(0);
  });

  test("POST confirm: accept=true + level 省略は最新測定の startLevel を適用しキャッシュ無効化", async () => {
    const invalidated: string[] = [];
    const placementSetCalls: number[] = [];
    const { deps } = makeTestDeps({
      invalidateMenuCache: () => { invalidated.push("x"); },
      placementStore: makeFakePlacementStore({
        save: () => ({ id: 1, ts: "t", stage: 3, startLevel: 23, rationale: "r" }),
        latest: () => ({ id: 1, ts: "t", stage: 3, startLevel: 23, rationale: "r" }),
      }),
      progressStore: makeFakeProgressStore({
        placementSet: (l) => { placementSetCalls.push(l); return { status: "applied", summary: FAKE_SUMMARY, levelChanged: true }; },
      }),
    });
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/placement/confirm", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept: true }),
    }));
    expect(res.status).toBe(200);
    expect(placementSetCalls).toEqual([23]);
    expect(invalidated).toHaveLength(1);
  });

  test("POST confirm: accept=true + 明示 level はそれを適用 / 測定なし+level省略は400 / 不正bodyは400", async () => {
    const placementSetCalls: number[] = [];
    const { deps } = makeTestDeps({
      progressStore: makeFakeProgressStore({
        placementSet: (l) => { placementSetCalls.push(l); return { status: "applied", summary: FAKE_SUMMARY, levelChanged: true }; },
      }),
    });
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/placement/confirm", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept: true, level: 31 }),
    }));
    expect(ok.status).toBe(200);
    expect(placementSetCalls).toEqual([31]);
    // makeTestDeps デフォルトの latest() は null
    const noLatest = await handler(new Request("http://localhost/api/placement/confirm", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept: true }),
    }));
    expect(noLatest.status).toBe(400);
    const badAccept = await handler(new Request("http://localhost/api/placement/confirm", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accept: "yes" }),
    }));
    expect(badAccept.status).toBe(400);
  });

  test("GET /api/placement/latest は {result: null} または最新1件", async () => {
    const { deps } = makeTestDeps();
    const res1 = await makeFetchHandler(deps)(getReq("/api/placement/latest"));
    expect(await res1.json()).toEqual({ result: null });
    const { deps: deps2 } = makeTestDeps({
      placementStore: makeFakePlacementStore({
        save: () => ({ id: 1, ts: "t", stage: 3, startLevel: 23, rationale: "r" }),
        latest: () => ({ id: 9, ts: "2026-07-06T00:00:00.000Z", stage: 3, startLevel: 23, rationale: "r" }),
      }),
    });
    const res2 = await makeFetchHandler(deps2)(getReq("/api/placement/latest"));
    expect(await res2.json()).toEqual({ result: { id: 9, ts: "2026-07-06T00:00:00.000Z", stage: 3, startLevel: 23, rationale: "r" } });
  });
});
