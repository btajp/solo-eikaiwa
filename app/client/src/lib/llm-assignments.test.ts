import { describe, expect, test } from "bun:test";
import type { LlmRoleInput, LlmRoleView, LlmSettingsInput, LlmSettingsView, LlmRole, RoleTuning, CatalogResult } from "../api";
import { LLM_ROLES } from "../api";
import {
  PRESETS, isLocalDefined, presetEnabled, hydrateConnection, hydrateTargets, buildRolesPayload, matchPreset,
  presetTargets, defaultTuning, hydrateTuning, RECOMMENDED_TUNING, applyRecommendedTuning,
  claudeModelSelectOptions, effortOptionsForClaudeAlias, codexModelSelectOptions, effortOptionsForCodexModel,
  tierOptionsForCodexModel, codexDefaultEffortLabel, localModelSelectOptions, resolveEffective, clampClaudeEffort,
  hydrateAuthModes, hydrateAuthKeys, buildAuthPatch,
  type RoleTargets,
} from "./llm-assignments";

const LOCAL_CONN = { baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "" };
const EMPTY_CONN = { baseUrl: "", model: "", codexModel: "" };

/** テスト用の LlmSettingsView 生成（roles は既定 inherit・tuning は既定全null・上書き可）。 */
function mkView(over: Partial<LlmSettingsView> = {}): LlmSettingsView {
  const inherit = { provider: "inherit" as const, baseUrl: null, model: null, codexModel: null };
  return {
    provider: "env", baseUrl: null, model: null, codexModel: null,
    apiKeyConfigured: false, envProvider: "claude",
    roles: { conversation: inherit, assist: inherit, coaching: inherit, generation: inherit, assessment: inherit },
    tuning: defaultTuning(),
    authModes: { claude: "subscription", codex: "subscription" },
    authKeys: { anthropic: false, codex: false },
    ...over,
  };
}

/** buildRolesPayload の出力（PUT ペイロード）から GET 応答形の View を組み立てる（往復テスト用）。 */
function fakeViewFromPayload(payload: { global: LlmSettingsInput; roles: Record<LlmRole, LlmRoleInput>; tuning?: Record<LlmRole, RoleTuning> }): LlmSettingsView {
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
    tuning: payload.tuning ?? defaultTuning(),
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
        assist: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
        coaching: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
        generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
        assessment: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      },
      tuning: defaultTuning(),
    });
  });

  test("バランス: 会話・クイック支援・教材生成=ローカル / コーチング・測定=Claude", () => {
    const payload = buildRolesPayload(PRESETS.balanced, LOCAL_CONN);
    expect(payload.roles).toEqual({
      conversation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      assist: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      coaching: { provider: "claude" },
      generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" },
      assessment: { provider: "claude" },
    });
    expect(payload.global).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: null });
  });

  test("最高品質: 全ロール Claude だが接続(global=openai-compat)は保持する", () => {
    const payload = buildRolesPayload(PRESETS["high-quality"], LOCAL_CONN);
    expect(payload.roles).toEqual({
      conversation: { provider: "claude" }, assist: { provider: "claude" }, coaching: { provider: "claude" },
      generation: { provider: "claude" }, assessment: { provider: "claude" },
    });
    expect(payload.global).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: null });
  });

  test("接続に Codex model があれば global.codexModel と codex ロールに載る", () => {
    const conn = { baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" };
    const targets: RoleTargets = { conversation: "codex", assist: "local", coaching: "local", generation: "local", assessment: "claude" };
    const payload = buildRolesPayload(targets, conn);
    expect(payload.global).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", codexModel: "gpt-5-codex" });
    expect(payload.roles.conversation).toEqual({ provider: "codex", codexModel: "gpt-5-codex" });
  });

  test("buildRolesPayload: cloud省略時は従来どおりclaudeフォールバック", () => {
    const targets: RoleTargets = { conversation: "local", assist: "local", coaching: "claude", generation: "local", assessment: "claude" };
    const payload = buildRolesPayload(targets, EMPTY_CONN);
    expect(payload.global).toEqual({ provider: "env" });
    expect(payload.roles).toEqual({
      conversation: { provider: "claude" }, assist: { provider: "claude" }, coaching: { provider: "claude" },
      generation: { provider: "claude" }, assessment: { provider: "claude" },
    });
  });

  test("ローカル未定義・Codex のみ定義なら global=codex", () => {
    const conn = { baseUrl: "", model: "", codexModel: "gpt-5-codex" };
    const targets: RoleTargets = { conversation: "codex", assist: "codex", coaching: "codex", generation: "codex", assessment: "codex" };
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

describe("buildRolesPayload: tuning の直列化", () => {
  test("tuning引数省略時は全ロール null で直列化される", () => {
    const payload = buildRolesPayload(PRESETS["all-local"], LOCAL_CONN);
    expect(payload.tuning).toEqual(defaultTuning());
  });

  test("tuning引数を渡すとそのまま payload に乗る（割当やプリセットとは独立）", () => {
    const tuning: Record<LlmRole, RoleTuning> = {
      ...defaultTuning(),
      conversation: { claudeModel: "opus", effort: "high", serviceTier: null },
      assessment: { claudeModel: null, effort: null, serviceTier: "standard" },
    };
    const payload = buildRolesPayload(PRESETS.balanced, LOCAL_CONN, "claude", tuning);
    expect(payload.tuning).toEqual(tuning);
  });
});

describe("hydrateTargets（inherit の読み替え）", () => {
  test("既存ユーザー: llm_settings=openai-compat・全ロール inherit → 全ロール local", () => {
    const view = mkView({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" });
    expect(hydrateTargets(view)).toEqual({ conversation: "local", assist: "local", coaching: "local", generation: "local", assessment: "local" });
  });
  test("新規ユーザー: provider=env・envProvider=claude・全ロール inherit → 全ロール claude", () => {
    expect(hydrateTargets(mkView())).toEqual({ conversation: "claude", assist: "claude", coaching: "claude", generation: "claude", assessment: "claude" });
  });
  test("env の envProvider が openai-compat なら inherit は local", () => {
    expect(hydrateTargets(mkView({ provider: "env", envProvider: "openai-compat" })).conversation).toBe("local");
  });
  test("明示ロールを3値へ写像する", () => {
    const view = mkView({
      provider: "env",
      roles: {
        conversation: { provider: "openai-compat", baseUrl: "http://x/v1", model: "m", codexModel: null },
        assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "claude", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "codex", baseUrl: null, model: null, codexModel: "c" },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
    });
    expect(hydrateTargets(view)).toEqual({ conversation: "local", assist: "claude", coaching: "claude", generation: "codex", assessment: "claude" });
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
        assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
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
      { conversation: "local", assist: "local", coaching: "codex", generation: "local", assessment: "codex" });
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
    expect(matchPreset({ conversation: "local", assist: "local", coaching: "claude", generation: "local", assessment: "codex" })).toBe("custom");
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

describe("RECOMMENDED_TUNING", () => {
  test("spec §4 の推奨マトリクスと逐語一致する（全ロール・claude/codex両方）", () => {
    expect(RECOMMENDED_TUNING).toEqual({
      conversation: {
        claude: { claudeModel: "sonnet", effort: "low", serviceTier: null },
        codex: { claudeModel: null, effort: "low", serviceTier: "fast" },
      },
      assist: {
        // haiku は effort 非対応（実測: `claude -p --model haiku --effort low` は成功するが黙って無視される）
        claude: { claudeModel: "haiku", effort: null, serviceTier: null },
        codex: { claudeModel: null, effort: "low", serviceTier: "fast" },
      },
      coaching: {
        claude: { claudeModel: "sonnet", effort: "high", serviceTier: null },
        codex: { claudeModel: null, effort: "medium", serviceTier: "fast" },
      },
      generation: {
        claude: { claudeModel: "sonnet", effort: "medium", serviceTier: null },
        codex: { claudeModel: null, effort: "medium", serviceTier: "fast" },
      },
      assessment: {
        claude: { claudeModel: "opus", effort: "xhigh", serviceTier: null },
        codex: { claudeModel: null, effort: "xhigh", serviceTier: "standard" },
      },
    });
  });

  test("claude側・codex側とも serviceTier/claudeModel の対象外項目は常に null", () => {
    for (const role of LLM_ROLES) {
      expect(RECOMMENDED_TUNING[role].claude.serviceTier).toBeNull();
      expect(RECOMMENDED_TUNING[role].codex.claudeModel).toBeNull();
    }
  });
});

describe("applyRecommendedTuning", () => {
  test("claude割当ロールはclaude側の推奨で置き換わる", () => {
    const current = defaultTuning();
    const targets: RoleTargets = { conversation: "claude", assist: "local", coaching: "local", generation: "local", assessment: "local" };
    expect(applyRecommendedTuning(current, targets).conversation).toEqual(RECOMMENDED_TUNING.conversation.claude);
  });

  test("codex割当ロールはcodex側の推奨で置き換わる", () => {
    const current = defaultTuning();
    const targets: RoleTargets = { conversation: "local", assist: "local", coaching: "local", generation: "local", assessment: "codex" };
    expect(applyRecommendedTuning(current, targets).assessment).toEqual(RECOMMENDED_TUNING.assessment.codex);
  });

  test("local割当ロールは現在値を維持する（推奨で上書きしない）", () => {
    const custom: RoleTuning = { claudeModel: "opus", effort: "high", serviceTier: null };
    const current = { ...defaultTuning(), generation: custom };
    const targets: RoleTargets = { conversation: "local", assist: "local", coaching: "local", generation: "local", assessment: "local" };
    expect(applyRecommendedTuning(current, targets).generation).toEqual(custom);
  });

  test("全ロール網羅: claude/codex/local混在で各ロールが対応する推奨・現在値に振り分けられる", () => {
    const current: Record<LlmRole, RoleTuning> = {
      conversation: { claudeModel: null, effort: null, serviceTier: null },
      assist: { claudeModel: "opus", effort: "high", serviceTier: null },
      coaching: { claudeModel: null, effort: null, serviceTier: null },
      generation: { claudeModel: null, effort: null, serviceTier: null },
      assessment: { claudeModel: null, effort: null, serviceTier: null },
    };
    const targets: RoleTargets = { conversation: "claude", assist: "local", coaching: "codex", generation: "claude", assessment: "codex" };
    const result = applyRecommendedTuning(current, targets);
    expect(result).toEqual({
      conversation: RECOMMENDED_TUNING.conversation.claude,
      assist: current.assist,
      coaching: RECOMMENDED_TUNING.coaching.codex,
      generation: RECOMMENDED_TUNING.generation.claude,
      assessment: RECOMMENDED_TUNING.assessment.codex,
    });
  });

  test("元オブジェクト（current）を変更しない（非破壊）", () => {
    const current = defaultTuning();
    const snapshot = JSON.parse(JSON.stringify(current));
    const targets: RoleTargets = { conversation: "claude", assist: "codex", coaching: "claude", generation: "codex", assessment: "claude" };
    applyRecommendedTuning(current, targets);
    expect(current).toEqual(snapshot);
  });

  test("assistをclaude割当にすると推奨effortはnull（haikuはeffort非対応のため）", () => {
    const current = defaultTuning();
    const targets: RoleTargets = { conversation: "local", assist: "claude", coaching: "local", generation: "local", assessment: "local" };
    expect(applyRecommendedTuning(current, targets).assist).toEqual({ claudeModel: "haiku", effort: null, serviceTier: null });
  });
});

describe("旧サーバ応答への後方互換（ロール行の欠落）", () => {
  test("assist行が無い旧応答でもhydrateTargetsは壊れずinherit扱い", () => {
    const view = mkView({
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3:30b-instruct",
    });
    // 旧サーバ（4ロール）を再現: assist 行を落とす
    delete (view.roles as Record<string, unknown>).assist;
    const targets = hydrateTargets(view);
    expect(targets.assist).toBe("local"); // inherit → effective global(openai-compat) → local
    expect(targets.conversation).toBe("local");
  });
  test("assist行が無い旧応答でもhydrateConnectionは壊れず接続を復元する", () => {
    const view = mkView({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3:30b-instruct" });
    delete (view.roles as Record<string, unknown>).assist;
    expect(hydrateConnection(view)).toEqual({
      baseUrl: "http://localhost:11434/v1", model: "qwen3:30b-instruct", codexModel: "",
    });
  });
  test("tuningキー自体が無い旧応答でもhydrateTuningは壊れず全ロールnullで復元する", () => {
    const view = mkView();
    delete (view as Record<string, unknown>).tuning;
    expect(hydrateTuning(view)).toEqual(defaultTuning());
  });
  test("特定ロールのtuning行だけが無い旧応答でもhydrateTuningはそのロールをnullで復元する", () => {
    const view = mkView({
      tuning: {
        ...defaultTuning(),
        conversation: { claudeModel: "opus", effort: "high", serviceTier: null },
      },
    });
    delete (view.tuning as Record<string, unknown>).assist;
    const result = hydrateTuning(view);
    expect(result.assist).toEqual({ claudeModel: null, effort: null, serviceTier: null });
    expect(result.conversation).toEqual({ claudeModel: "opus", effort: "high", serviceTier: null });
  });
  test("authModesキー自体が無い旧応答でもhydrateAuthModesは壊れず両providerともsubscriptionで復元する", () => {
    const view = mkView();
    delete (view as Record<string, unknown>).authModes;
    expect(hydrateAuthModes(view)).toEqual({ claude: "subscription", codex: "subscription" });
  });
  test("特定providerのauthModes行だけが無い旧応答でもhydrateAuthModesはそのproviderをsubscriptionで復元する", () => {
    const view = mkView({ authModes: { claude: "api-key", codex: "subscription" } });
    delete (view.authModes as Record<string, unknown>).codex;
    const result = hydrateAuthModes(view);
    expect(result.claude).toBe("api-key");
    expect(result.codex).toBe("subscription");
  });
  test("authKeysキー自体が無い旧応答でもhydrateAuthKeysは壊れず両方falseで復元する", () => {
    const view = mkView();
    delete (view as Record<string, unknown>).authKeys;
    expect(hydrateAuthKeys(view)).toEqual({ anthropic: false, codex: false });
  });
  test("authKeysが有るときhydrateAuthKeysはそのまま復元する", () => {
    const view = mkView({ authKeys: { anthropic: true, codex: false } });
    expect(hydrateAuthKeys(view)).toEqual({ anthropic: true, codex: false });
  });
});

describe("buildAuthPatch（ロックアウト防止のための差分抽出）", () => {
  test("両方未変更ならundefined（authフィールド自体をPUTに含めない）", () => {
    const baseline = { claude: "api-key" as const, codex: "subscription" as const };
    expect(buildAuthPatch(baseline, { claude: "api-key", codex: "subscription" })).toBeUndefined();
  });
  test("claudeだけ変更ならclaudeのみを含む", () => {
    const baseline = { claude: "subscription" as const, codex: "subscription" as const };
    expect(buildAuthPatch(baseline, { claude: "api-key", codex: "subscription" })).toEqual({ claude: "api-key" });
  });
  test("codexだけ変更ならcodexのみを含む", () => {
    const baseline = { claude: "subscription" as const, codex: "subscription" as const };
    expect(buildAuthPatch(baseline, { claude: "subscription", codex: "api-key" })).toEqual({ codex: "api-key" });
  });
  test("両方変更なら両方を含む", () => {
    const baseline = { claude: "subscription" as const, codex: "subscription" as const };
    expect(buildAuthPatch(baseline, { claude: "api-key", codex: "api-key" })).toEqual({ claude: "api-key", codex: "api-key" });
  });
  test("api-keyで保存済み・後からenvキー削除の状態でも他providerの変更だけをパッチにできる（ロックアウト再現シナリオ）", () => {
    // baseline = サーバ保存済み値（api-key で保存した直後の状態を再現）。キー削除後もサーバ値は変わらない。
    const baseline = { claude: "api-key" as const, codex: "subscription" as const };
    // ユーザーは claude の auth を一切触らず、codex だけ api-key に変更して保存しようとする。
    const patch = buildAuthPatch(baseline, { claude: "api-key", codex: "api-key" });
    expect(patch).toEqual({ codex: "api-key" }); // claude は変更なしのため含まれない＝キー削除後でも400にならない
  });
});

// ---------------------------------------------------------------------------
// モデルカタログ由来の選択肢・実効モデル解決（task-4-brief の実機カタログ所見に基づくフィクスチャ）
// ---------------------------------------------------------------------------

const CLAUDE_CATALOG: CatalogResult = {
  available: true,
  fetchedAt: "2026-07-08T00:00:00.000Z",
  models: [
    { id: "opus[1m]", displayName: "Opus", description: "Most capable", resolvedModel: "claude-opus-4-6",
      efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }] },
    { id: "sonnet", displayName: "Sonnet", description: "Balanced", resolvedModel: "claude-sonnet-5",
      efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }] },
    // haiku は effort 非対応（efforts フィールド自体が無い・実機所見）
    { id: "haiku", displayName: "Haiku", description: "Fast", resolvedModel: "claude-haiku-4-5-20251001" },
    { id: "claude-fable-5[1m]", displayName: "Claude Fable 5", description: "Latest", resolvedModel: "claude-fable-5",
      efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }, { id: "max" }] },
    // CLI 自身の推奨行。displayName が haiku/sonnet/opus のいずれとも一致しないため自然に除外される
    { id: "default", displayName: "default", description: "CLI recommended", resolvedModel: "claude-opus-4-6" },
  ],
};

const CODEX_CATALOG: CatalogResult = {
  available: true,
  fetchedAt: "2026-07-08T00:00:00.000Z",
  models: [
    { id: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier", resolvedModel: "gpt-5.5",
      isDefault: true, defaultEffort: "medium",
      efforts: [{ id: "low" }, { id: "medium", description: "Balanced" }, { id: "high" }, { id: "xhigh" }],
      tiers: [{ id: "priority", name: "Priority" }] },
    { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini", description: "Fast/cheap", resolvedModel: "gpt-5.4-mini",
      defaultEffort: "medium", efforts: [{ id: "low" }, { id: "medium" }] },
  ],
};

const LOCAL_CATALOG: CatalogResult = {
  available: true,
  fetchedAt: "2026-07-08T00:00:00.000Z",
  models: [{ id: "qwen3:30b-instruct", displayName: "qwen3:30b-instruct", description: "" }],
};

const UNAVAILABLE_CATALOG: CatalogResult = { available: false, reason: "boom", models: [], fetchedAt: "2026-07-08T00:00:00.000Z" };

describe("claudeModelSelectOptions / effortOptionsForClaudeAlias", () => {
  test("カタログ一致時: 常に haiku/sonnet/opus の3件・実体を併記したラベル", () => {
    expect(claudeModelSelectOptions(CLAUDE_CATALOG)).toEqual([
      { value: "haiku", label: "Haiku — claude-haiku-4-5-20251001" },
      { value: "sonnet", label: "Sonnet — claude-sonnet-5" },
      { value: "opus", label: "Opus — claude-opus-4-6" },
    ]);
  });
  test("カタログ不可時: エイリアスそのものをラベルにする（推測の具体IDを出さない）", () => {
    expect(claudeModelSelectOptions(undefined)).toEqual([
      { value: "haiku", label: "haiku" }, { value: "sonnet", label: "sonnet" }, { value: "opus", label: "opus" },
    ]);
    expect(claudeModelSelectOptions(UNAVAILABLE_CATALOG)).toEqual([
      { value: "haiku", label: "haiku" }, { value: "sonnet", label: "sonnet" }, { value: "opus", label: "opus" },
    ]);
  });
  test("sonnet は5段階(maxまで)・haiku は空（effort非対応）", () => {
    expect(effortOptionsForClaudeAlias(CLAUDE_CATALOG, "sonnet")).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(effortOptionsForClaudeAlias(CLAUDE_CATALOG, "haiku")).toEqual([]);
  });
  test("カタログ不可時は空配列", () => {
    expect(effortOptionsForClaudeAlias(undefined, "sonnet")).toEqual([]);
  });
});

describe("codexModelSelectOptions / effortOptionsForCodexModel / tierOptionsForCodexModel", () => {
  test("カタログ一致時: id/displayName/isDefault をそのまま選択肢化する", () => {
    expect(codexModelSelectOptions(CODEX_CATALOG)).toEqual([
      { value: "gpt-5.5", label: "GPT-5.5", isDefault: true },
      { value: "gpt-5.4-mini", label: "GPT-5.4 mini", isDefault: false },
    ]);
  });
  test("カタログ不可時は空配列（自由記述へフォールバック）", () => {
    expect(codexModelSelectOptions(UNAVAILABLE_CATALOG)).toEqual([]);
    expect(codexModelSelectOptions(undefined)).toEqual([]);
  });
  test("effort選択肢: 指定モデルのeffortsをdescription付きで返す。空文字は既定行(isDefault)を使う", () => {
    expect(effortOptionsForCodexModel(CODEX_CATALOG, "gpt-5.5")).toEqual([
      { id: "low" }, { id: "medium", description: "Balanced" }, { id: "high" }, { id: "xhigh" },
    ]);
    expect(effortOptionsForCodexModel(CODEX_CATALOG, "")).toEqual(CODEX_CATALOG.models[0]!.efforts!);
    expect(effortOptionsForCodexModel(CODEX_CATALOG, "unknown-id")).toEqual([]);
  });
  test("tier選択肢: tiersを持つモデルはfast/standard、持たないモデルはstandardのみ（生のtier idは使わない）", () => {
    expect(tierOptionsForCodexModel(CODEX_CATALOG, "gpt-5.5")).toEqual(["fast", "standard"]);
    expect(tierOptionsForCodexModel(CODEX_CATALOG, "gpt-5.4-mini")).toEqual(["standard"]);
    expect(tierOptionsForCodexModel(CODEX_CATALOG, "")).toEqual(["fast", "standard"]); // 既定行(gpt-5.5)はtiersあり
    expect(tierOptionsForCodexModel(CODEX_CATALOG, "unknown-id")).toEqual(["standard"]); // 未マッチは保守的にstandardのみ
  });
  test("既定effortラベル: カタログのdefaultEffort優先・不一致/不可はコード既定medium", () => {
    expect(codexDefaultEffortLabel(CODEX_CATALOG, "gpt-5.5")).toBe("medium");
    expect(codexDefaultEffortLabel(CODEX_CATALOG, "unknown-id")).toBe("medium");
    expect(codexDefaultEffortLabel(undefined, "gpt-5.5")).toBe("medium");
  });
});

describe("localModelSelectOptions", () => {
  test("カタログ一致時はid/displayNameをそのまま選択肢化する", () => {
    expect(localModelSelectOptions(LOCAL_CATALOG)).toEqual([{ value: "qwen3:30b-instruct", label: "qwen3:30b-instruct" }]);
  });
  test("カタログ不可時は空配列", () => {
    expect(localModelSelectOptions(UNAVAILABLE_CATALOG)).toEqual([]);
    expect(localModelSelectOptions(undefined)).toEqual([]);
  });
});

describe("resolveEffective", () => {
  test("claude・tuning全null・カタログ未取得: エイリアスsonnet(未確認)・effortはSDK標準・tierはnull", () => {
    const view = mkView({ provider: "env", envProvider: "claude" });
    expect(resolveEffective("conversation", view)).toEqual({
      provider: "claude",
      model: { confirmed: false, text: "sonnet" },
      effort: { value: "sdk-standard", isDefault: true },
      tier: null,
    });
  });

  test("claude・カタログ一致: 具体ID(claude-sonnet-5)が確認済みで返る", () => {
    const view = mkView({ provider: "env", envProvider: "claude" });
    const r = resolveEffective("conversation", view, { claude: CLAUDE_CATALOG, codex: UNAVAILABLE_CATALOG, local: UNAVAILABLE_CATALOG });
    expect(r.model).toEqual({ confirmed: true, text: "claude-sonnet-5" });
  });

  test("claude・haikuモデル指定+カタログ一致: 具体IDが確認済み・effortはSDK標準のまま", () => {
    const view = mkView({
      provider: "env", envProvider: "claude",
      tuning: { ...defaultTuning(), conversation: { claudeModel: "haiku", effort: null, serviceTier: null } },
    });
    const r = resolveEffective("conversation", view, { claude: CLAUDE_CATALOG, codex: UNAVAILABLE_CATALOG, local: UNAVAILABLE_CATALOG });
    expect(r.model).toEqual({ confirmed: true, text: "claude-haiku-4-5-20251001" });
    expect(r.effort).toEqual({ value: "sdk-standard", isDefault: true });
  });

  test("claude・haiku指定+effort明示指定(high)+カタログ一致: 実測(非対応effortは黙って無視される)によりSDK標準へ落とす", () => {
    const view = mkView({
      provider: "env", envProvider: "claude",
      tuning: { ...defaultTuning(), conversation: { claudeModel: "haiku", effort: "high", serviceTier: null } },
    });
    const r = resolveEffective("conversation", view, { claude: CLAUDE_CATALOG, codex: UNAVAILABLE_CATALOG, local: UNAVAILABLE_CATALOG });
    expect(r.effort).toEqual({ value: "sdk-standard", isDefault: true });
  });

  test("claude・haiku指定+effort明示指定+カタログ不可: 判定材料が無いため保存値をそのまま表示する", () => {
    const view = mkView({
      provider: "env", envProvider: "claude",
      tuning: { ...defaultTuning(), conversation: { claudeModel: "haiku", effort: "high", serviceTier: null } },
    });
    const r = resolveEffective("conversation", view);
    expect(r.effort).toEqual({ value: "high", isDefault: false });
  });

  test("claude・effort明示指定はそのまま反映される(isDefault:false)", () => {
    const view = mkView({
      provider: "env", envProvider: "claude",
      tuning: { ...defaultTuning(), assessment: { claudeModel: "opus", effort: "xhigh", serviceTier: null } },
    });
    const r = resolveEffective("assessment", view);
    expect(r.effort).toEqual({ value: "xhigh", isDefault: false });
  });

  test("codex・tuning全null・codexModel空・カタログ未取得: model未確認(CLI既定)・effort/tierはコード既定", () => {
    const view = mkView({ provider: "codex", codexModel: null });
    expect(resolveEffective("conversation", view)).toEqual({
      provider: "codex",
      model: { confirmed: false, text: "", cliDefault: true },
      effort: { value: "medium", isDefault: true },
      tier: { value: "fast", isDefault: true },
    });
  });

  test("codex・codexModel空+カタログのisDefault行が一致: 具体IDが確認済み・既定effortもcatalog由来", () => {
    const view = mkView({ provider: "codex", codexModel: null });
    const r = resolveEffective("conversation", view, { claude: UNAVAILABLE_CATALOG, codex: CODEX_CATALOG, local: UNAVAILABLE_CATALOG });
    expect(r.model).toEqual({ confirmed: true, text: "gpt-5.5" });
    expect(r.effort).toEqual({ value: "medium", isDefault: true });
  });

  test("codex・codexModel明示+カタログ一致: 具体IDが確認済み", () => {
    const view = mkView({ provider: "codex", codexModel: "gpt-5.4-mini" });
    const r = resolveEffective("conversation", view, { claude: UNAVAILABLE_CATALOG, codex: CODEX_CATALOG, local: UNAVAILABLE_CATALOG });
    expect(r.model).toEqual({ confirmed: true, text: "gpt-5.4-mini" });
  });

  test("codex・codexModel明示だがカタログに無い: 設定値そのまま・未確認（CLI既定扱いにはしない）", () => {
    const view = mkView({ provider: "codex", codexModel: "gpt-9-mystery" });
    const r = resolveEffective("conversation", view, { claude: UNAVAILABLE_CATALOG, codex: CODEX_CATALOG, local: UNAVAILABLE_CATALOG });
    expect(r.model).toEqual({ confirmed: false, text: "gpt-9-mystery" });
  });

  test("codex・tiers非対応モデル(gpt-5.4-mini)+保存値fast+カタログ有: 実効配信は標準（既定）扱い（実測: 非対応tierは黙って無視される）", () => {
    const view = mkView({
      provider: "codex", codexModel: "gpt-5.4-mini",
      tuning: { ...defaultTuning(), conversation: { claudeModel: null, effort: null, serviceTier: "fast" } },
    });
    const r = resolveEffective("conversation", view, { claude: UNAVAILABLE_CATALOG, codex: CODEX_CATALOG, local: UNAVAILABLE_CATALOG });
    expect(r.tier).toEqual({ value: "standard", isDefault: true });
  });

  test("codex・tiers非対応モデル+保存値fast+カタログ不可: 判定材料が無いため保存値をそのまま表示する", () => {
    const view = mkView({
      provider: "codex", codexModel: "gpt-5.4-mini",
      tuning: { ...defaultTuning(), conversation: { claudeModel: null, effort: null, serviceTier: "fast" } },
    });
    const r = resolveEffective("conversation", view);
    expect(r.tier).toEqual({ value: "fast", isDefault: false });
  });

  test("codex・tiers対応モデル(gpt-5.5)+保存値fast+カタログ有: 保存値がそのまま実効になる（回帰確認）", () => {
    const view = mkView({
      provider: "codex", codexModel: "gpt-5.5",
      tuning: { ...defaultTuning(), conversation: { claudeModel: null, effort: null, serviceTier: "fast" } },
    });
    const r = resolveEffective("conversation", view, { claude: UNAVAILABLE_CATALOG, codex: CODEX_CATALOG, local: UNAVAILABLE_CATALOG });
    expect(r.tier).toEqual({ value: "fast", isDefault: false });
  });

  test("local: 常に確認済み（設定値がそのまま実効値のため、カタログ不要）・effort/tierはnull", () => {
    const view = mkView({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3:30b-instruct" });
    expect(resolveEffective("conversation", view)).toEqual({
      provider: "local",
      model: { confirmed: true, text: "qwen3:30b-instruct" },
      effort: null,
      tier: null,
    });
  });

  test("env の envProvider が openai-compat のとき inherit ロールは local として解決される", () => {
    const view = mkView({ provider: "env", envProvider: "openai-compat", model: "qwen3" });
    expect(resolveEffective("conversation", view).provider).toBe("local");
  });

  test("assist連鎖: assistがinheritならcoachingの解決結果(プロバイダ・tuningとも)をそのまま使う", () => {
    const view = mkView({
      provider: "env", envProvider: "claude",
      roles: {
        conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "codex", baseUrl: null, model: null, codexModel: "gpt-5.4-mini" },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
      tuning: {
        ...defaultTuning(),
        // assist 自身の tuning は inherit の間は無視される（連鎖の一貫性）
        assist: { claudeModel: "opus", effort: "xhigh", serviceTier: null },
        coaching: { claudeModel: null, effort: "high", serviceTier: "standard" },
      },
    });
    const coaching = resolveEffective("coaching", view, { claude: UNAVAILABLE_CATALOG, codex: CODEX_CATALOG, local: UNAVAILABLE_CATALOG });
    const assist = resolveEffective("assist", view, { claude: UNAVAILABLE_CATALOG, codex: CODEX_CATALOG, local: UNAVAILABLE_CATALOG });
    expect(assist).toEqual(coaching);
    expect(assist.provider).toBe("codex");
    expect(assist.effort).toEqual({ value: "high", isDefault: false });
  });

  test("assistが明示プロバイダを持つ場合はcoachingへ連鎖せず自分自身のtuningを使う", () => {
    const view = mkView({
      provider: "env", envProvider: "claude",
      roles: {
        conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assist: { provider: "claude", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "codex", baseUrl: null, model: null, codexModel: "gpt-5.4-mini" },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
      tuning: { ...defaultTuning(), assist: { claudeModel: "haiku", effort: "low", serviceTier: null } },
    });
    const r = resolveEffective("assist", view);
    expect(r.provider).toBe("claude");
    expect(r.model).toEqual({ confirmed: false, text: "haiku" });
    expect(r.effort).toEqual({ value: "low", isDefault: false });
  });

  test("tuningキー自体が無い旧応答でも壊れずコード既定で解決する", () => {
    const view = mkView({ provider: "env", envProvider: "claude" });
    delete (view as Record<string, unknown>).tuning;
    expect(() => resolveEffective("conversation", view)).not.toThrow();
    expect(resolveEffective("conversation", view).effort).toEqual({ value: "sdk-standard", isDefault: true });
  });

  test("assist行自体が無い旧応答でも壊れない（inherit扱いとして自ロール解決）", () => {
    const view = mkView({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3" });
    delete (view.roles as Record<string, unknown>).assist;
    expect(() => resolveEffective("assist", view)).not.toThrow();
    expect(resolveEffective("assist", view).provider).toBe("local");
  });
});

describe("clampClaudeEffort", () => {
  test("モデル切替先が新effortに対応: 現在値を維持する（sonnet→sonnet, high）", () => {
    expect(clampClaudeEffort(CLAUDE_CATALOG, "sonnet", "high")).toBe("high");
  });
  test("モデル切替先がeffort非対応(haiku): nullへクランプする（sonnet[high]→haiku）", () => {
    expect(clampClaudeEffort(CLAUDE_CATALOG, "haiku", "high")).toBeNull();
  });
  test("現在値が既にnull・切替先がeffort非対応でもnullのまま", () => {
    expect(clampClaudeEffort(CLAUDE_CATALOG, "haiku", null)).toBeNull();
  });
  test("現在値が切替先の対応リストに無い（例: maxのみ持たないモデル）場合もnullへクランプする", () => {
    const catalog: CatalogResult = {
      available: true, fetchedAt: "2026-07-08T00:00:00.000Z",
      models: [{ id: "sonnet", displayName: "Sonnet", description: "", efforts: [{ id: "low" }, { id: "medium" }] }],
    };
    expect(clampClaudeEffort(catalog, "sonnet", "xhigh")).toBeNull();
  });
  test("カタログ不可時は判定材料が無いため現在値をそのまま維持する（clampしない）", () => {
    expect(clampClaudeEffort(undefined, "haiku", "high")).toBe("high");
    expect(clampClaudeEffort(UNAVAILABLE_CATALOG, "haiku", "high")).toBe("high");
  });
});
