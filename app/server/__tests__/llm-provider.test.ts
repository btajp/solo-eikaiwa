import { describe, expect, test } from "bun:test";
import { selectRunner } from "../llm-provider";
import type { ClaudeRunner } from "../converse";

/** 参照比較用のセンチネル runner（呼ばれない） */
const sentinel: ClaudeRunner = async () => ({ text: "sentinel", sessionId: "s" });

function args(env: Record<string, string | undefined>) {
  return { claudeRunner: sentinel, defaultSystemPrompt: "DEFAULT SYS", env };
}

describe("selectRunner", () => {
  test("LLM_PROVIDER 未設定: claudeRunner をそのまま返す（同一参照＝現行と完全同一）", () => {
    expect(selectRunner(args({}))).toBe(sentinel);
  });

  test("LLM_PROVIDER=claude: claudeRunner をそのまま返す", () => {
    expect(selectRunner(args({ LLM_PROVIDER: "claude" }))).toBe(sentinel);
  });

  test("大文字・前後空白を許容する", () => {
    expect(selectRunner(args({ LLM_PROVIDER: "  Claude  " }))).toBe(sentinel);
  });

  test("openai-compat: claudeRunner とは別の runner を返す", () => {
    const r = selectRunner(args({
      LLM_PROVIDER: "openai-compat",
      OPENAI_COMPAT_BASE_URL: "http://localhost:11434/v1",
      OPENAI_COMPAT_MODEL: "m",
    }));
    expect(r).not.toBe(sentinel);
    expect(typeof r).toBe("function");
  });

  test("openai-compat: BASE_URL 欠落は明示エラー", () => {
    expect(() => selectRunner(args({ LLM_PROVIDER: "openai-compat", OPENAI_COMPAT_MODEL: "m" })))
      .toThrow(/OPENAI_COMPAT_BASE_URL/);
  });

  test("openai-compat: MODEL 欠落は明示エラー", () => {
    expect(() => selectRunner(args({ LLM_PROVIDER: "openai-compat", OPENAI_COMPAT_BASE_URL: "http://x/v1" })))
      .toThrow(/OPENAI_COMPAT_MODEL/);
  });

  test("codex: claudeRunner とは別の runner を返す", () => {
    const r = selectRunner(args({ LLM_PROVIDER: "codex" }));
    expect(r).not.toBe(sentinel);
    expect(typeof r).toBe("function");
  });

  test("未知プロバイダ: 明示エラー", () => {
    expect(() => selectRunner(args({ LLM_PROVIDER: "gemini" }))).toThrow(/Unknown LLM_PROVIDER/);
  });
});
