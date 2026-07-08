import { describe, expect, test } from "bun:test";
import type { LlmRoleInput, LlmRoleView, LlmSettingsInput, LlmSettingsView, LlmRole } from "../api";
import { LLM_ROLES } from "../api";
import {
  PRESETS, isLocalDefined, presetEnabled, hydrateConnection, hydrateTargets, buildRolesPayload, matchPreset,
  presetTargets,
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

/** buildRolesPayload の出力（PUT ペイロード）から GET 応答形の View を組み立てる（往復テスト用）。 */
function fakeViewFromPayload(payload: { global: LlmSettingsInput; roles: Record<LlmRole, LlmRoleInput> }): LlmSettingsView {
  const roles = {} as Record<LlmRole, LlmRoleView>;
  for (const r of LLM_ROLES) {
    const role = payload.roles[r];
    roles[r] = { provider: role.provider, baseUrl: role.baseUrl ?? null, model: role.model ?? null, codexModel: role.codexModel ?? null };
  }
  return mkView({
    provider: payload.global.provider,
    baseUrl: payload.global.baseUrl ?? null,
    model: payload.global.model ?? null,
    codexModel: payload.global.codexModel ?? null,
    roles,
  });
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

  test("buildRolesPayload: cloud省略時は従来どおりclaudeフォールバック", () => {
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

  test("buildRolesPayload: ローカル未定義時のフォールバック先は優先クラウド", () => {
    const conn = { baseUrl: "", model: "", codexModel: "" };
    const payload = buildRolesPayload(presetTargets("all-local", "codex"), conn, "codex");
    expect(payload.roles.conversation).toEqual({ provider: "codex", codexModel: null });
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

describe("presetTargets", () => {
  test("claude枠が優先クラウドに置換される（localは不変）", () => {
    expect(presetTargets("balanced", "codex")).toEqual(
      { conversation: "local", coaching: "codex", generation: "local", assessment: "codex" });
    expect(presetTargets("balanced", "claude")).toEqual(PRESETS.balanced);
  });
});

describe("matchPreset", () => {
  test("3プリセットの完全一致を判定する（cloud=claude）", () => {
    expect(matchPreset(PRESETS["all-local"])).toEqual({ id: "all-local", cloud: "claude" });
    expect(matchPreset(PRESETS.balanced)).toEqual({ id: "balanced", cloud: "claude" });
    expect(matchPreset(PRESETS["high-quality"])).toEqual({ id: "high-quality", cloud: "claude" });
  });
  test("両クラウドを試す緩い一致（{id, cloud}を返す）", () => {
    expect(matchPreset(PRESETS.balanced)).toEqual({ id: "balanced", cloud: "claude" });
    expect(matchPreset(presetTargets("balanced", "codex"))).toEqual({ id: "balanced", cloud: "codex" });
    expect(matchPreset(presetTargets("high-quality", "codex"))).toEqual({ id: "high-quality", cloud: "codex" });
  });
  test("1ロールでも異なれば custom", () => {
    expect(matchPreset({ ...PRESETS.balanced, generation: "codex" })).toBe("custom");
  });
  test("クラウド混在はcustom", () => {
    expect(matchPreset({ conversation: "local", coaching: "claude", generation: "local", assessment: "codex" })).toBe("custom");
  });
  test("往復整合: buildRolesPayload→hydrateTargets→matchPreset が元に戻る", () => {
    const conn = { baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "" };
    const payload = buildRolesPayload(PRESETS.balanced, conn);
    const view = fakeViewFromPayload(payload);
    expect(matchPreset(hydrateTargets(view))).toEqual({ id: "balanced", cloud: "claude" });
  });
  test("往復整合（codex優先）: buildRolesPayload→hydrateTargets→matchPreset が {id, cloud:codex} に戻る", () => {
    const conn = { baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" };
    const payload = buildRolesPayload(presetTargets("balanced", "codex"), conn, "codex");
    const view = fakeViewFromPayload(payload);
    expect(matchPreset(hydrateTargets(view))).toEqual({ id: "balanced", cloud: "codex" });
  });
});
