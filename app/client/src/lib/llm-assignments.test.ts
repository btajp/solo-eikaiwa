import { describe, expect, test } from "bun:test";
import type { LlmSettingsView } from "../api";
import {
  PRESETS, isLocalDefined, presetEnabled, hydrateConnection, hydrateTargets, buildRolesPayload,
  type RoleTargets,
} from "./llm-assignments";

const LOCAL_CONN = { baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "" };
const EMPTY_CONN = { baseUrl: "", model: "", codexModel: "" };

/** テスト用の LlmSettingsView 生成（roles は既定 inherit・上書き可）。 */
function mkView(over: Partial<LlmSettingsView> = {}): LlmSettingsView {
  const inherit = { provider: "inherit" as const, baseUrl: null, model: null, codexModel: null };
  return {
    provider: "env", baseUrl: null, model: null, codexModel: null,
    apiKeyConfigured: false, envProvider: "claude",
    roles: { conversation: inherit, coaching: inherit, generation: inherit, assessment: inherit },
    ...over,
  };
}

describe("isLocalDefined / presetEnabled", () => {
  test("baseUrl と model が両方あればローカル定義済み", () => {
    expect(isLocalDefined(LOCAL_CONN)).toBe(true);
    expect(isLocalDefined({ baseUrl: "http://x/v1", model: "", codexModel: "" })).toBe(false);
    expect(isLocalDefined(EMPTY_CONN)).toBe(false);
  });
  test("ローカルを含むプリセットはローカル定義が必要・最高品質は常に可", () => {
    expect(presetEnabled("all-local", LOCAL_CONN)).toBe(true);
    expect(presetEnabled("balanced", LOCAL_CONN)).toBe(true);
    expect(presetEnabled("all-local", EMPTY_CONN)).toBe(false);
    expect(presetEnabled("balanced", EMPTY_CONN)).toBe(false);
    expect(presetEnabled("high-quality", EMPTY_CONN)).toBe(true);
  });
});

describe("buildRolesPayload", () => {
  test("オールローカル: global=openai-compat・全ロール openai-compat インライン", () => {
    expect(buildRolesPayload(PRESETS["all-local"], LOCAL_CONN)).toEqual({
      global: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: null },
      roles: {
        conversation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
        coaching: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
        generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
        assessment: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      },
    });
  });

  test("バランス: 会話・教材生成=ローカル / コーチング・測定=Claude", () => {
    const payload = buildRolesPayload(PRESETS.balanced, LOCAL_CONN);
    expect(payload.roles).toEqual({
      conversation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      coaching: { provider: "claude" },
      generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      assessment: { provider: "claude" },
    });
    expect(payload.global).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: null });
  });

  test("最高品質: 全ロール Claude だが接続(global=openai-compat)は保持する", () => {
    const payload = buildRolesPayload(PRESETS["high-quality"], LOCAL_CONN);
    expect(payload.roles).toEqual({
      conversation: { provider: "claude" }, coaching: { provider: "claude" },
      generation: { provider: "claude" }, assessment: { provider: "claude" },
    });
    expect(payload.global).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: null });
  });

  test("接続に Codex model があれば global.codexModel と codex ロールに載る", () => {
    const conn = { baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" };
    const targets: RoleTargets = { conversation: "codex", coaching: "local", generation: "local", assessment: "claude" };
    const payload = buildRolesPayload(targets, conn);
    expect(payload.global).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" });
    expect(payload.roles.conversation).toEqual({ provider: "codex", codexModel: "gpt-5-codex" });
  });

  test("ローカル未定義で local ターゲットは claude にフォールバック・global=env", () => {
    const targets: RoleTargets = { conversation: "local", coaching: "claude", generation: "local", assessment: "claude" };
    const payload = buildRolesPayload(targets, EMPTY_CONN);
    expect(payload.global).toEqual({ provider: "env" });
    expect(payload.roles).toEqual({
      conversation: { provider: "claude" }, coaching: { provider: "claude" },
      generation: { provider: "claude" }, assessment: { provider: "claude" },
    });
  });

  test("ローカル未定義・Codex のみ定義なら global=codex", () => {
    const conn = { baseUrl: "", model: "", codexModel: "gpt-5-codex" };
    const targets: RoleTargets = { conversation: "codex", coaching: "codex", generation: "codex", assessment: "codex" };
    const payload = buildRolesPayload(targets, conn);
    expect(payload.global).toEqual({ provider: "codex", codexModel: "gpt-5-codex" });
    expect(payload.roles.conversation).toEqual({ provider: "codex", codexModel: "gpt-5-codex" });
  });
});

describe("hydrateTargets（inherit の読み替え）", () => {
  test("既存ユーザー: llm_settings=openai-compat・全ロール inherit → 全ロール local", () => {
    const view = mkView({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" });
    expect(hydrateTargets(view)).toEqual({ conversation: "local", coaching: "local", generation: "local", assessment: "local" });
  });
  test("新規ユーザー: provider=env・envProvider=claude・全ロール inherit → 全ロール claude", () => {
    expect(hydrateTargets(mkView())).toEqual({ conversation: "claude", coaching: "claude", generation: "claude", assessment: "claude" });
  });
  test("env の envProvider が openai-compat なら inherit は local", () => {
    expect(hydrateTargets(mkView({ provider: "env", envProvider: "openai-compat" })).conversation).toBe("local");
  });
  test("明示ロールを3値へ写像する", () => {
    const view = mkView({
      provider: "env",
      roles: {
        conversation: { provider: "openai-compat", baseUrl: "http://x/v1", model: "m", codexModel: null },
        coaching: { provider: "claude", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "codex", baseUrl: null, model: null, codexModel: "c" },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
    });
    expect(hydrateTargets(view)).toEqual({ conversation: "local", coaching: "claude", generation: "codex", assessment: "claude" });
  });
});

describe("hydrateConnection", () => {
  test("llm_settings から接続入力を復元する", () => {
    const view = mkView({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" });
    expect(hydrateConnection(view)).toEqual({ baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" });
  });
  test("llm_settings に無ければロール行からフォールバックする", () => {
    const view = mkView({
      provider: "env",
      roles: {
        conversation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: null },
        coaching: { provider: "codex", baseUrl: null, model: null, codexModel: "gpt-5-codex" },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
    });
    expect(hydrateConnection(view)).toEqual({ baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" });
  });
  test("何も無ければ空文字", () => {
    expect(hydrateConnection(mkView())).toEqual({ baseUrl: "", model: "", codexModel: "" });
  });
});
