import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { converseTurn, makeClaudeRunner, PARTNER_SYSTEM_PROMPT, partnerSystemPrompt } from "../converse";
import { isErrorLogged, readEvents } from "../session-log";
import type { query } from "@anthropic-ai/claude-agent-sdk";

// Minimal fake message shapes; only the fields defaultRunner actually reads are populated.
function fakeQuery(messages: unknown[]): typeof query {
  return (() => {
    async function* gen() {
      for (const m of messages) yield m;
    }
    return gen();
  }) as unknown as typeof query;
}

describe("converse", () => {
  test("初回ターン: resume無しで runner を呼び、2イベントをログし、sessionId を返す", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "conv-"));
    const logFile = path.join(dir, "log.jsonl");
    const calls: Array<{ prompt: string; resumeId?: string }> = [];
    const fakeRunner = async (prompt: string, resumeId?: string) => {
      calls.push({ prompt, resumeId });
      return { text: "Nice to meet you!", sessionId: "claude-sess-1" };
    };

    const r = await converseTurn({ userText: "Hi, I am Shin.", runner: fakeRunner, logFile });

    expect(r.replyText).toBe("Nice to meet you!");
    expect(r.sessionId).toBe("claude-sess-1");
    expect(calls[0].resumeId).toBeUndefined();
    expect(calls[0].prompt).toContain("Hi, I am Shin.");

    const events = readEvents(logFile);
    expect(events.map((e) => e.type)).toEqual(["user_utterance", "assistant_reply"]);
    expect(events[1].text).toBe("Nice to meet you!");
  });

  test("2ターン目: 前回の sessionId を resume として渡す", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "conv-"));
    const logFile = path.join(dir, "log.jsonl");
    const calls: Array<{ resumeId?: string }> = [];
    const fakeRunner = async (_prompt: string, resumeId?: string) => {
      calls.push({ resumeId });
      return { text: "ok", sessionId: "claude-sess-1" };
    };

    await converseTurn({ userText: "second turn", sessionId: "claude-sess-1", runner: fakeRunner, logFile });
    expect(calls[0].resumeId).toBe("claude-sess-1");
  });
});

describe("makeClaudeRunner", () => {
  test("成功ストリーム: init で session_id を捕捉し、success の result を返す", async () => {
    const runner = makeClaudeRunner(
      fakeQuery([
        { type: "system", subtype: "init", session_id: "sess-abc" },
        { type: "result", subtype: "success", result: "Hello there!" },
      ]),
    );

    const r = await runner("hi");
    expect(r).toEqual({ text: "Hello there!", sessionId: "sess-abc" });
  });

  test("エラーサブタイプの result: errors 詳細を含めて reject する", async () => {
    const runner = makeClaudeRunner(
      fakeQuery([
        { type: "system", subtype: "init", session_id: "sess-abc" },
        { type: "result", subtype: "error_during_execution", errors: ["boom"], stop_reason: null },
      ]),
    );

    await expect(runner("hi")).rejects.toThrow(/error_during_execution/);
  });

  test("result が一度も来ないストリーム: empty で reject する", async () => {
    const runner = makeClaudeRunner(
      fakeQuery([{ type: "system", subtype: "init", session_id: "sess-abc" }]),
    );

    await expect(runner("hi")).rejects.toThrow(/empty/);
  });
});

describe("converseTurn error path", () => {
  test("runner が throw した場合: converseTurn も reject し、ログに user_utterance と error が残る", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "conv-"));
    const logFile = path.join(dir, "log.jsonl");
    const failingRunner = async (): Promise<{ text: string; sessionId: string }> => {
      throw new Error("boom from runner");
    };

    await expect(
      converseTurn({ userText: "hello", runner: failingRunner, logFile }),
    ).rejects.toThrow("boom from runner");

    const events = readEvents(logFile);
    expect(events.map((e) => e.type)).toEqual(["user_utterance", "error"]);
    expect(events[1].text).toBe("boom from runner");
  });

  test("converseTurn が記録した error は isErrorLogged マーカーが付く", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "conv-"));
    const logFile = path.join(dir, "log.jsonl");
    const failingRunner = async () => { throw new Error("runner down"); };
    let caught: unknown;
    try {
      await converseTurn({ userText: "hi", runner: failingRunner, logFile });
    } catch (err) {
      caught = err;
    }
    expect(isErrorLogged(caught)).toBe(true);
  });
});

function capturingQuery() {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const fakeQuery = ((args: { prompt: string; options: Record<string, unknown> }) => {
    calls.push(args);
    return (async function* () {
      yield { type: "system", subtype: "init", session_id: "sess-x" };
      yield { type: "result", subtype: "success", result: "ok" };
    })();
  }) as unknown as typeof query;
  return { calls, fakeQuery };
}

describe("makeClaudeRunner: SDK呼び出し引数のパススルー", () => {
  test("初回ターン: resume なし・規定オプションが query に渡る", async () => {
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery);
    await runner("first turn");
    expect(calls[0].prompt).toBe("first turn");
    expect(calls[0].options).not.toHaveProperty("resume");
    expect(calls[0].options).toMatchObject({
      systemPrompt: PARTNER_SYSTEM_PROMPT,
      model: "sonnet",
      tools: [],
      maxTurns: 1,
    });
  });

  test("2ターン目: resumeId が options.resume として渡る", async () => {
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery);
    await runner("second turn", "sess-x");
    expect(calls[0].options).toMatchObject({ resume: "sess-x" });
  });
});

test("makeClaudeRunner: 第3引数の systemPrompt が options に渡る", async () => {
  const { calls, fakeQuery } = capturingQuery();
  const runner = makeClaudeRunner(fakeQuery);
  await runner("prompt", undefined, { systemPrompt: "CUSTOM PROMPT" });
  expect(calls[0].options).toMatchObject({ systemPrompt: "CUSTOM PROMPT" });
});

test("converseTurn: systemPromptOverride が runner の第3引数に渡る", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "conv-"));
  const logFile = path.join(dir, "log.jsonl");
  const seen: Array<{ prompt: string; resumeId?: string; opts?: { systemPrompt?: string } }> = [];
  const fakeRunner = async (prompt: string, resumeId?: string, opts?: { systemPrompt?: string }) => {
    seen.push({ prompt, resumeId, opts });
    return { text: "ok", sessionId: "s1" };
  };
  await converseTurn({ userText: "hi", runner: fakeRunner, logFile, systemPromptOverride: "ROLEPLAY" });
  expect(seen[0].opts).toEqual({ systemPrompt: "ROLEPLAY" });
});

describe("partnerSystemPrompt", () => {
  test("低ステージ(1〜3)は高頻度語彙制約(word families)を課す", () => {
    const p = partnerSystemPrompt(2);
    expect(p).toContain("word families");
    expect(p).not.toContain("B1 level");
    expect(p).toContain("Never switch to Japanese");
  });

  test("stage 4+ は従来の B1 目安を維持する", () => {
    const p = partnerSystemPrompt(5);
    expect(p).toContain("B1 level");
    expect(p).not.toContain("word families");
  });

  test("PARTNER_SYSTEM_PROMPT はフォールバック既定として存在し続ける", () => {
    expect(PARTNER_SYSTEM_PROMPT).toBe(partnerSystemPrompt(1));
  });
});
