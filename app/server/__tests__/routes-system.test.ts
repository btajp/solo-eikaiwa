import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { localYmd } from "../dates";
import { makeFetchHandler } from "../routes";
import { FAKE_HEALTH, makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";

describe("routes: health", () => {
  test("GET /api/health は200で health() の結果をそのまま返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_HEALTH);
  });
});

describe("routes: stt", () => {
  test("空ボディは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/stt", { method: "POST", body: new Uint8Array([]) }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty audio body" });
  });

  test("音声バイトを受け取ると recordingsDir/YYYY-MM-DD/ に保存し {text} を返す", async () => {
    const { deps, recordingsDir } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/stt", {
        method: "POST",
        headers: { "content-type": "audio/webm" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    expect(res.status).toBe(200);
    // segments: [] でも computeUtteranceMetrics は例外を投げず全ゼロを返すため、metrics は additive に付く
    expect(await res.json()).toEqual({
      text: "fake transcript",
      metrics: {
        words: 0, totalMs: 0, speechMs: 0,
        speechRateWpm: 0, articulationRateWpm: 0,
        pauses: { count: 0, totalMs: 0, longestMs: 0 },
        repetitionRatio: 0,
      },
    });

    // handleStt は録音ディレクトリをサーバローカル日付で切る（UTCだとJST早朝にズレる）
    const day = localYmd();
    const dayDir = path.join(recordingsDir, day);
    expect(existsSync(dayDir)).toBe(true);
    const files = readdirSync(dayDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+\.webm$/);
  });

  test("content-typeにwavを含むと拡張子はwav", async () => {
    const { deps, recordingsDir } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    await handler(
      new Request("http://localhost/api/stt", {
        method: "POST",
        headers: { "content-type": "audio/wav" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    // handleStt は録音ディレクトリをサーバローカル日付で切る（UTCだとJST早朝にズレる）
    const day = localYmd();
    const files = readdirSync(path.join(recordingsDir, day));
    expect(files[0]).toMatch(/^\d+\.wav$/);
  });
});

describe("routes: tts", () => {
  test("textが空なら400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      postJson("/api/tts", {}),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "text is required" });
  });

  test("正常系: audio/mpeg と x-tts-engine ヘッダを返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      postJson("/api/tts", { text: "hello" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(res.headers.get("x-tts-engine")).toBe("say");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  test("不正なJSONボディは400（500にならない）", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });
});
