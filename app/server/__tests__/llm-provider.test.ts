import { describe, expect, test } from "bun:test";
import {
  selectRunner, settingsToEnv, LLM_ROLES, isInheritRole, roleSettingToSettings,
  resolveProviderKey, resolveCodexConn, isOpenAiCompatReady,
} from "../llm-provider";
import type { ClaudeRunner } from "../converse";
import type { LlmSettings, LlmRoleSetting } from "../llm-provider";
import { __resetCodexAppServerRegistry } from "../providers/codex-app-server";

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

  // codex は内部で codex-app-server の registry（module-level singleton）を経由する。
  // 常駐プロセスの spawn はここでは行わない（runner を呼ぶまで lazy）ため、ここでは形状のみを検証する。
  // プロセス共有・killのデデュープ挙動は providers/__tests__/codex-app-server-runner.test.ts で
  // getCodexAppServerRunner を直接叩いて検証する（selectRunner 経由では spawn フェイクを注入できないため）。
  test("codex: claudeRunner とは別の runner を返す（app-server runner。実プロセスはlazyなのでここでは起動しない）", () => {
    __resetCodexAppServerRegistry(); // 他テストファイルとの registry 共有状態から分離する
    try {
      const r = selectRunner(args({ LLM_PROVIDER: "codex" }));
      expect(r).not.toBe(sentinel);
      expect(typeof r).toBe("function");
    } finally {
      __resetCodexAppServerRegistry(); // 未spawnのclientを残さない（後続テストへの汚染防止）
    }
  });

  test("未知プロバイダ: 明示エラー", () => {
    expect(() => selectRunner(args({ LLM_PROVIDER: "gemini" }))).toThrow(/Unknown LLM_PROVIDER/);
  });
});

describe("settingsToEnv", () => {
  const openaiSettings: LlmSettings = {
    provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null,
  };

  test("実 env の接続設定（LLM_PROVIDER/OPENAI_COMPAT_*/CODEX_MODEL）は合成 env へ一切漏れない（env フォールバック廃止）", () => {
    const env = {
      LLM_PROVIDER: "codex",
      OPENAI_COMPAT_BASE_URL: "http://from-env:1234/v1",
      OPENAI_COMPAT_MODEL: "env-model",
      CODEX_MODEL: "env-codex",
      FOO: "bar",
    };
    const out = settingsToEnv({ provider: "claude", baseUrl: null, model: null, codexModel: null }, env);
    expect(out.LLM_PROVIDER).toBe("claude");
    expect(out.OPENAI_COMPAT_BASE_URL).toBeUndefined();
    expect(out.OPENAI_COMPAT_MODEL).toBeUndefined();
    expect(out.CODEX_MODEL).toBeUndefined();
    // 接続設定以外の任意 env も引き継がない（合成 env は API キー + DB 由来のみで構成する）
    expect(out.FOO).toBeUndefined();
  });

  test("API キー5種だけは実 env から合成 env へ引き継ぐ", () => {
    const env = {
      ANTHROPIC_API_KEY: "sk-a",
      CODEX_API_KEY: "sk-c",
      OPENAI_API_KEY: "sk-o",
      OPENAI_COMPAT_API_KEY: "sk-oc",
      TTS_API_KEY: "sk-t",
    };
    const out = settingsToEnv({ provider: "claude", baseUrl: null, model: null, codexModel: null }, env);
    expect(out.ANTHROPIC_API_KEY).toBe("sk-a");
    expect(out.CODEX_API_KEY).toBe("sk-c");
    expect(out.OPENAI_API_KEY).toBe("sk-o");
    expect(out.OPENAI_COMPAT_API_KEY).toBe("sk-oc");
    expect(out.TTS_API_KEY).toBe("sk-t");
  });

  test("provider=openai-compat: BASE_URL/MODEL を DB 由来で設定し、APIキーは env 由来のみ保持する", () => {
    const env = { OPENAI_COMPAT_API_KEY: "sk-from-env" };
    const out = settingsToEnv(openaiSettings, env);
    expect(out.LLM_PROVIDER).toBe("openai-compat");
    expect(out.OPENAI_COMPAT_BASE_URL).toBe("http://localhost:11434/v1");
    expect(out.OPENAI_COMPAT_MODEL).toBe("llama3");
    // APIキーは settings に存在しない。必ず env（.env）から来る
    expect(out.OPENAI_COMPAT_API_KEY).toBe("sk-from-env");
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

describe("resolveProviderKey", () => {
  test("未設定は claude 扱い", () => {
    expect(resolveProviderKey({})).toBe("claude");
  });

  test("大文字・前後空白を許容して小文字化する", () => {
    expect(resolveProviderKey({ LLM_PROVIDER: "  Codex  " })).toBe("codex");
  });
});

describe("resolveCodexConn（優先順位・binding: tuning > コード既定。envチューニングは読まない）", () => {
  test("tuning未指定はeffort=medium/serviceTier=fastのコード既定", () => {
    expect(resolveCodexConn({}, "SYS")).toEqual({
      model: undefined, reasoningEffort: "medium", serviceTier: "fast", defaultSystemPrompt: "SYS",
    });
  });

  test("env.CODEX_REASONING_EFFORT/CODEX_SERVICE_TIERは読まない（無視してコード既定）", () => {
    expect(
      resolveCodexConn({ CODEX_REASONING_EFFORT: "xhigh", CODEX_SERVICE_TIER: "standard" }, "SYS"),
    ).toEqual({
      model: undefined, reasoningEffort: "medium", serviceTier: "fast", defaultSystemPrompt: "SYS",
    });
  });

  test("tuning.effort/serviceTier指定はそのまま使われる", () => {
    expect(resolveCodexConn({}, "SYS", { effort: "low", serviceTier: "standard" })).toEqual({
      model: undefined, reasoningEffort: "low", serviceTier: "standard", defaultSystemPrompt: "SYS",
    });
  });

  test('effort "max" は "xhigh" へクランプする（codex は max をリクエスト時に拒否するため・最終防衛線）', () => {
    // 保存時検証をすり抜けた保存済み値（例: claude 時代に保存した global effort=max のまま
    // プロバイダだけ codex へ切替）でも、実行時に毎ターン失敗する設定を作らせない。
    expect(resolveCodexConn({}, "SYS", { effort: "max" }).reasoningEffort).toBe("xhigh");
  });

  test("CODEX_MODELはenv由来のまま（接続レベル設定・tuningにmodelは無い＝全ロール単一モデル方針）", () => {
    expect(resolveCodexConn({ CODEX_MODEL: "gpt-5.5" }, "SYS").model).toBe("gpt-5.5");
  });
});

describe("role settings helpers", () => {
  test("LLM_ROLES は5ロール固定・順序も固定", () => {
    expect([...LLM_ROLES]).toEqual(["conversation", "assist", "coaching", "generation", "assessment"]);
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

describe("isOpenAiCompatReady（health.llmReady集約判定が使う純関数: グローバル設定を反映した有効envでopenai-compatが実際に選択され、接続情報も揃っているか）", () => {
  test("DB設定でprovider=openai-compat・baseUrl/modelとも有り→true", () => {
    const settings: LlmSettings = { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null };
    expect(isOpenAiCompatReady(settings, {})).toBe(true);
  });

  test("DB設定なし(null)は env に接続設定があっても false（envフォールバック廃止・既定はclaude）", () => {
    expect(isOpenAiCompatReady(null, {
      LLM_PROVIDER: "openai-compat",
      OPENAI_COMPAT_BASE_URL: "http://localhost:11434/v1",
      OPENAI_COMPAT_MODEL: "llama3",
    })).toBe(false);
  });

  test("DB設定がprovider=claude等openai-compat以外→false(baseUrl/modelが残っていても)", () => {
    const settings: LlmSettings = { provider: "claude", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null };
    expect(isOpenAiCompatReady(settings, {})).toBe(false);
  });

  test("provider=openai-compatでもbaseUrl欠落→false", () => {
    const settings: LlmSettings = { provider: "openai-compat", baseUrl: null, model: "llama3", codexModel: null };
    expect(isOpenAiCompatReady(settings, {})).toBe(false);
  });

  test("provider=openai-compatでもmodel欠落→false", () => {
    const settings: LlmSettings = { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: null, codexModel: null };
    expect(isOpenAiCompatReady(settings, {})).toBe(false);
  });

  test("設定なし・env未設定→false", () => {
    expect(isOpenAiCompatReady(null, {})).toBe(false);
  });
});
