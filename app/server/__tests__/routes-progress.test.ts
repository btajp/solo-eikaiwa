import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { FAKE_SUMMARY, makeFakeProgressStore, makeTestDeps } from "./helpers/route-deps";
import { getReq } from "./helpers/http";

describe("routes: progress", () => {
  test("GET /api/progress/summary は summary を返す", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(getReq("/api/progress/summary"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_SUMMARY);
  });

  test("GET /api/progress/days は ログ日∪XP日 と xpByDay を返す", async () => {
    const { deps } = makeTestDeps(); // practiceDays: 2026-07-01, 2026-07-03 / xpByDay: {2026-07-01: 32}
    const res = await makeFetchHandler(deps)(getReq("/api/progress/days"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      days: ["2026-07-01", "2026-07-03"],
      xpByDay: { "2026-07-01": 32 },
    });
  });
  test("GET /api/progress/days: XPのみの日（SRS採点等）も days に含まれる", async () => {
    const { deps } = makeTestDeps({
      progressStore: makeFakeProgressStore({ xpByDay: () => ({ "2026-07-02": 4, "2026-07-01": 32 }) }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/progress/days"));
    expect(await res.json()).toEqual({
      days: ["2026-07-01", "2026-07-02", "2026-07-03"],
      xpByDay: { "2026-07-01": 32, "2026-07-02": 4 },
    });
  });

  test("POST /api/progress/xp: block のみ受け付け、上限超過・不正kindは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        kind: "block", amount: 6, attemptId: 7, blockKind: "warmup-reading", completionId: "completion-route-0001",
      }) }));
    expect(ok.status).toBe(200);
    const badKind = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "srs-grade", amount: 2 }) }));
    expect(badKind.status).toBe(400);
    const tooBig = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "block", amount: 61 }) }));
    expect(tooBig.status).toBe(400);
    const badAttempt = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        kind: "block", amount: 6, attemptId: "x", blockKind: "warmup-reading", completionId: "completion-route-0002",
      }) }));
    expect(badAttempt.status).toBe(400);
    const missingCompletion = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        kind: "block", amount: 6, attemptId: 7, blockKind: "warmup-reading",
      }) }));
    expect(missingCompletion.status).toBe(400);
  });

  test("POST /api/progress/xp: attempt不整合を404/409で返す", async () => {
    const progressStore = makeFakeProgressStore({
      completeBlock: (_amount, input) => ({
        status: input.attemptId === 404 ? "unknown-attempt" : "attempt-mismatch",
        summary: null,
      }),
    });
    const h = makeFetchHandler(makeTestDeps({ progressStore }).deps);
    const send = (attemptId: number) => h(new Request("http://localhost/api/progress/xp", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        kind: "block", amount: 6, attemptId, blockKind: "reflection", completionId: `completion-${attemptId}-route`,
      }),
    }));
    expect((await send(404)).status).toBe(404);
    expect((await send(7)).status).toBe(409);
  });
  test("POST /api/progress/block-start: 有効kindで attemptId、不正kindは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/progress/block-start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "warmup-reading" }) }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ attemptId: 7 });
    const bad = await handler(new Request("http://localhost/api/progress/block-start", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "bogus" }) }));
    expect(bad.status).toBe(400);
  });
  test("POST /api/progress/block-abort: attemptとblock kindを検証する", async () => {
    const { deps } = makeTestDeps();
    const h = makeFetchHandler(deps);
    const ok = await h(new Request("http://localhost/api/progress/block-abort", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        attemptId: 7, blockKind: "warmup-reading",
      }),
    }));
    expect(ok.status).toBe(200);
    const bad = await h(new Request("http://localhost/api/progress/block-abort", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        attemptId: 7, blockKind: "bogus",
      }),
    }));
    expect(bad.status).toBe(400);
  });
  test("POST /api/progress/level: set 成功・提案なしaccept/declineは400・不正actionは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set", level: 20 }) }));
    expect(ok.status).toBe(200);
    const noProposal = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "accept" }) }));
    expect(noProposal.status).toBe(400);
    const badAction = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reset" }) }));
    expect(badAction.status).toBe(400);
  });
  test("POST /api/progress/level: accept/declineは表示提案のkind・toLevelを必須にする", async () => {
    let calls = 0;
    const { deps } = makeTestDeps({
      progressStore: makeFakeProgressStore({
        levelAction: () => { calls++; return { status: "applied", summary: FAKE_SUMMARY, levelChanged: true }; },
      }),
    });
    const h = makeFetchHandler(deps);
    expect((await h(new Request("http://localhost/api/progress/level", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "accept" }),
    }))).status).toBe(400);
    expect(calls).toBe(0);
  });

  test("POST /api/progress/level: 表示提案との不一致は最新summary付き409にする", async () => {
    const { deps } = makeTestDeps({
      progressStore: makeFakeProgressStore({
        levelAction: () => ({ status: "mismatch", summary: FAKE_SUMMARY, levelChanged: false } as never),
      }),
    });
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/progress/level", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "accept", kind: "up", toLevel: 21 }),
    }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "proposal changed", summary: FAKE_SUMMARY });
  });
  test("POST /api/progress/level: accept/set 成功時のみ当日メニューキャッシュを無効化し、declineでは呼ばない", async () => {
    let invalidateCalls = 0;
    const { deps } = makeTestDeps({
      invalidateMenuCache: () => { invalidateCalls++; },
      progressStore: makeFakeProgressStore({
        // テスト目的で action を問わず成功させ、accept/decline それぞれのハンドラ分岐だけを見る
        levelAction: (action) => ({ status: "applied", summary: FAKE_SUMMARY, levelChanged: action !== "decline" }),
      }),
    });
    const handler = makeFetchHandler(deps);

    const setRes = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set", level: 20 }) }));
    expect(setRes.status).toBe(200);
    expect(invalidateCalls).toBe(1);

    const acceptRes = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "accept", kind: "up", toLevel: 21 }) }));
    expect(acceptRes.status).toBe(200);
    expect(invalidateCalls).toBe(2);

    const declineRes = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "decline", kind: "up", toLevel: 21 }) }));
    expect(declineRes.status).toBe(200);
    expect(invalidateCalls).toBe(2); // decline は無効化しない
  });
  test("POST /api/progress/level: 同一レベルへの set はメニューキャッシュを無効化しない", async () => {
    let invalidateCalls = 0;
    const { deps } = makeTestDeps({
      invalidateMenuCache: () => { invalidateCalls++; },
      progressStore: makeFakeProgressStore({
        levelAction: (_action, level) => ({ status: "applied", summary: FAKE_SUMMARY, levelChanged: level !== 13 }),
      }),
    });
    const handler = makeFetchHandler(deps);

    const noopRes = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set", level: 13 }) }));
    expect(noopRes.status).toBe(200);
    expect(invalidateCalls).toBe(0);

    const changedRes = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "set", level: 20 }) }));
    expect(changedRes.status).toBe(200);
    expect(invalidateCalls).toBe(1); // 実際にレベルが変わる set は無効化する
  });
  test("POST /api/sentences/grade は srs-grade XP を付与する（good=2, soso=1）", async () => {
    const calls: Array<{ kind: string; amount: number }> = [];
    const { deps } = makeTestDeps({
      progressStore: makeFakeProgressStore({
        addXp: (kind, amount) => { calls.push({ kind, amount }); return FAKE_SUMMARY; },
        levelAction: () => null,
      }),
    });
    const handler = makeFetchHandler(deps);
    await handler(new Request("http://localhost/api/sentences/grade", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ no: 1, grade: "good", answerId: "answer-progress-0001" }) }));
    await handler(new Request("http://localhost/api/sentences/grade", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ no: 1, grade: "soso", answerId: "answer-progress-0002" }) }));
    expect(calls).toEqual([{ kind: "srs-grade", amount: 2 }, { kind: "srs-grade", amount: 1 }]);
  });
});
