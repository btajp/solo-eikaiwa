import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { localYmd } from "../dates";
import { makeFetchHandler } from "../routes";
import { MAX_STT_BODY_BYTES, MAX_TTS_TEXT_CHARS } from "../routes/system";
import { UnsupportedAudioContainerError } from "../stt";
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
      new Request("http://localhost/api/stt", {
        method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array([]),
      }),
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

  test("content-typeにmp4を含むと拡張子はmp4", async () => {
    const { deps, recordingsDir } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    await handler(
      new Request("http://localhost/api/stt", {
        method: "POST",
        headers: { "content-type": "audio/mp4" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    const day = localYmd();
    const files = readdirSync(path.join(recordingsDir, day));
    expect(files[0]).toMatch(/^\d+\.mp4$/);
  });

  test("この環境で使える変換器が無い（UnsupportedAudioContainerError）場合は500ではなく400を返す", async () => {
    const { deps } = makeTestDeps({
      transcribe: async () => {
        throw new UnsupportedAudioContainerError("webm");
      },
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(
      new Request("http://localhost/api/stt", {
        method: "POST",
        headers: { "content-type": "audio/webm" },
        body: new Uint8Array([1, 2, 3, 4]),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/mp4 録音が必要/);
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

  test("text/voiceの型不正と文字数上限超過はsynthesize前に400", async () => {
    let calls = 0;
    const { deps } = makeTestDeps({
      synthesize: async () => {
        calls++;
        return { audio: new Uint8Array([1]), mime: "audio/mpeg", engine: "say" as const };
      },
    });
    const handler = makeFetchHandler(deps);

    const wrongType = await handler(postJson("/api/tts", { text: 123 }));
    expect(wrongType.status).toBe(400);
    const tooLong = await handler(postJson("/api/tts", { text: "x".repeat(MAX_TTS_TEXT_CHARS + 1) }));
    expect(tooLong.status).toBe(400);
    const wrongVoice = await handler(postJson("/api/tts", { text: "hello", voice: 123 }));
    expect(wrongVoice.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("TTS textの境界値は許可する", async () => {
    let received = "";
    const { deps } = makeTestDeps({
      synthesize: async (text) => {
        received = text;
        return { audio: new Uint8Array([1]), mime: "audio/mpeg", engine: "say" as const };
      },
    });
    const text = "x".repeat(MAX_TTS_TEXT_CHARS);
    const res = await makeFetchHandler(deps)(postJson("/api/tts", { text }));
    expect(res.status).toBe(200);
    expect(received).toBe(text);
  });
});

describe("routes: stt request budget", () => {
  test("route上限を超えるContent-Lengthは録音保存・transcribe前に413", async () => {
    let transcribeCalls = 0;
    const { deps, recordingsDir } = makeTestDeps({
      transcribe: async () => {
        transcribeCalls++;
        return { text: "never", segments: [] };
      },
    });
    const req = new Request("http://localhost/api/stt", {
      method: "POST",
      headers: {
        "content-type": "audio/webm",
        "content-length": String(MAX_STT_BODY_BYTES + 1),
      },
      body: new Uint8Array([1]),
    });
    const res = await makeFetchHandler(deps)(req);
    expect(res.status).toBe(413);
    expect(transcribeCalls).toBe(0);
    expect(existsSync(recordingsDir)).toBe(false);
  });

  test("音声でないContent-Typeは録音保存・transcribe前に415", async () => {
    let transcribeCalls = 0;
    const { deps, recordingsDir } = makeTestDeps({
      transcribe: async () => {
        transcribeCalls++;
        return { text: "never", segments: [] };
      },
    });
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/stt", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not audio",
    }));
    expect(res.status).toBe(415);
    expect(transcribeCalls).toBe(0);
    expect(existsSync(recordingsDir)).toBe(false);
  });
});
