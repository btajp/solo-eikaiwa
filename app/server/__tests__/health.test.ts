import { describe, expect, test } from "bun:test";
import { checkHealth } from "../health";

describe("health", () => {
  test("全依存が揃っていれば ok=true", () => {
    const h = checkHealth({
      whichFn: () => "/opt/homebrew/bin/x",
      env: { OPENAI_API_KEY: "sk-test" },
      modelExists: () => true,
    });
    expect(h).toEqual({ ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: true });
  });

  test("ttsKey が無くても ok は true（say フォールバックがあるため）", () => {
    const h = checkHealth({ whichFn: () => "/bin/x", env: {}, modelExists: () => true });
    expect(h.ttsKey).toBe(false);
    expect(h.ok).toBe(true);
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
