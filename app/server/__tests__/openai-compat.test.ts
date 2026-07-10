import { describe, expect, test } from "bun:test";
import { makeOpenAICompatRunner, warmOpenAICompat, openAICompatWarmTargetFromEnv, type OpenAICompatConfig } from "../providers/openai-compat";

type CapturedReq = { url: string; body: any; headers: Record<string, string> };

/** choices[0].message.content = reply を返すフェイク fetch。呼び出し内容を captured に記録する。 */
function fakeChatFetch(reply: string, captured: CapturedReq[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = String(v);
    captured.push({ url, body: JSON.parse(String(init.body)), headers });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: reply } }] }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function baseCfg(over: Partial<OpenAICompatConfig> = {}): OpenAICompatConfig {
  return {
    baseUrl: "http://localhost:11434/v1",
    model: "test-model",
    defaultSystemPrompt: "DEFAULT SYS",
    fetchFn: fakeChatFetch("hi there", []),
    ...over,
  };
}

describe("makeOpenAICompatRunner", () => {
  test("初回ターン: /chat/completions を叩き、system+user を送り、text と非空 sessionId を返す", async () => {
    const captured: CapturedReq[] = [];
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: fakeChatFetch("hi there", captured) }));

    const r = await runner("Hello", undefined, { systemPrompt: "PARTNER SYS" });

    expect(r.text).toBe("hi there");
    expect(r.sessionId).toBeTruthy();
    expect(captured[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(captured[0].body.model).toBe("test-model");
    expect(captured[0].body.messages).toEqual([
      { role: "system", content: "PARTNER SYS" },
      { role: "user", content: "Hello" },
    ]);
  });

  test("systemPrompt 未指定時は defaultSystemPrompt を使う", async () => {
    const captured: CapturedReq[] = [];
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: fakeChatFetch("x", captured) }));
    await runner("Hello");
    expect(captured[0].body.messages[0]).toEqual({ role: "system", content: "DEFAULT SYS" });
  });

  test("resume: 返ってきた sessionId を渡すと直前の user/assistant が履歴として送られる", async () => {
    const captured: CapturedReq[] = [];
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: fakeChatFetch("reply-1", captured) }));
    const first = await runner("turn one", undefined, { systemPrompt: "S" });
    await runner("turn two", first.sessionId, { systemPrompt: "S" });

    expect(captured[1].body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "turn one" },
      { role: "assistant", content: "reply-1" },
      { role: "user", content: "turn two" },
    ]);
  });

  test("resume miss: 未知の sessionId は履歴なしの新セッションになり、新しい id を返す", async () => {
    const captured: CapturedReq[] = [];
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: fakeChatFetch("y", captured) }));
    const r = await runner("hi", "nonexistent-session", { systemPrompt: "S" });
    expect(r.sessionId).not.toBe("nonexistent-session");
    expect(captured[0].body.messages).toEqual([
      { role: "system", content: "S" },
      { role: "user", content: "hi" },
    ]);
  });

  test("apiKey あり: Authorization ヘッダを付ける / なし: 付けない", async () => {
    const withKey: CapturedReq[] = [];
    await makeOpenAICompatRunner(baseCfg({ apiKey: "sk-test", fetchFn: fakeChatFetch("z", withKey) }))("hi");
    expect(withKey[0].headers["authorization"]).toBe("Bearer sk-test");

    const noKey: CapturedReq[] = [];
    await makeOpenAICompatRunner(baseCfg({ fetchFn: fakeChatFetch("z", noKey) }))("hi");
    expect(noKey[0].headers["authorization"]).toBeUndefined();
  });

  test("baseUrl 末尾スラッシュを正規化する", async () => {
    const captured: CapturedReq[] = [];
    const runner = makeOpenAICompatRunner(baseCfg({ baseUrl: "http://localhost:1234/v1/", fetchFn: fakeChatFetch("z", captured) }));
    await runner("hi");
    expect(captured[0].url).toBe("http://localhost:1234/v1/chat/completions");
  });

  test("非2xx応答: ステータスを含めて throw する", async () => {
    const badFetch = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: badFetch }));
    await expect(runner("hi")).rejects.toThrow(/500/);
  });

  test("空 content: empty で throw する", async () => {
    const emptyFetch = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 })) as unknown as typeof fetch;
    const runner = makeOpenAICompatRunner(baseCfg({ fetchFn: emptyFetch }));
    await expect(runner("hi")).rejects.toThrow(/empty/i);
  });
});

describe("warmOpenAICompat", () => {
  test("max_tokens=1 の極小 completion を /chat/completions に POST（baseUrl 正規化・apiKey で Authorization）", async () => {
    const calls: CapturedReq[] = [];
    await warmOpenAICompat({ baseUrl: "http://localhost:11434/v1/", apiKey: "sk-x", model: "m" }, fakeChatFetch("x", calls));
    expect(calls[0].url).toBe("http://localhost:11434/v1/chat/completions");
    expect(calls[0].body.model).toBe("m");
    expect(calls[0].body.max_tokens).toBe(1);
    expect(calls[0].headers["authorization"]).toBe("Bearer sk-x");
  });

  test("apiKey なし: Authorization を付けない", async () => {
    const calls: CapturedReq[] = [];
    await warmOpenAICompat({ baseUrl: "http://localhost:11434/v1", model: "m" }, fakeChatFetch("x", calls));
    expect(calls[0].headers["authorization"]).toBeUndefined();
  });

  test("非2xx は throw する（呼び出し側の warn に回す）", async () => {
    const badFetch = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(warmOpenAICompat({ baseUrl: "http://localhost/v1", model: "m" }, badFetch)).rejects.toThrow(/500/);
  });
});

describe("openAICompatWarmTargetFromEnv", () => {
  test("openai-compat + 必須値ありで config を返す", () => {
    expect(openAICompatWarmTargetFromEnv({
      LLM_PROVIDER: "openai-compat",
      OPENAI_COMPAT_BASE_URL: "http://localhost:11434/v1",
      OPENAI_COMPAT_MODEL: "m",
      OPENAI_COMPAT_API_KEY: "sk",
    })).toEqual({ baseUrl: "http://localhost:11434/v1", apiKey: "sk", model: "m" });
  });

  test("claude/codex/値欠落は null（warm しない）", () => {
    expect(openAICompatWarmTargetFromEnv({ LLM_PROVIDER: "claude" })).toBeNull();
    expect(openAICompatWarmTargetFromEnv({ LLM_PROVIDER: "codex" })).toBeNull();
    expect(openAICompatWarmTargetFromEnv({ LLM_PROVIDER: "openai-compat", OPENAI_COMPAT_BASE_URL: "http://localhost/v1" })).toBeNull();
  });
});
