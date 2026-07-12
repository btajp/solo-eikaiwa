import { describe, expect, test } from "bun:test";
import { checkHealth } from "../health";
import pkg from "../../package.json";
import type { LlmSettings } from "../llm-provider";

describe("health", () => {
  test("全依存が揃っていれば ok=true", () => {
    const h = checkHealth({
      whichFn: () => "/opt/homebrew/bin/x",
      env: { OPENAI_API_KEY: "sk-test" },
      modelExists: () => true,
    });
    expect(h).toEqual({
      ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: true,
      app: "solo-eikaiwa", version: pkg.version, llmReady: true,
    });
  });

  test("app/version は sidecar の身元確認用に常に additive で付く", () => {
    const h = checkHealth({ whichFn: () => null, env: {}, modelExists: () => false });
    expect(h.app).toBe("solo-eikaiwa");
    expect(h.version).toBe(pkg.version);
    expect(typeof h.version).toBe("string");
    expect(h.version.length).toBeGreaterThan(0);
  });

  test("desktop sidecar の識別情報は4項目が揃った時だけ返す", () => {
    const env = {
      SOLO_EIKAIWA_SIDECAR_PROTOCOL: "1",
      SOLO_EIKAIWA_SIDECAR_BUILD_ID: "d".repeat(64),
      SOLO_EIKAIWA_DATA_ROOT_ID: "a".repeat(64),
      SOLO_EIKAIWA_SIDECAR_INSTANCE_ID: "0123456789abcdef0123456789abcdef",
    };
    const h = checkHealth({ whichFn: () => null, env, modelExists: () => false });
    expect(h.sidecar).toEqual({
      protocol: 1,
      buildId: env.SOLO_EIKAIWA_SIDECAR_BUILD_ID,
      dataRootId: env.SOLO_EIKAIWA_DATA_ROOT_ID,
      instanceId: env.SOLO_EIKAIWA_SIDECAR_INSTANCE_ID,
    });
  });

  test("識別情報が一部欠落・protocol不正ならsidecarを名乗らない", () => {
    const base = {
      SOLO_EIKAIWA_SIDECAR_PROTOCOL: "1",
      SOLO_EIKAIWA_SIDECAR_BUILD_ID: "build",
      SOLO_EIKAIWA_DATA_ROOT_ID: "root",
      SOLO_EIKAIWA_SIDECAR_INSTANCE_ID: "instance",
    };
    expect(checkHealth({ whichFn: () => null, env: { ...base, SOLO_EIKAIWA_DATA_ROOT_ID: "" }, modelExists: () => false }).sidecar).toBeUndefined();
    expect(checkHealth({ whichFn: () => null, env: { ...base, SOLO_EIKAIWA_SIDECAR_PROTOCOL: "2" }, modelExists: () => false }).sidecar).toBeUndefined();
    expect(checkHealth({
      whichFn: () => null,
      env: {
        ...base,
        SOLO_EIKAIWA_SIDECAR_BUILD_ID: "not-a-binary-sha256",
        SOLO_EIKAIWA_DATA_ROOT_ID: "a".repeat(64),
        SOLO_EIKAIWA_SIDECAR_INSTANCE_ID: "b".repeat(32),
      },
      modelExists: () => false,
    }).sidecar).toBeUndefined();
  });

  test("healthにはデータ領域の生パスを返さない", () => {
    const rawPath = "/Users/private/Library/Application Support/solo-eikaiwa";
    const h = checkHealth({
      whichFn: () => null,
      env: {
        SOLO_EIKAIWA_DATA_DIR: rawPath,
        SOLO_EIKAIWA_SIDECAR_PROTOCOL: "1",
        SOLO_EIKAIWA_SIDECAR_BUILD_ID: "d".repeat(64),
        SOLO_EIKAIWA_DATA_ROOT_ID: "b".repeat(64),
        SOLO_EIKAIWA_SIDECAR_INSTANCE_ID: "c".repeat(32),
      },
      modelExists: () => false,
    });
    expect(JSON.stringify(h)).not.toContain(rawPath);
  });

  test("ttsKey が無くても ok は true（say フォールバックがあるため）", () => {
    const h = checkHealth({ whichFn: () => "/bin/x", env: {}, modelExists: () => true });
    expect(h.ttsKey).toBe(false);
    expect(h.ok).toBe(true);
  });

  test("TTS_API_KEYだけの構成もttsKey=trueとして認識する", () => {
    const h = checkHealth({ whichFn: () => "/bin/x", env: { TTS_API_KEY: "sk-tts" }, modelExists: () => true });
    expect(h.ttsKey).toBe(true);
  });

  test("whisper が無いと ok=false", () => {
    const h = checkHealth({
      whichFn: (bin) => (bin.startsWith("whisper") ? null : "/bin/x"),
      env: {},
      modelExists: () => true,
    });
    expect(h.whisper).toBe(false);
    expect(h.ok).toBe(false);
  });
});

describe("health.llmReady（claude/codex/openai-compatのいずれかが実際に使えるかの集約判定。health.claude単体だと local-only/codex-only構成で偽陽性の「LLM未導入」通知が出るため追加）", () => {
  test("claudeのみ利用可能 → llmReady=true", () => {
    const h = checkHealth({
      whichFn: (bin) => (bin === "claude" ? "/bin/claude" : null),
      env: {}, modelExists: () => true,
    });
    expect(h.llmReady).toBe(true);
  });

  test("codexのみ利用可能（claudeもopenai-compatも無し） → llmReady=true", () => {
    const h = checkHealth({
      whichFn: (bin) => (bin === "codex" ? "/bin/codex" : null),
      env: {}, modelExists: () => true,
    });
    expect(h.llmReady).toBe(true);
  });

  test("openai-compatのみ設定済み（DB設定・claude/codexとも無し） → llmReady=true", () => {
    const settings: LlmSettings = { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null };
    const h = checkHealth({ whichFn: () => null, env: {}, modelExists: () => true, llmSettings: settings });
    expect(h.llmReady).toBe(true);
  });

  test("OpenAI公式のみ設定済み（モデル+専用キー） → llmReady=true", () => {
    const settings: LlmSettings = {
      provider: "openai", baseUrl: null, model: null, openaiModel: "gpt-4.1-mini", codexModel: null,
    };
    const h = checkHealth({
      whichFn: () => null,
      env: { OPENAI_API_KEY: "sk-openai" },
      modelExists: () => true,
      llmSettings: settings,
    });
    expect(h.llmReady).toBe(true);
  });

  test("いずれも無し → llmReady=false", () => {
    const h = checkHealth({ whichFn: () => null, env: {}, modelExists: () => true, llmSettings: null });
    expect(h.llmReady).toBe(false);
  });
});
