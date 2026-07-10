import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  converseTurn, makeClaudeRunner, PARTNER_SYSTEM_PROMPT, partnerSystemPrompt,
  resolveClaudeRunner, resolveClaudeTuning, resolveCliRunner, claudeRunner,
  resolveClaudeExecutablePath,
} from "../converse";
import { isErrorLogged, readEvents } from "../session-log";
import { TransportError } from "../providers/errors";
import { setActiveAuthModes, setActiveAuthSecrets } from "../llm-auth-store";
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

  test("SDK が最初のメッセージ前に落ちたら TransportError に包む（cause 保持）", async () => {
    const throwingQuery = (() => {
      async function* gen(): AsyncGenerator<unknown> {
        throw new Error("spawn ENOENT");
      }
      return gen();
    }) as unknown as typeof query;

    const runner = makeClaudeRunner(throwingQuery);
    await expect(runner("hi")).rejects.toBeInstanceOf(TransportError);

    let caught: unknown;
    try {
      await runner("hi");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransportError);
    expect((caught as TransportError).cause).toBeInstanceOf(Error);
    expect(((caught as TransportError).cause as Error).message).toBe("spawn ENOENT");
  });

  test("query() 自体が同期 throw した場合（ネイティブバイナリ欠損等）も TransportError に分類する", async () => {
    // 実 SDK の query() は iterator を返す前に同期バリデーションで throw しうる
    // （例: "Native CLI binary for ${platform}-${arch} not found..."）。これも transport 障害。
    const syncThrowingQuery = (() => {
      throw new Error("Native CLI binary for darwin-arm64 not found");
    }) as unknown as typeof query;

    const runner = makeClaudeRunner(syncThrowingQuery);
    let caught: unknown;
    try {
      await runner("hi");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TransportError);
    expect(((caught as TransportError).cause as Error).message).toBe(
      "Native CLI binary for darwin-arm64 not found",
    );
  });

  test("最初のメッセージ以後の失敗（result subtype エラー）は plain Error のまま（TransportError ではない）", async () => {
    const runner = makeClaudeRunner(
      fakeQuery([
        { type: "system", subtype: "init", session_id: "sess-abc" },
        { type: "result", subtype: "error_during_execution", errors: ["boom"], stop_reason: null },
      ]),
    );

    let caught: unknown;
    try {
      await runner("hi");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(TransportError);
    expect((caught as Error).message).toMatch(/Claude result error/);
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

  test("第2引数cfg.model/cfg.effort が options.model/options.effort として渡る", async () => {
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery, { model: "haiku", effort: "low" });
    await runner("hi");
    expect(calls[0].options).toMatchObject({ model: "haiku", effort: "low" });
  });

  test("cfg省略時はmodelが既定sonnet・effortキーは付かない", async () => {
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery);
    await runner("hi");
    expect(calls[0].options).toMatchObject({ model: "sonnet" });
    expect(calls[0].options).not.toHaveProperty("effort");
  });

  test("cfg.modelのみ指定時はeffortキーが付かない", async () => {
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery, { model: "opus" });
    await runner("hi");
    expect(calls[0].options).toMatchObject({ model: "opus" });
    expect(calls[0].options).not.toHaveProperty("effort");
  });

  test("cfg.claudeExecutablePath指定時はoptions.pathToClaudeCodeExecutableとして渡る（sidecarモードのSDK CLI解決注入）", async () => {
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery, { claudeExecutablePath: "/opt/homebrew/bin/claude" });
    await runner("hi");
    expect(calls[0].options).toMatchObject({ pathToClaudeCodeExecutable: "/opt/homebrew/bin/claude" });
  });

  test("cfg.claudeExecutablePath未指定時はoptionsにpathToClaudeCodeExecutableキー自体が付かない（非sidecarモードでバイト等価）", async () => {
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery);
    await runner("hi");
    expect(calls[0].options).not.toHaveProperty("pathToClaudeCodeExecutable");
  });
});

describe("resolveClaudeExecutablePath（sidecarモード判定 + Bun.which解決。TauriPhase2: compile済みバイナリではSDKの同梱CLI自己解決が壊れるため明示注入が必要）", () => {
  test("SOLO_EIKAIWA_RESOURCES_DIR未設定（dev/LaunchAgent）はwhichFnを呼ばずundefined（非sidecarモードでバイト等価）", () => {
    let whichCalls = 0;
    const result = resolveClaudeExecutablePath({}, () => { whichCalls++; return "/usr/local/bin/claude"; });
    expect(result).toBeUndefined();
    expect(whichCalls).toBe(0);
  });

  test("SOLO_EIKAIWA_RESOURCES_DIRが空白のみもundefined（overrideDirと同じtrim規約）", () => {
    const result = resolveClaudeExecutablePath({ SOLO_EIKAIWA_RESOURCES_DIR: "   " }, () => "/usr/local/bin/claude");
    expect(result).toBeUndefined();
  });

  test("sidecarモードでclaudeが見つかればその絶対パスを返す", () => {
    const result = resolveClaudeExecutablePath(
      { SOLO_EIKAIWA_RESOURCES_DIR: "/Applications/solo-eikaiwa.app/Contents/Resources" },
      (bin) => (bin === "claude" ? "/opt/homebrew/bin/claude" : null),
    );
    expect(result).toBe("/opt/homebrew/bin/claude");
  });

  test("sidecarモードでclaudeが見つからなければundefined（既存の劣化系に委ねる）", () => {
    const result = resolveClaudeExecutablePath(
      { SOLO_EIKAIWA_RESOURCES_DIR: "/Applications/solo-eikaiwa.app/Contents/Resources" },
      () => null,
    );
    expect(result).toBeUndefined();
  });
});

describe("makeClaudeRunner: 認証モードに応じた spawn env 注入", () => {
  afterEach(() => {
    // 他テストファイルへの汚染防止（グローバルなランタイムキャッシュのため）
    setActiveAuthModes({ claude: "subscription", codex: "subscription" });
    setActiveAuthSecrets({});
  });

  test("subscription（既定）: options.envを最小化してambient APIキーを継承しない", async () => {
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery);
    await runner("hi");
    expect(calls[0].options.env).toBeDefined();
    const env = calls[0].options.env as Record<string, string | undefined>;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  test("api-key: options.env に ANTHROPIC_API_KEY を含む env が渡る", async () => {
    setActiveAuthModes({ claude: "api-key", codex: "subscription" });
    setActiveAuthSecrets({ anthropic: "sk-sdk-test" });
    const { calls, fakeQuery } = capturingQuery();
    const runner = makeClaudeRunner(fakeQuery);
    await runner("hi");
    expect((calls[0].options.env as Record<string, string>).ANTHROPIC_API_KEY).toBe("sk-sdk-test");
  });
});

describe("resolveClaudeRunner（tuning が空なら module-level claudeRunner の単一参照）", () => {
  test("tuning未指定は claudeRunner と同一参照を返す", () => {
    expect(resolveClaudeRunner(undefined)).toBe(claudeRunner);
  });

  test("model/effortとも未指定のtuningオブジェクトも同一参照を返す（正規化）", () => {
    expect(resolveClaudeRunner({ model: undefined, effort: undefined })).toBe(claudeRunner);
  });

  test("複数回呼んでも同一参照（安定した単一参照＝回帰基準）", () => {
    expect(resolveClaudeRunner()).toBe(resolveClaudeRunner());
  });

  test("model/effortいずれかを指定すると claudeRunner とは別の新規合成runnerを返す", () => {
    const r = resolveClaudeRunner({ model: "haiku", effort: "low" });
    expect(r).not.toBe(claudeRunner);
    expect(typeof r).toBe("function");
  });

  test("effortのみ指定でもclaudeRunnerとは別参照になる", () => {
    const r = resolveClaudeRunner({ effort: "xhigh" });
    expect(r).not.toBe(claudeRunner);
  });
});

describe("resolveClaudeTuning（優先順位: tuning > コード既定。envチューニングは読まない）", () => {
  test("claudeModel/effortとも null（未カスタマイズ）なら undefined（resolveClaudeRunnerの単一参照トリガー）", () => {
    expect(resolveClaudeTuning({ claudeModel: null, effort: null, serviceTier: null })).toBeUndefined();
  });

  test("tuning指定はそのまま使われる", () => {
    expect(
      resolveClaudeTuning({ claudeModel: "opus", effort: "xhigh", serviceTier: null }),
    ).toEqual({ model: "opus", effort: "xhigh" });
  });

  test("model未指定はsonnetのコード既定", () => {
    expect(
      resolveClaudeTuning({ claudeModel: null, effort: "high", serviceTier: null }),
    ).toEqual({ model: "sonnet", effort: "high" });
  });

  test("effort未指定は未指定(undefined)のまま（SDK標準）", () => {
    expect(
      resolveClaudeTuning({ claudeModel: "haiku", effort: null, serviceTier: null }),
    ).toEqual({ model: "haiku", effort: undefined });
  });
});

describe("resolveCliRunner（CLI用: envプロバイダ解決 + 明示チューニング）", () => {
  test("claude解決 + 空チューニングは module-level claudeRunner と同一参照（回帰基準）", () => {
    expect(resolveCliRunner({ claudeModel: null, effort: null, serviceTier: null }, {})).toBe(claudeRunner);
  });

  test("claude解決 + チューニング指定は別参照の新規合成runnerを返す", () => {
    const r = resolveCliRunner({ claudeModel: "opus", effort: "high", serviceTier: null }, {});
    expect(r).not.toBe(claudeRunner);
    expect(typeof r).toBe("function");
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
