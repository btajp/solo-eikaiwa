import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { FAKE_AE, FAKE_REFLECTION, makeFakeTalkExplainCache, makeTestDeps } from "./helpers/route-deps";
import { postJson } from "./helpers/http";

describe("routes: coach", () => {
  test("POST /api/feedback/ae: 正常系とtranscript空400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(postJson("/api/feedback/ae", { transcript: "I go yesterday", topicTitle: "My week" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      ...FAKE_AE,
      collectedChunks: 0,
      collectedChunkItems: [],
      collectedChunkStatus: "none",
    });
    const bad = await handler(postJson("/api/feedback/ae", { topicTitle: "x" }));
    expect(bad.status).toBe(400);
  });

  test("POST /api/coach/model-talk: 既知ID 200 / 欠落400 / 未知404", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const ok = await handler(postJson("/api/coach/model-talk", { topicId: "known-topic" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ text: "model talk" });
    const missing = await handler(postJson("/api/coach/model-talk", {}));
    expect(missing.status).toBe(400);
    const unknown = await handler(postJson("/api/coach/model-talk", { topicId: "nope" }));
    expect(unknown.status).toBe(404);
  });

  test("POST /api/coach/reflection は Reflection を返す", async () => {
    let seenSessionId: string | undefined;
    const { deps } = makeTestDeps({
      reflection: async (sessionId) => {
        seenSessionId = sessionId;
        return FAKE_REFLECTION;
      },
    });
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/coach/reflection", { sessionId: "practice-session-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ...FAKE_REFLECTION,
      collectedChunks: 0,
      collectedChunkItems: [],
      collectedChunkStatus: "none",
    });
    expect(seenSessionId).toBe("practice-session-1");
    expect((await handler(postJson("/api/coach/reflection", {}))).status).toBe(400);
  });
});

describe("routes: coach/prep", () => {
  test("topicId欠落は400", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/coach/prep", {}));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("topicId");
  });

  test("未知のtopicIdは404", async () => {
    const { deps } = makeTestDeps({ prepPack: async () => null });
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/coach/prep", { topicId: "nope" }));
    expect(res.status).toBe(404);
  });

  test("正常系はPrepPackを返す", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(postJson("/api/coach/prep", { topicId: "zero-trust" }));
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

describe("routes: モデルトーク解説", () => {
  test("POST /api/coach/talk-explain は生成して返しハッシュキーで保存する", async () => {
    const saved: Array<{ hash: string; text: string }> = [];
    let generateCalls = 0;
    const { deps } = makeTestDeps({
      explainTalk: async () => { generateCalls++; return { text: "日本語訳: 訳文\n\n表現ポイント:\n- a — b" }; },
      talkExplainCache: makeFakeTalkExplainCache({
        get: () => null,
        save: (hash, text) => { saved.push({ hash, text }); },
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/talk-explain", { text: "I usually start my day with coffee." }));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toContain("日本語訳");
    expect(generateCalls).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("POST /api/coach/talk-explain はキャッシュ命中時に生成しない", async () => {
    let generateCalls = 0;
    const { deps } = makeTestDeps({
      explainTalk: async () => { generateCalls++; return { text: "x" }; },
      talkExplainCache: makeFakeTalkExplainCache({
        get: () => "キャッシュ済み訳と解説",
        save: () => { throw new Error("must not save on cache hit"); },
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/talk-explain", { text: "Any talk text." }));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("キャッシュ済み訳と解説");
    expect(generateCalls).toBe(0);
  });

  test("POST /api/coach/talk-explain は空文字・過長テキストに 400", async () => {
    const handler = makeFetchHandler(makeTestDeps().deps);
    const empty = await handler(postJson("/api/coach/talk-explain", { text: "  " }));
    expect(empty.status).toBe(400);
    const tooLong = await handler(postJson("/api/coach/talk-explain", { text: "a".repeat(3001) }));
    expect(tooLong.status).toBe(400);
  });

  test("POST /api/coach/talk-explain は空生成を 502 にしキャッシュしない", async () => {
    let saved = 0;
    const { deps } = makeTestDeps({
      explainTalk: async () => ({ text: "   " }),
      talkExplainCache: makeFakeTalkExplainCache({ get: () => null, save: () => { saved++; } }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/talk-explain", { text: "Some talk text." }));
    expect(res.status).toBe(502);
    expect(saved).toBe(0);
  });
});

describe("routes: AI発話の訳（translate）", () => {
  test("POST /api/coach/translate は訳を生成して返しハッシュキーで保存する", async () => {
    const saved: Array<{ hash: string; text: string }> = [];
    let generateCalls = 0;
    const { deps } = makeTestDeps({
      translate: async () => { generateCalls++; return { text: "私はたいていコーヒーで一日を始めます。" }; },
      translationCache: makeFakeTalkExplainCache({
        get: () => null,
        save: (hash, text) => { saved.push({ hash, text }); },
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/translate", { text: "I usually start my day with coffee." }));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("私はたいていコーヒーで一日を始めます。");
    expect(generateCalls).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("POST /api/coach/translate はキャッシュ命中時に生成しない", async () => {
    let generateCalls = 0;
    const { deps } = makeTestDeps({
      translate: async () => { generateCalls++; return { text: "x" }; },
      translationCache: makeFakeTalkExplainCache({
        get: () => "キャッシュ済みの訳",
        save: () => { throw new Error("must not save on cache hit"); },
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/translate", { text: "Any line." }));
    expect(res.status).toBe(200);
    expect((await res.json()).text).toBe("キャッシュ済みの訳");
    expect(generateCalls).toBe(0);
  });

  test("POST /api/coach/translate は空文字・過長テキストに 400", async () => {
    const handler = makeFetchHandler(makeTestDeps().deps);
    const empty = await handler(postJson("/api/coach/translate", { text: "  " }));
    expect(empty.status).toBe(400);
    const tooLong = await handler(postJson("/api/coach/translate", { text: "a".repeat(3001) }));
    expect(tooLong.status).toBe(400);
  });

  test("POST /api/coach/translate は空生成を 502 にしキャッシュしない", async () => {
    let saved = 0;
    const { deps } = makeTestDeps({
      translate: async () => ({ text: "" }),
      translationCache: makeFakeTalkExplainCache({ get: () => null, save: () => { saved++; } }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/translate", { text: "Any line." }));
    expect(res.status).toBe(502);
    expect(saved).toBe(0);
  });

  test("POST /api/coach/translate は過去に保存された空キャッシュを miss 扱いで再生成し上書きする", async () => {
    const saved: Array<{ hash: string; text: string }> = [];
    let generateCalls = 0;
    const { deps } = makeTestDeps({
      translate: async () => { generateCalls++; return { text: "正しい訳です。" }; },
      translationCache: makeFakeTalkExplainCache({
        get: () => "", // 502保護導入前に保存された空エントリを想定
        save: (hash, text) => { saved.push({ hash, text }); },
      }),
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/translate", { text: "Any line." }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "正しい訳です。" });
    expect(generateCalls).toBe(1); // 空キャッシュでは生成をスキップしない
    expect(saved).toHaveLength(1); // UPSERT で空エントリが上書きされる（自己修復）
  });
});

describe("routes: 言い方ヒント（phrase-hint）", () => {
  test("POST /api/coach/phrase-hint は suggestions を返す", async () => {
    let receivedJa = "";
    let receivedHistoryLen = -1;
    const { deps } = makeTestDeps({
      phraseHint: async (args) => {
        receivedJa = args.jaText;
        receivedHistoryLen = args.history?.length ?? -1;
        return { suggestions: [
          { en: "I haven't tried that feature yet.", ja: "まだ試していない、の言い方" },
          { en: "That's still on my to-do list.", ja: "これからやる予定、のニュアンス" },
        ] };
      },
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/phrase-hint", {
      jaText: "その機能はまだ試していません",
      history: [{ role: "ai", text: "Have you tried the new dashboard?" }],
    }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { suggestions: Array<{ en: string; ja: string }> };
    expect(body.suggestions).toHaveLength(2);
    expect(body.suggestions[0].en).toContain("tried");
    expect(receivedJa).toBe("その機能はまだ試していません");
    expect(receivedHistoryLen).toBe(1);
  });

  test("POST /api/coach/phrase-hint は history 省略でも 200", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(postJson("/api/coach/phrase-hint", { jaText: "少し考える時間をください" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { suggestions: unknown[] }).suggestions.length).toBeGreaterThan(0);
  });

  test("POST /api/coach/phrase-hint は jaText 空・過長で 400", async () => {
    const handler = makeFetchHandler(makeTestDeps().deps);
    const empty = await handler(postJson("/api/coach/phrase-hint", { jaText: "  " }));
    expect(empty.status).toBe(400);
    const tooLong = await handler(postJson("/api/coach/phrase-hint", { jaText: "あ".repeat(1001) }));
    expect(tooLong.status).toBe(400);
  });

  test("POST /api/coach/phrase-hint は不正な history 要素を除外して渡す", async () => {
    let receivedHistoryLen = -1;
    const { deps } = makeTestDeps({
      phraseHint: async (args) => { receivedHistoryLen = args.history?.length ?? -1; return { suggestions: [{ en: "ok", ja: "" }] }; },
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/phrase-hint", {
      jaText: "はい",
      history: [
        { role: "you", text: "Hello" },
        { role: "bogus", text: "drop me" },
        { role: "ai", text: "Hi there" },
        { text: "no role" },
      ],
    }));
    expect(res.status).toBe(200);
    expect(receivedHistoryLen).toBe(2);
  });

  test("POST /api/coach/phrase-hint は history の各 text を500字に切り詰める", async () => {
    let receivedLen = -1;
    const { deps } = makeTestDeps({
      phraseHint: async (args) => { receivedLen = args.history?.[0]?.text.length ?? -1; return { suggestions: [{ en: "ok", ja: "" }] }; },
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/phrase-hint", { jaText: "はい", history: [{ role: "ai", text: "a".repeat(1200) }] }));
    expect(res.status).toBe(200);
    expect(receivedLen).toBe(500);
  });
});

describe("routes: 訂正の詳しい解説（fix-explain）", () => {
  test("POST /api/coach/fix-explain は解説テキストを返し original/note を渡す", async () => {
    let received: { original: string; better: string; note?: string } | undefined;
    const { deps } = makeTestDeps({
      fixExplain: async (args) => { received = args; return { text: "過去の出来事は went を使います。" }; },
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/fix-explain", { original: "I go yesterday", better: "I went yesterday", note: "past tense" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { text: string }).text).toContain("went");
    expect(received?.original).toBe("I go yesterday");
    expect(received?.note).toBe("past tense");
  });

  test("POST /api/coach/fix-explain は original/better が空で 400", async () => {
    const handler = makeFetchHandler(makeTestDeps().deps);
    const noOriginal = await handler(postJson("/api/coach/fix-explain", { better: "x" }));
    expect(noOriginal.status).toBe(400);
    const noBetter = await handler(postJson("/api/coach/fix-explain", { original: "x" }));
    expect(noBetter.status).toBe(400);
  });

  test("POST /api/coach/fix-explain は original/better の過長テキストに 400", async () => {
    const handler = makeFetchHandler(makeTestDeps().deps);
    const longOriginal = await handler(postJson("/api/coach/fix-explain", { original: "a".repeat(2001), better: "b" }));
    expect(longOriginal.status).toBe(400);
    const longBetter = await handler(postJson("/api/coach/fix-explain", { original: "a", better: "b".repeat(2001) }));
    expect(longBetter.status).toBe(400);
  });

  test("POST /api/coach/fix-explain は note を500字に切り詰める", async () => {
    let receivedLen = -1;
    const { deps } = makeTestDeps({
      fixExplain: async (args) => { receivedLen = args.note?.length ?? -1; return { text: "ok" }; },
    });
    const res = await makeFetchHandler(deps)(postJson("/api/coach/fix-explain", { original: "a", better: "b", note: "n".repeat(1200) }));
    expect(res.status).toBe(200);
    expect(receivedLen).toBe(500);
  });
});

describe("routes: coach + AbortSignal 伝播（#189）", () => {
  /** signal付きJSON POSTリクエスト */
  function postJsonWithSignal(path: string, body: unknown, signal: AbortSignal): Request {
    return new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  test("POST /api/feedback/ae は req.signal を deps.aeFeedback へ渡す", async () => {
    let captured: AbortSignal | undefined;
    const { deps } = makeTestDeps({
      aeFeedback: async (args) => {
        captured = args.signal;
        return FAKE_AE;
      },
    });
    const ac = new AbortController();
    const res = await makeFetchHandler(deps)(
      postJsonWithSignal("/api/feedback/ae", { transcript: "I go yesterday", topicTitle: "t" }, ac.signal),
    );
    expect(res.status).toBe(200);
    expect(captured).toBeDefined();
    ac.abort();
    expect(captured!.aborted).toBe(true);
  });

  test("POST /api/coach/reflection は req.signal を deps.reflection へ渡す", async () => {
    let captured: AbortSignal | undefined;
    const { deps } = makeTestDeps({
      reflection: async (_sessionId, signal) => {
        captured = signal;
        return FAKE_REFLECTION;
      },
    });
    const ac = new AbortController();
    const res = await makeFetchHandler(deps)(
      postJsonWithSignal("/api/coach/reflection", { sessionId: "sess-1" }, ac.signal),
    );
    expect(res.status).toBe(200);
    expect(captured).toBeDefined();
    ac.abort();
    expect(captured!.aborted).toBe(true);
  });

  test("POST /api/coach/translate は req.signal を deps.translate へ渡す（キャッシュmiss時）", async () => {
    let captured: AbortSignal | undefined;
    const { deps } = makeTestDeps({
      translationCache: makeFakeTalkExplainCache(),
      translate: async (_text, signal) => {
        captured = signal;
        return { text: "訳" };
      },
    });
    const ac = new AbortController();
    const res = await makeFetchHandler(deps)(
      postJsonWithSignal("/api/coach/translate", { text: "hello" }, ac.signal),
    );
    expect(res.status).toBe(200);
    expect(captured).toBeDefined();
    ac.abort();
    expect(captured!.aborted).toBe(true);
  });

  test("POST /api/coach/phrase-hint は req.signal を deps.phraseHint へ渡す", async () => {
    let captured: AbortSignal | undefined;
    const { deps } = makeTestDeps({
      phraseHint: async (args) => {
        captured = args.signal;
        return { suggestions: [{ en: "One moment.", ja: "少し待って" }] };
      },
    });
    const ac = new AbortController();
    const res = await makeFetchHandler(deps)(
      postJsonWithSignal("/api/coach/phrase-hint", { jaText: "少し待って" }, ac.signal),
    );
    expect(res.status).toBe(200);
    expect(captured).toBeDefined();
    ac.abort();
    expect(captured!.aborted).toBe(true);
  });
});
