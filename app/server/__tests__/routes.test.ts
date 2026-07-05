import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFetchHandler, type RouteDeps } from "../routes";
import { markErrorLogged, readEvents } from "../session-log";

const FAKE_HEALTH = { ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: true };

/** テストごとに独立した temp dir/log を持つフェイク RouteDeps を組み立てる */
function makeTestDeps(overrides: Partial<RouteDeps> = {}): {
  deps: RouteDeps;
  logFile: string;
  recordingsDir: string;
} {
  const dir = mkdtempSync(path.join(tmpdir(), "routes-"));
  const logFile = path.join(dir, "log.jsonl");
  const recordingsDir = path.join(dir, "recordings");
  const deps: RouteDeps = {
    transcribe: (async (_inputPath: string) => "fake transcript") as RouteDeps["transcribe"],
    synthesize: (async (_text: string) => ({
      audio: new Uint8Array([1, 2, 3]),
      mime: "audio/mpeg",
      engine: "say" as const,
    })) as RouteDeps["synthesize"],
    converse: (async (args: { userText: string; sessionId?: string }) => ({
      replyText: `echo: ${args.userText}`,
      sessionId: args.sessionId ?? "sess-fake",
    })) as RouteDeps["converse"],
    health: () => FAKE_HEALTH,
    logFile: () => logFile,
    recordingsDir,
    ...overrides,
  };
  return { deps, logFile, recordingsDir };
}

describe("routes: health", () => {
  test("GET /api/health は200で health() の結果をそのまま返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/health"));
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
    expect(await res.json()).toEqual({ text: "fake transcript" });

    const day = new Date().toISOString().slice(0, 10);
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
    const day = new Date().toISOString().slice(0, 10);
    const files = readdirSync(path.join(recordingsDir, day));
    expect(files[0]).toMatch(/^\d+\.wav$/);
  });
});

describe("routes: tts", () => {
  test("textが空なら400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "text is required" });
  });

  test("正常系: audio/mpeg と x-tts-engine ヘッダを返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "hello" }),
      }),
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

describe("routes: converse", () => {
  test("userTextが空なら400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/converse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "userText is required" });
  });

  test("正常系: {replyText, sessionId} を返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/converse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: "Hi", sessionId: "s1" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ replyText: "echo: Hi", sessionId: "s1" });
  });

  test("不正なJSONボディは400（500にならない）", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/converse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toHaveProperty("error");
  });
});

describe("routes: session", () => {
  test("POST /api/session/start は {ok:true} を返し session_start をログする", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/session/start", { method: "POST" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = readEvents(logFile);
    expect(events.map((e) => e.type)).toEqual(["session_start"]);
  });

  test("POST /api/session/end は {ok:true} を返し session_end をログする", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/session/end", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: "s1" }),
      }),
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

describe("routes: 404 と 500", () => {
  test("未知のルートは404", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  test("依存が例外を投げると500 {error} を返し、errorイベントがログに残る", async () => {
    const { deps, logFile } = makeTestDeps({
      converse: (async () => {
        throw new Error("boom from dep");
      }) as RouteDeps["converse"],
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/converse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: "hi" }),
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom from dep" });

    const events = readEvents(logFile);
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect(events[0].text).toBe("boom from dep");
  });

  test("logFile自体が壊れていても500 {error} は保証される（二重障害でクラッシュしない）", async () => {
    const { deps } = makeTestDeps({
      converse: (async () => {
        throw new Error("boom from dep");
      }) as RouteDeps["converse"],
      logFile: () => {
        throw new Error("log path unavailable");
      },
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/converse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: "hi" }),
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "boom from dep" });
  });

  test("マーカー付きエラー（converseTurnが記録済み）は最上位catchで二重記録しない", async () => {
    const { deps, logFile } = makeTestDeps({
      converse: (async () => {
        const err = new Error("already logged downstream");
        markErrorLogged(err);
        throw err;
      }) as RouteDeps["converse"],
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/converse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userText: "hi" }),
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "already logged downstream" });
    expect(readEvents(logFile)).toEqual([]); // 二重記録されていない
  });
});
