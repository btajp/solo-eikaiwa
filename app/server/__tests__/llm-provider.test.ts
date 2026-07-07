import { describe, expect, test } from "bun:test";
import { selectRunner, settingsToEnv, LLM_ROLES, isInheritRole, roleSettingToSettings } from "../llm-provider";
import type { ClaudeRunner } from "../converse";
import type { LlmSettings, LlmRoleSetting } from "../llm-provider";

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

describe("settingsToEnv", () => {
  const openaiSettings: LlmSettings = {
    provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null,
  };

  test("provider=env: 渡した env をそのまま返す（DB値で上書きしない＝pure-env再現）", () => {
    const env = { LLM_PROVIDER: "codex", FOO: "bar" };
    const out = settingsToEnv({ provider: "env", baseUrl: null, model: null, codexModel: null }, env);
    expect(out).toBe(env);
  });

  test("provider=openai-compat: BASE_URL/MODEL を DB 由来で設定し、APIキーは env 由来のみ保持する", () => {
    const env = { OPENAI_COMPAT_API_KEY: "sk-from-env", OTHER: "x" };
    const out = settingsToEnv(openaiSettings, env);
    expect(out.LLM_PROVIDER).toBe("openai-compat");
    expect(out.OPENAI_COMPAT_BASE_URL).toBe("http://localhost:11434/v1");
    expect(out.OPENAI_COMPAT_MODEL).toBe("llama3");
    // APIキーは settings に存在しない。必ず env（.env）から来る
    expect(out.OPENAI_COMPAT_API_KEY).toBe("sk-from-env");
    expect(out.OTHER).toBe("x");
  });

  test("provider=claude: LLM_PROVIDER=claude を立てる", () => {
    const out = settingsToEnv({ provider: "claude", baseUrl: null, model: null, codexModel: null }, {});
    expect(out.LLM_PROVIDER).toBe("claude");
  });

  test("provider=codex: CODEX_MODEL を DB 由来で設定する", () => {
    const out = settingsToEnv({ provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" }, {});
    expect(out.LLM_PROVIDER).toBe("codex");
    expect(out.CODEX_MODEL).toBe("o4-mini");
  });

  test("settingsToEnv → selectRunner: openai-compat 設定で claudeRunner とは別 runner を返す", () => {
    const sentinel: ClaudeRunner = async () => ({ text: "s", sessionId: "s" });
    const r = selectRunner({
      claudeRunner: sentinel,
      defaultSystemPrompt: "SYS",
      env: settingsToEnv(openaiSettings, {}),
    });
    expect(r).not.toBe(sentinel);
    expect(typeof r).toBe("function");
  });
});

describe("role settings helpers", () => {
  test("LLM_ROLES は4ロール固定・順序も固定", () => {
    expect([...LLM_ROLES]).toEqual(["conversation", "coaching", "generation", "assessment"]);
  });

  test("isInheritRole は provider==='inherit' のときだけ true", () => {
    const inherit: LlmRoleSetting = { provider: "inherit", baseUrl: null, model: null, codexModel: null };
    const claude: LlmRoleSetting = { provider: "claude", baseUrl: null, model: null, codexModel: null };
    expect(isInheritRole(inherit)).toBe(true);
    expect(isInheritRole(claude)).toBe(false);
  });

  test("roleSettingToSettings は provider/フィールドをそのまま LlmSettings へ写す", () => {
    const rs: LlmRoleSetting = { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null };
    expect(roleSettingToSettings(rs)).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
  });
});
