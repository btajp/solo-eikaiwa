import { afterAll, describe, expect, test } from "bun:test";
import { applyLlmSettings, getCurrentRunner } from "../converse";
import type { LlmSettings } from "../llm-provider";

// ambient な Bun.env.LLM_PROVIDER の影響を排除するため、空 env を明示注入して決定的にする
const emptyEnv: Record<string, string | undefined> = {};
const CLAUDE: LlmSettings = { provider: "claude", baseUrl: null, model: null, codexModel: null };

describe("applyLlmSettings ランタイム切替", () => {
  // グローバル currentRunner をこのファイル内で差し替えるため、後始末で claude 基準へ戻す
  afterAll(() => applyLlmSettings(CLAUDE, emptyEnv));

  test("openai-compat 適用で claude と別参照になり、env リセットで claude 同一参照へ戻る", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner();

    applyLlmSettings(
      { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null },
      emptyEnv,
    );
    const swapped = getCurrentRunner();
    expect(swapped).not.toBe(claudeRef);
    expect(typeof swapped).toBe("function");

    applyLlmSettings({ provider: "env", baseUrl: null, model: null, codexModel: null }, emptyEnv);
    // 空 env → LLM_PROVIDER 未設定 → selectRunner は同一の claudeRunner を返す
    expect(getCurrentRunner()).toBe(claudeRef);
  });

  test("codex 適用も claude と別参照になる", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner();
    applyLlmSettings({ provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" }, emptyEnv);
    expect(getCurrentRunner()).not.toBe(claudeRef);
  });
});
