import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { markErrorLogged, readEvents } from "../session-log";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";

describe("routes: 404 と 500", () => {
  test("未知のルートは404", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/api/nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("依存が例外を投げると500 {error} を返し、errorイベントがログに残る", async () => {
    const { deps, logFile } = makeTestDeps({
      converse: async () => {
        throw new Error("boom from dep");
      },
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(
      postJson("/api/converse", { userText: "hi", activitySessionId: "practice-1" }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom from dep" });

    const events = readEvents(logFile);
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(events[0].text).toBe("boom from dep");
  });

  test("logFile自体が壊れていても500 {error} は保証される（二重障害でクラッシュしない）", async () => {
    const { deps } = makeTestDeps({
      converse: async () => {
        throw new Error("boom from dep");
      },
      logFile: () => {
        throw new Error("log path unavailable");
      },
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(
      postJson("/api/converse", { userText: "hi", activitySessionId: "practice-1" }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom from dep" });
  });

  test("マーカー付きエラー（converseTurnが記録済み）は最上位catchで二重記録しない", async () => {
    const { deps, logFile } = makeTestDeps({
      converse: async () => {
        const err = new Error("already logged downstream");
        markErrorLogged(err);
        throw err;
      },
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(
      postJson("/api/converse", { userText: "hi", activitySessionId: "practice-1" }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "already logged downstream" });
    expect(readEvents(logFile)).toEqual([]); // 二重記録されていない
  });
});
