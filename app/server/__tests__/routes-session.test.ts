import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { readEvents } from "../session-log";
import { makeTestDeps } from "./helpers/route-deps";
import { postJson } from "./helpers/http";

describe("routes: session", () => {
  test("POST /api/session/start は {ok:true} を返し session_start をログする", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/session/start", {}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = readEvents(logFile);
    expect(events.map((e) => e.type)).toEqual(["session_start"]);
  });

  test("POST /api/session/start はボディの sessionId をログする（追加・後方互換）", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/session/start", { sessionId: "app-uuid-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = readEvents(logFile);
    expect(events).toEqual([expect.objectContaining({ type: "session_start", sessionId: "app-uuid-1" })]);
  });

  test("POST /api/session/start の不正なJSONボディは400で副作用なし", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    }));
    expect(res.status).toBe(400);
    expect(readEvents(logFile)).toEqual([]);
  });

  test("POST /api/session/end は {ok:true} を返し session_end をログする", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      postJson("/api/session/end", { sessionId: "s1" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = readEvents(logFile);
    expect(events).toEqual([expect.objectContaining({ type: "session_end", sessionId: "s1" })]);
  });

  test("session/end の不正なJSONボディは400（500にならない）", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/session/end", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });
});

describe("routes: session/event", () => {
  test("ホワイトリストのtypeはログされ {ok:true}", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/session/event", { type: "block_start", meta: { blockId: "b2", kind: "four-three-two" } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = readEvents(logFile);
    expect(events).toEqual([
      expect.objectContaining({ type: "block_start", meta: { blockId: "b2", kind: "four-three-two" } }),
    ]);
  });

  test("round_end は transcript/elapsedSec を含む meta がそのままJSONLに残る（自由形式）", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/session/event", {
      type: "round_end",
      sessionId: "app-uuid-1",
      meta: { block: "four-three-two", round: 1, transcript: "I go to work every day.", elapsedSec: 231 },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = readEvents(logFile);
    expect(events).toEqual([
      expect.objectContaining({
        type: "round_end",
        sessionId: "app-uuid-1",
        meta: { block: "four-three-two", round: 1, transcript: "I go to work every day.", elapsedSec: 231 },
      }),
    ]);
  });

  test("ホワイトリスト外のtypeは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/session/event", { type: "session_start" }));
    expect(res.status).toBe(400);
  });
});
