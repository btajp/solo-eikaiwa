import { describe, expect, test, afterEach } from "bun:test";
import { makeClaudePrintRunner } from "../providers/claude-print";
import { TransportError } from "../providers/errors";
import { CLAUDE_PRINT_DIR } from "../paths";
import { setActiveAuthModes } from "../llm-auth-store";

/** claude -p の成功時 stdout（単一JSON）を組み立てるヘルパー。 */
const okJson = (text: string, sid = "sess-1") =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result: text, session_id: sid });

describe("makeClaudePrintRunner", () => {
  test("成功: composeなしの素プロンプト+system/model/effort/resumeが引数に乗る", async () => {
    const calls: any[] = [];
    const runner = makeClaudePrintRunner({
      model: "haiku", effort: "low", defaultSystemPrompt: "SYS", cwd: "/tmp/x",
      exec: async (a) => { calls.push(a); return okJson("hello"); },
    });
    const r = await runner("hi", "sess-9", { systemPrompt: "OVERRIDE" });
    expect(r).toEqual({ text: "hello", sessionId: "sess-1" });
    expect(calls[0]).toMatchObject({
      prompt: "hi", systemPrompt: "OVERRIDE", model: "haiku", effort: "low", resumeId: "sess-9", cwd: "/tmp/x",
    });
  });

  test("systemPrompt 未指定時は defaultSystemPrompt を使い、resumeId 未指定時は undefined のまま渡る", async () => {
    const calls: any[] = [];
    const runner = makeClaudePrintRunner({
      defaultSystemPrompt: "DEFAULT SYS",
      exec: async (a) => { calls.push(a); return okJson("x"); },
    });
    await runner("hi");
    expect(calls[0].systemPrompt).toBe("DEFAULT SYS");
    expect(calls[0].resumeId).toBeUndefined();
    expect(calls[0].model).toBeUndefined();
    expect(calls[0].effort).toBeUndefined();
  });

  test("cwd 未指定時は既定で CLAUDE_PRINT_DIR が exec に渡る（固定・mkdtemp しない）", async () => {
    const calls: any[] = [];
    const runner = makeClaudePrintRunner({
      defaultSystemPrompt: "S",
      exec: async (a) => { calls.push(a); return okJson("x"); },
    });
    await runner("hi");
    expect(calls[0].cwd).toBe(CLAUDE_PRINT_DIR);
  });

  test("subscription（既定）: bare/env とも exec に渡らない（現行どおり process.env・OAuth継承）", async () => {
    const calls: any[] = [];
    const runner = makeClaudePrintRunner({
      defaultSystemPrompt: "S",
      exec: async (a) => { calls.push(a); return okJson("x"); },
    });
    await runner("hi");
    expect(calls[0].bare).toBeUndefined();
    expect(calls[0].env).toBeUndefined();
  });

  test("is_error/subtype失敗はplain Error・JSON破損とexec throwはTransportError", async () => {
    const r1 = makeClaudePrintRunner({
      defaultSystemPrompt: "S",
      exec: async () => JSON.stringify({ subtype: "error_max_turns", is_error: true, result: "", session_id: "s" }),
    });
    await expect(r1("x")).rejects.toThrow(/error_max_turns/);
    await r1("x").catch((e) => expect(e).not.toBeInstanceOf(TransportError));

    const r2 = makeClaudePrintRunner({ defaultSystemPrompt: "S", exec: async () => "not-json" });
    await expect(r2("x")).rejects.toBeInstanceOf(TransportError);

    const r3 = makeClaudePrintRunner({
      defaultSystemPrompt: "S",
      exec: async () => { throw new TransportError("exit 1"); },
    });
    await expect(r3("x")).rejects.toBeInstanceOf(TransportError);
  });

  test("execがplain Errorをthrowした場合はそのまま透過する（TransportErrorに包み直さない）", async () => {
    const runner = makeClaudePrintRunner({
      defaultSystemPrompt: "S",
      exec: async () => { throw new Error("boom"); },
    });
    await expect(runner("x")).rejects.toThrow("boom");
    await runner("x").catch((e) => expect(e).not.toBeInstanceOf(TransportError));
  });

  test("空resultはplain Error('Claude returned empty result')", async () => {
    const runner = makeClaudePrintRunner({
      defaultSystemPrompt: "S",
      exec: async () => okJson(""),
    });
    await expect(runner("x")).rejects.toThrow("Claude returned empty result");
    await runner("x").catch((e) => expect(e).not.toBeInstanceOf(TransportError));
  });

  test("success応答なのに session_id が欠落 → TransportError（無音のresume喪失を防ぐ）", async () => {
    const runner = makeClaudePrintRunner({
      defaultSystemPrompt: "S",
      exec: async () => JSON.stringify({ subtype: "success", is_error: false, result: "ok" }),
    });
    await expect(runner("x")).rejects.toBeInstanceOf(TransportError);
    await runner("x").catch((e) => expect(e.message).toMatch(/session_id/));
  });

  test("result の前後空白は trim される", async () => {
    const runner = makeClaudePrintRunner({
      defaultSystemPrompt: "S",
      exec: async () => okJson("  hello world  \n"),
    });
    const r = await runner("hi");
    expect(r.text).toBe("hello world");
  });
});

describe("makeClaudePrintRunner: 認証モードに応じた bare/env 注入", () => {
  afterEach(() => {
    // 他テストファイルへの汚染防止（グローバルなランタイムキャッシュのため）
    setActiveAuthModes({ claude: "subscription", codex: "subscription" });
  });

  test("api-key: bare:true と ANTHROPIC_API_KEY を含む env が exec に渡る", async () => {
    setActiveAuthModes({ claude: "api-key", codex: "subscription" });
    const savedKey = Bun.env.ANTHROPIC_API_KEY;
    Bun.env.ANTHROPIC_API_KEY = "sk-test-key";
    try {
      const calls: any[] = [];
      const runner = makeClaudePrintRunner({
        defaultSystemPrompt: "S",
        exec: async (a) => { calls.push(a); return okJson("x"); },
      });
      await runner("hi");
      expect(calls[0].bare).toBe(true);
      expect(calls[0].env.ANTHROPIC_API_KEY).toBe("sk-test-key");
    } finally {
      if (savedKey === undefined) delete Bun.env.ANTHROPIC_API_KEY;
      else Bun.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});
