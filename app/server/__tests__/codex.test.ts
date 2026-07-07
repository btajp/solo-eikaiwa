import { describe, expect, test } from "bun:test";
import { composeCodexPrompt, makeCodexRunner, type CodexConfig, type CodexExec } from "../providers/codex";

describe("composeCodexPrompt", () => {
  test("履歴なし: system と最終 user プロンプトを含み、会話ブロックは出さない", () => {
    const out = composeCodexPrompt("SYS", [], "hello");
    expect(out).toContain("SYS");
    expect(out).toContain("hello");
    expect(out).not.toContain("CONVERSATION SO FAR");
  });

  test("履歴あり: 過去の User/Assistant を会話ブロックに順序どおり畳む", () => {
    const out = composeCodexPrompt("SYS", [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
    ], "q2");
    expect(out).toContain("CONVERSATION SO FAR");
    const iUser = out.indexOf("q1");
    const iAsst = out.indexOf("a1");
    const iNew = out.indexOf("q2");
    expect(iUser).toBeGreaterThanOrEqual(0);
    expect(iAsst).toBeGreaterThan(iUser);
    expect(iNew).toBeGreaterThan(iAsst);
  });
});

/** exec 呼び出しを記録し、canned テキストを返すフェイク。 */
function fakeExec(reply: string, seen: Array<{ prompt: string; model?: string; cwd: string }>): CodexExec {
  return async (args) => {
    seen.push(args);
    return reply;
  };
}

function baseCfg(over: Partial<CodexConfig> = {}): CodexConfig {
  return { defaultSystemPrompt: "DEFAULT SYS", exec: fakeExec("codex reply", []), ...over };
}

describe("makeCodexRunner", () => {
  test("初回ターン: composed プロンプトに system と user を含めて exec し、text と非空 sessionId を返す", async () => {
    const seen: Array<{ prompt: string; model?: string; cwd: string }> = [];
    const runner = makeCodexRunner(baseCfg({ exec: fakeExec("codex reply", seen), model: "gpt-5.5" }));

    const r = await runner("Hello there", undefined, { systemPrompt: "PARTNER SYS" });

    expect(r.text).toBe("codex reply");
    expect(r.sessionId).toBeTruthy();
    expect(seen[0].prompt).toContain("PARTNER SYS");
    expect(seen[0].prompt).toContain("Hello there");
    expect(seen[0].model).toBe("gpt-5.5");
  });

  test("systemPrompt 未指定時は defaultSystemPrompt を composed に使う", async () => {
    const seen: Array<{ prompt: string; model?: string; cwd: string }> = [];
    const runner = makeCodexRunner(baseCfg({ exec: fakeExec("x", seen) }));
    await runner("hi");
    expect(seen[0].prompt).toContain("DEFAULT SYS");
  });

  test("resume: 返った sessionId で再呼び出しすると過去の往復が composed に入る", async () => {
    const seen: Array<{ prompt: string; model?: string; cwd: string }> = [];
    const runner = makeCodexRunner(baseCfg({ exec: fakeExec("reply-1", seen) }));
    const first = await runner("turn one", undefined, { systemPrompt: "S" });
    await runner("turn two", first.sessionId, { systemPrompt: "S" });

    expect(seen[1].prompt).toContain("turn one");
    expect(seen[1].prompt).toContain("reply-1");
    expect(seen[1].prompt).toContain("turn two");
  });

  test("空出力: empty で throw する", async () => {
    const runner = makeCodexRunner(baseCfg({ exec: fakeExec("   ", []) }));
    await expect(runner("hi")).rejects.toThrow(/empty/i);
  });
});
