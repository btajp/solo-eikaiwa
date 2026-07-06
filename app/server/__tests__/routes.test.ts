import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFetchHandler, type RouteDeps } from "../routes";
import { markErrorLogged, readEvents } from "../session-log";
import type { QuickKind } from "../menu";

const FAKE_HEALTH = { ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: true };
const FAKE_MENU = {
  minutes: 60 as const,
  date: "2026-07-05",
  level: 13,
  blocks: [{ id: "b1", kind: "reflection", title: "振り返り", minutes: 5, params: {} }],
};
const FAKE_QUICK_MENU = {
  minutes: 6,
  date: "2026-07-05",
  level: 13,
  blocks: [{ id: "q1", kind: "warmup-reading", title: "音読ウォームアップ", minutes: 6, params: {} }],
};
const FAKE_AE = { items: [{ quote: "q", issue: "i", better: "b", why_ja: "w" }], praise: "p" };
const FAKE_REFLECTION = { goodPhrases: ["g"], fixes: [], noteForTomorrow_ja: "n" };
const FAKE_SENTENCE = {
  no: 1, category_no: 1, category: "現在形", domain: "daily" as const,
  en: "I usually start work at nine.", ja: "たいてい9時に仕事を始めます。", note: "習慣の現在形",
  srs: null,
};
const FAKE_SUMMARY = {
  level: 13, xp: 0, xpIntoLevel: 0, xpToNext: 25, stage: 2, difficultyMaxed: false, proposal: null,
};

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
    buildMenu: ((_minutes: 60 | 30) => FAKE_MENU) as RouteDeps["buildMenu"],
    aeFeedback: (async () => FAKE_AE) as RouteDeps["aeFeedback"],
    modelTalk: (async (topicId: string) =>
      topicId === "known-topic" ? { text: "model talk" } : null) as RouteDeps["modelTalk"],
    reflection: (async () => FAKE_REFLECTION) as RouteDeps["reflection"],
    scenarioPrompt: ((id: string) => (id === "known-scenario" ? "ROLEPLAY PROMPT" : null)) as RouteDeps["scenarioPrompt"],
    prepPack: (async () => ({
      chunks: [{ en: "The main problem was ...", ja: "一番の問題は…" }],
      outline: ["Opening"],
    })) as RouteDeps["prepPack"],
    buildQuick: ((_kind: QuickKind) => FAKE_QUICK_MENU) as RouteDeps["buildQuick"],
    practiceDays: () => ["2026-07-01", "2026-07-03"],
    getSettings: () => ({ anchor: "" }),
    saveSettings: (_s: { anchor: string }) => {},
    libraryStore: {
      saveModelTalk: (_e: { topicId: string; topicTitle: string; text: string }) => {},
      listModelTalks: () => [],
    },
    sentenceStore: {
      list: () => [FAKE_SENTENCE],
      queue: (_newCount: number) => [FAKE_SENTENCE],
      grade: (no: number, _grade: "good" | "soso" | "bad") =>
        no === 1 ? { no: 1, stage: 1, due: "2026-07-09" } : null,
    } as RouteDeps["sentenceStore"],
    progressStore: {
      getLevel: () => 13,
      getSummary: () => FAKE_SUMMARY,
      addXp: (kind: string, amount: number) =>
        kind === "block" && Number.isInteger(amount) && amount >= 1 && amount <= 60 ? FAKE_SUMMARY
        : kind === "srs-grade" ? FAKE_SUMMARY : null,
      blockStart: (_kind: string) => ({ attemptId: 7 }),
      levelAction: (action: string, level?: number) =>
        action === "set" && Number.isInteger(level) && (level as number) >= 1 ? FAKE_SUMMARY : null,
    } as RouteDeps["progressStore"],
    invalidateMenuCache: () => {},
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

  test("POST /api/session/start はボディの sessionId をログする（追加・後方互換）", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "app-uuid-1" }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = readEvents(logFile);
    expect(events).toEqual([expect.objectContaining({ type: "session_start", sessionId: "app-uuid-1" })]);
  });

  test("POST /api/session/start は不正なJSONボディでも従来どおり200で動く（500にならない）", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/session/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const events = readEvents(logFile);
    expect(events).toEqual([expect.objectContaining({ type: "session_start", sessionId: "pending" })]);
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

describe("routes: menu", () => {
  test("GET /api/menu/today はデフォルト60分のメニューを返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/menu/today"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_MENU);
  });

  test("minutes=30 が渡る / 不正値は400", async () => {
    const seen: number[] = [];
    const { deps } = makeTestDeps({
      buildMenu: ((m: 60 | 30) => { seen.push(m); return { ...FAKE_MENU, minutes: m }; }) as RouteDeps["buildMenu"],
    });
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/menu/today?minutes=30"));
    expect(ok.status).toBe(200);
    expect(seen).toEqual([30]);
    const bad = await handler(new Request("http://localhost/api/menu/today?minutes=45"));
    expect(bad.status).toBe(400);
  });
});

describe("routes: coach", () => {
  test("POST /api/feedback/ae: 正常系とtranscript空400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/feedback/ae", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transcript: "I go yesterday", topicTitle: "My week" }),
    }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual(FAKE_AE);
    const bad = await handler(new Request("http://localhost/api/feedback/ae", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topicTitle: "x" }),
    }));
    expect(bad.status).toBe(400);
  });

  test("POST /api/coach/model-talk: 既知ID 200 / 欠落400 / 未知404", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/coach/model-talk", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ topicId: "known-topic" }),
    }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: "model talk" });
    const missing = await handler(new Request("http://localhost/api/coach/model-talk", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(missing.status).toBe(400);
    const unknown = await handler(new Request("http://localhost/api/coach/model-talk", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ topicId: "nope" }),
    }));
    expect(unknown.status).toBe(404);
  });

  test("POST /api/coach/reflection は Reflection を返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/coach/reflection", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_REFLECTION);
  });
});

describe("routes: session/event", () => {
  test("ホワイトリストのtypeはログされ {ok:true}", async () => {
    const { deps, logFile } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/session/event", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "block_start", meta: { blockId: "b2", kind: "four-three-two" } }),
    }));
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
    const res = await handler(new Request("http://localhost/api/session/event", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "round_end",
        sessionId: "app-uuid-1",
        meta: { block: "four-three-two", round: 1, transcript: "I go to work every day.", elapsedSec: 231 },
      }),
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
    const res = await handler(new Request("http://localhost/api/session/event", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "session_start" }),
    }));
    expect(res.status).toBe(400);
  });
});

describe("routes: converse + scenarioId", () => {
  test("既知の scenarioId は systemPromptOverride 付きで converse に渡る", async () => {
    const seen: Array<{ systemPromptOverride?: string }> = [];
    const { deps } = makeTestDeps({
      converse: (async (args: { userText: string; sessionId?: string; systemPromptOverride?: string }) => {
        seen.push({ systemPromptOverride: args.systemPromptOverride });
        return { replyText: "ok", sessionId: "s1" };
      }) as RouteDeps["converse"],
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/converse", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userText: "hi", scenarioId: "known-scenario" }),
    }));
    expect(res.status).toBe(200);
    expect(seen[0].systemPromptOverride).toBe("ROLEPLAY PROMPT");
  });

  test("未知の scenarioId は400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/converse", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userText: "hi", scenarioId: "nope" }),
    }));
    expect(res.status).toBe(400);
  });

  test("scenarioId なしは従来どおり（override は undefined）", async () => {
    const seen: Array<{ systemPromptOverride?: string }> = [];
    const { deps } = makeTestDeps({
      converse: (async (args: { userText: string; systemPromptOverride?: string }) => {
        seen.push({ systemPromptOverride: args.systemPromptOverride });
        return { replyText: "ok", sessionId: "s1" };
      }) as RouteDeps["converse"],
    });
    const handler = makeFetchHandler(deps);
    await handler(new Request("http://localhost/api/converse", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userText: "hi" }),
    }));
    expect(seen[0].systemPromptOverride).toBeUndefined();
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

describe("routes: coach/prep", () => {
  test("topicId欠落は400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/coach/prep", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
    }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("topicId");
  });

  test("未知のtopicIdは404", async () => {
    const { deps } = makeTestDeps({ prepPack: (async () => null) as RouteDeps["prepPack"] });
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/coach/prep", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: "nope" }),
    }));
    expect(res.status).toBe(404);
  });

  test("正常系はPrepPackを返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/coach/prep", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId: "zero-trust" }),
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chunks: Array<{ en: string; ja: string }>; outline: string[] };
    expect(body.chunks[0].en).toContain("problem");
    expect(body.outline).toEqual(["Opening"]);
  });

  test("不正JSONボディは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/coach/prep", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{oops",
    }));
    expect(res.status).toBe(400);
  });
});

describe("routes: quick menu / progress / settings", () => {
  test("GET /api/menu/quick?kind=warmup は200でメニューを返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/menu/quick?kind=warmup"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_QUICK_MENU);
  });

  test("GET /api/menu/quick の不正kindとkind欠落は400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    for (const q of ["?kind=bogus", ""]) {
      const res = await handler(new Request(`http://localhost/api/menu/quick${q}`));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("kind");
    }
  });

  test("GET /api/progress/days は {days} を返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/progress/days"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ days: ["2026-07-01", "2026-07-03"] });
  });

  test("GET /api/settings と PUT /api/settings のラウンドトリップ", async () => {
    let stored = { anchor: "" };
    const { deps } = makeTestDeps({
      getSettings: () => stored,
      saveSettings: (s) => { stored = s; },
    });
    const handler = makeFetchHandler(deps);
    const put = await handler(new Request("http://localhost/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anchor: "朝コーヒーを淹れたら1ドリル" }),
    }));
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ ok: true });
    const got = await handler(new Request("http://localhost/api/settings"));
    expect(await got.json()).toEqual({ anchor: "朝コーヒーを淹れたら1ドリル" });
  });

  test("PUT /api/settings は anchor が string でない・200字超・不正JSONで400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const bad1 = await handler(new Request("http://localhost/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: 42 }),
    }));
    expect(bad1.status).toBe(400);
    const bad2 = await handler(new Request("http://localhost/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ anchor: "x".repeat(201) }),
    }));
    expect(bad2.status).toBe(400);
    const bad3 = await handler(new Request("http://localhost/api/settings", {
      method: "PUT", headers: { "content-type": "application/json" }, body: "{broken",
    }));
    expect(bad3.status).toBe(400);
  });
});

describe("library", () => {
  test("model-talk 成功時に libraryStore.saveModelTalk が topicTitle 付きで呼ばれ、レスポンスは {text} のみ", async () => {
    const saved: Array<{ topicId: string; topicTitle: string; text: string }> = [];
    const { deps } = makeTestDeps({
      modelTalk: async (topicId: string) =>
        topicId === "known-topic" ? { text: "model talk", topicTitle: "Known Topic" } : null,
      libraryStore: { saveModelTalk: (e) => saved.push(e), listModelTalks: () => [] },
    });
    const res = await makeFetchHandler(deps)(
      new Request("http://x/api/coach/model-talk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicId: "known-topic" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "model talk" }); // topicTitle を漏らさない
    expect(saved).toEqual([{ topicId: "known-topic", topicTitle: "Known Topic", text: "model talk" }]);
  });

  test("unknown topicId (404) では保存しない", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      libraryStore: { saveModelTalk: (e) => saved.push(e), listModelTalks: () => [] },
    });
    const res = await makeFetchHandler(deps)(
      new Request("http://x/api/coach/model-talk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicId: "nope" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(saved).toHaveLength(0);
  });

  test("GET /api/library/model-talks が {entries} を返す", async () => {
    const entry = { id: 1, createdAt: "2026-07-06T00:00:00.000Z", topicId: "t1", topicTitle: "T", text: "talk" };
    const { deps } = makeTestDeps({
      libraryStore: { saveModelTalk: () => {}, listModelTalks: () => [entry] },
    });
    const res = await makeFetchHandler(deps)(new Request("http://x/api/library/model-talks"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [entry] });
  });

  test("saveModelTalk が例外を投げても POST /api/coach/model-talk は200で {text} を返す", async () => {
    const { deps } = makeTestDeps({
      libraryStore: {
        saveModelTalk: () => {
          throw new Error("disk full");
        },
        listModelTalks: () => [],
      },
    });
    const res = await makeFetchHandler(deps)(
      new Request("http://x/api/coach/model-talk", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ topicId: "known-topic" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "model talk" });
  });
});

describe("sentences ルート", () => {
  test("GET /api/sentences は {sentences} を返す", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(new Request("http://x/api/sentences"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sentences: [FAKE_SENTENCE] });
  });

  test("GET /api/sentences/queue は new を検証して {queue} を返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://x/api/sentences/queue?new=5"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ queue: [FAKE_SENTENCE] });
    const bad = await handler(new Request("http://x/api/sentences/queue?new=abc"));
    expect(bad.status).toBe(400);
    const neg = await handler(new Request("http://x/api/sentences/queue?new=-1"));
    expect(neg.status).toBe(400);
  });

  test("POST /api/sentences/grade は成功で {no,stage,due}", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(new Request("http://x/api/sentences/grade", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ no: 1, grade: "good" }),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ no: 1, stage: 1, due: "2026-07-09" });
  });

  test("POST /api/sentences/grade は不正入力に 400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const badGrade = await handler(new Request("http://x/api/sentences/grade", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ no: 1, grade: "perfect" }),
    }));
    expect(badGrade.status).toBe(400);
    const badNo = await handler(new Request("http://x/api/sentences/grade", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ no: 1.5, grade: "good" }),
    }));
    expect(badNo.status).toBe(400);
    const unknownNo = await handler(new Request("http://x/api/sentences/grade", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ no: 999, grade: "good" }),
    }));
    expect(unknownNo.status).toBe(400);
    expect((await unknownNo.json()).error).toContain("unknown");
  });
});

describe("routes: progress", () => {
  test("GET /api/progress/summary は summary を返す", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/progress/summary"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_SUMMARY);
  });
  test("POST /api/progress/xp: block のみ受け付け、上限超過・不正kindは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", body: JSON.stringify({ kind: "block", amount: 6, attemptId: 7 }) }));
    expect(ok.status).toBe(200);
    const badKind = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", body: JSON.stringify({ kind: "srs-grade", amount: 2 }) }));
    expect(badKind.status).toBe(400);
    const tooBig = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", body: JSON.stringify({ kind: "block", amount: 61 }) }));
    expect(tooBig.status).toBe(400);
    const badAttempt = await handler(new Request("http://localhost/api/progress/xp", {
      method: "POST", body: JSON.stringify({ kind: "block", amount: 6, attemptId: "x" }) }));
    expect(badAttempt.status).toBe(400);
  });
  test("POST /api/progress/block-start: 有効kindで attemptId、不正kindは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/progress/block-start", {
      method: "POST", body: JSON.stringify({ kind: "warmup-reading" }) }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ attemptId: 7 });
    const bad = await handler(new Request("http://localhost/api/progress/block-start", {
      method: "POST", body: JSON.stringify({ kind: "bogus" }) }));
    expect(bad.status).toBe(400);
  });
  test("POST /api/progress/level: set 成功・提案なしaccept/declineは400・不正actionは400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", body: JSON.stringify({ action: "set", level: 20 }) }));
    expect(ok.status).toBe(200);
    const noProposal = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", body: JSON.stringify({ action: "accept" }) }));
    expect(noProposal.status).toBe(400);
    const badAction = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", body: JSON.stringify({ action: "reset" }) }));
    expect(badAction.status).toBe(400);
  });
  test("POST /api/progress/level: accept/set 成功時のみ当日メニューキャッシュを無効化し、declineでは呼ばない", async () => {
    let invalidateCalls = 0;
    const { deps } = makeTestDeps({
      invalidateMenuCache: () => { invalidateCalls++; },
      progressStore: {
        getLevel: () => 13, getSummary: () => FAKE_SUMMARY,
        addXp: () => FAKE_SUMMARY,
        blockStart: () => ({ attemptId: 1 }),
        // テスト目的で action を問わず成功させ、accept/decline それぞれのハンドラ分岐だけを見る
        levelAction: () => FAKE_SUMMARY,
      } as RouteDeps["progressStore"],
    });
    const handler = makeFetchHandler(deps);

    const setRes = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", body: JSON.stringify({ action: "set", level: 20 }) }));
    expect(setRes.status).toBe(200);
    expect(invalidateCalls).toBe(1);

    const acceptRes = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", body: JSON.stringify({ action: "accept" }) }));
    expect(acceptRes.status).toBe(200);
    expect(invalidateCalls).toBe(2);

    const declineRes = await handler(new Request("http://localhost/api/progress/level", {
      method: "POST", body: JSON.stringify({ action: "decline" }) }));
    expect(declineRes.status).toBe(200);
    expect(invalidateCalls).toBe(2); // decline は無効化しない
  });
  test("POST /api/sentences/grade は srs-grade XP を付与する（good=2, soso=1）", async () => {
    const calls: Array<{ kind: string; amount: number }> = [];
    const { deps } = makeTestDeps({
      progressStore: {
        getLevel: () => 13, getSummary: () => FAKE_SUMMARY,
        addXp: (kind: string, amount: number) => { calls.push({ kind, amount }); return FAKE_SUMMARY; },
        blockStart: () => ({ attemptId: 1 }), levelAction: () => null,
      } as RouteDeps["progressStore"],
    });
    const handler = makeFetchHandler(deps);
    await handler(new Request("http://localhost/api/sentences/grade", {
      method: "POST", body: JSON.stringify({ no: 1, grade: "good" }) }));
    await handler(new Request("http://localhost/api/sentences/grade", {
      method: "POST", body: JSON.stringify({ no: 1, grade: "soso" }) }));
    expect(calls).toEqual([{ kind: "srs-grade", amount: 2 }, { kind: "srs-grade", amount: 1 }]);
  });
});
