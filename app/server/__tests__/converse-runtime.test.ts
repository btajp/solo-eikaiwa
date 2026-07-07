import { afterAll, describe, expect, test } from "bun:test";
import { applyLlmSettings, applyLlmRoleSettings, getCurrentRunner, runnerFor } from "../converse";
import { LLM_ROLES } from "../llm-provider";
import type { LlmSettings, LlmRole, LlmRoleSetting } from "../llm-provider";

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

const INHERIT: LlmRoleSetting = { provider: "inherit", baseUrl: null, model: null, codexModel: null };
const allInherit = (): Record<LlmRole, LlmRoleSetting> =>
  Object.fromEntries(LLM_ROLES.map((r) => [r, INHERIT])) as Record<LlmRole, LlmRoleSetting>;

describe("runnerFor / applyLlmRoleSettings ロール別ルーティング", () => {
  afterAll(() => applyLlmSettings(CLAUDE, emptyEnv));

  test("全ロール inherit + global=env なら4ロールとも同一の claude runner に解決する（既定不変）", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner("conversation");
    applyLlmRoleSettings({ provider: "env", baseUrl: null, model: null, codexModel: null }, allInherit(), emptyEnv);
    for (const role of LLM_ROLES) {
      // resolved runner は全ロール同一参照（= claudeRunner）
      expect(getCurrentRunner(role)).toBe(claudeRef);
    }
  });

  test("runnerFor は安定参照（再解決しても同じラッパを返す）", () => {
    const before = runnerFor("coaching");
    applyLlmRoleSettings(
      { provider: "claude", baseUrl: null, model: null, codexModel: null },
      { ...allInherit(), coaching: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null } },
      emptyEnv,
    );
    expect(runnerFor("coaching")).toBe(before);
  });

  test("1ロールだけ openai-compat 上書きすると、そのロールの解決先だけ別参照になり他ロールは inherit(claude) のまま", () => {
    applyLlmSettings(CLAUDE, emptyEnv);
    const claudeRef = getCurrentRunner("conversation");
    applyLlmRoleSettings(
      CLAUDE,
      { ...allInherit(), generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null } },
      emptyEnv,
    );
    expect(getCurrentRunner("generation")).not.toBe(claudeRef);
    expect(getCurrentRunner("conversation")).toBe(claudeRef);
    expect(getCurrentRunner("coaching")).toBe(claudeRef);
    expect(getCurrentRunner("assessment")).toBe(claudeRef);
  });

  test("後方互換: applyLlmSettings(global) は全ロールを inherit として global へ解決する", () => {
    applyLlmSettings({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null }, emptyEnv);
    const conv = getCurrentRunner("conversation");
    for (const role of LLM_ROLES) expect(getCurrentRunner(role)).toBe(conv);
  });
});
