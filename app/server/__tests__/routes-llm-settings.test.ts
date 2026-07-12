import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq, putJson } from "./helpers/http";
import type { LlmSettings, LlmRole } from "../llm-provider";
import type { RoleTuning } from "../llm-role-tuning-store";
import type { AuthMode, LlmAuthModes, LlmAuthProvider } from "../llm-auth-store";

describe("llm-settings API", () => {
  test("GET: 未設定なら provider:env と env 情報を返す（APIキーは boolean のみ）", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: "claude", baseUrl: null, model: null, openaiModel: null, codexModel: null,
      apiKeyConfigured: false,
      apiKeyApproved: false,
      openAiKeyConfigured: false,
      roles: {
        conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
      globalTuning: { claudeModel: null, effort: null, serviceTier: null },
      tuning: {
        conversation: { claudeModel: null, effort: null, serviceTier: null },
        assist: { claudeModel: null, effort: null, serviceTier: null },
        coaching: { claudeModel: null, effort: null, serviceTier: null },
        generation: { claudeModel: null, effort: null, serviceTier: null },
        assessment: { claudeModel: null, effort: null, serviceTier: null },
      },
      authModes: { claude: "subscription", codex: "subscription" },
      authKeys: { anthropic: false, codex: false },
    });
  });

  test("GET: 保存済み openai-compat 設定を返す（apiKeyConfigured=true）", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null }),
      llmEnv: () => ({ apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    expect(await res.json()).toEqual({
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", openaiModel: null, codexModel: null,
      apiKeyConfigured: true,
      apiKeyApproved: false,
      openAiKeyConfigured: false,
      roles: {
        conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
      globalTuning: { claudeModel: null, effort: null, serviceTier: null },
      tuning: {
        conversation: { claudeModel: null, effort: null, serviceTier: null },
        assist: { claudeModel: null, effort: null, serviceTier: null },
        coaching: { claudeModel: null, effort: null, serviceTier: null },
        generation: { claudeModel: null, effort: null, serviceTier: null },
        assessment: { claudeModel: null, effort: null, serviceTier: null },
      },
      authModes: { claude: "subscription", codex: "subscription" },
      authKeys: { anthropic: false, codex: false },
    });
  });

  test("PUT openai-compat: 検証通過で save & apply され applied:true を返す", async () => {
    const saved: LlmSettings[] = [];
    const applied: LlmSettings[] = [];
    let current: LlmSettings | null = null;
    const { deps } = makeTestDeps({
      getLlmSettings: () => current,
      saveLlmSettings: (s) => { saved.push(s); current = s; },
      applyLlmSettings: (s) => { applied.push(s); },
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings", {
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3",
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", applied: true, error: null,
    });
    expect(saved[0]).toEqual({
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", openaiModel: null, codexModel: null,
    });
    expect(applied[0]).toEqual(saved[0]);
  });

  test("PUT openai-compat: codexModel も接続ストアとして保持する（接続分離 v2）", async () => {
    const saved: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    await makeFetchHandler(deps)(putJson("/api/llm-settings", {
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", openaiModel: null, codexModel: "gpt-5-codex",
    }));
    expect(saved[0]).toEqual({
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "qwen3", openaiModel: null, codexModel: "gpt-5-codex",
    });
  });

  test("PUT codex: 任意 model を保存する（baseUrl/model は null）", async () => {
    const saved: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    await makeFetchHandler(deps)(putJson("/api/llm-settings", { provider: "codex", codexModel: "o4-mini" }));
    expect(saved[0]).toEqual({ provider: "codex", baseUrl: null, model: null, openaiModel: null, codexModel: "o4-mini" });
  });

  test("PUT openai: 公式モデルを専用バンクへ保存し、互換設定も保持する", async () => {
    const saved: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s),
      getLlmSettings: () => null,
      llmEnv: () => ({ apiKeyConfigured: false, openAiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings", {
      provider: "openai",
      openaiModel: "gpt-4.1-mini",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
      codexModel: "gpt-5-codex",
    }));
    expect(res.status).toBe(200);
    expect(saved[0]).toEqual({
      provider: "openai",
      openaiModel: "gpt-4.1-mini",
      baseUrl: "http://localhost:11434/v1",
      model: "llama3",
      codexModel: "gpt-5-codex",
    });
  });

  test("PUT 400: 廃止済みの provider \"env\" は拒否し、何も保存しない", async () => {
    const saved: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings", { provider: "env" }));
    expect(res.status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test("PUT 400: 不正 provider・openai-compat の baseUrl 欠落/不正URL・model 欠落（保存しない）", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const h = makeFetchHandler(deps);
    expect((await h(putJson("/api/llm-settings", { provider: "gemini" }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings", { provider: "openai-compat", model: "m" }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings", { provider: "openai-compat", baseUrl: "not a url", model: "m" }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings", { provider: "openai-compat", baseUrl: "http://localhost/v1" }))).status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test("openai-compat baseUrlを正規化し、userinfo・query・fragmentを拒否する", async () => {
    const saved: LlmSettings[] = [];
    const { deps } = makeTestDeps({ saveLlmSettings: (s) => { saved.push(s); } });
    const h = makeFetchHandler(deps);
    const ok = await h(putJson("/api/llm-settings", {
      provider: "openai-compat", baseUrl: "HTTPS://Models.Example:443/v1/", model: "m",
    }));
    expect(ok.status).toBe(200);
    expect(saved[0]?.baseUrl).toBe("https://models.example/v1");
    for (const baseUrl of ["https://u:p@example.com/v1", "https://example.com/v1?q=1", "https://example.com/v1#x"]) {
      expect((await h(putJson("/api/llm-settings", { provider: "openai-compat", baseUrl, model: "m" }))).status, baseUrl).toBe(400);
    }
  });

  test("PUT: apply が throw しても保存は成功扱いで applied:false + error を返す（crash化させない）", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "claude", baseUrl: null, model: null, codexModel: null }),
      saveLlmSettings: () => {},
      applyLlmSettings: () => { throw new Error("boom apply"); },
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings", { provider: "claude" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: false, error: "boom apply" });
  });
});

describe("llm-settings roles API", () => {
  test("GET: 保存済みロール上書きを roles に反映する", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmRoleSettings: () => ({
        conversation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null },
        assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      }),
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    expect((await res.json()).roles.conversation).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
  });

  test("PUT /roles: OpenAI公式を互換URLなしで用途へ割り当てられる", async () => {
    const saved: Array<{ role: LlmRole; settings: unknown }> = [];
    const { deps } = makeTestDeps({
      saveLlmRoleSettings: (role, settings) => saved.push({ role, settings }),
      llmEnv: () => ({ apiKeyConfigured: false, openAiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      roles: { conversation: { provider: "openai", model: "gpt-4.1-mini" } },
    }));
    expect(res.status).toBe(200);
    expect(saved).toEqual([{
      role: "conversation",
      settings: { provider: "openai", baseUrl: null, model: "gpt-4.1-mini", codexModel: null },
    }]);
  });

  test("PUT /roles: 個別ロール上書きを保存し applied:true を返す", async () => {
    const savedRoles: Array<{ role: string; s: LlmSettings & { provider: string } }> = [];
    const appliedGlobals: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleSettings: (role, s) => savedRoles.push({ role, s: s as never }),
      applyLlmSettings: (s) => appliedGlobals.push(s),
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      roles: { generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3" } },
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: true, error: null });
    expect(savedRoles).toEqual([{ role: "generation", s: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null } }]);
    // 保存後に「現在の全体設定 + 保存済みロール」で再解決する（effectiveGlobal は未設定→既定 claude）
    expect(appliedGlobals).toEqual([{
      provider: "claude", baseUrl: null, model: null, openaiModel: null, codexModel: null,
    }]);
  });

  test("PUT /roles: global も同時に更新できる（全体設定 + ロールを一括保存）", async () => {
    const savedGlobals: LlmSettings[] = [];
    const savedRoles: string[] = [];
    let current: LlmSettings | null = null;
    const { deps } = makeTestDeps({
      getLlmSettings: () => current,
      saveLlmSettings: (s) => { savedGlobals.push(s); current = s; },
      saveLlmRoleSettings: (role) => savedRoles.push(role),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      global: { provider: "claude" },
      roles: {
        conversation: { provider: "inherit" }, assist: { provider: "inherit" }, coaching: { provider: "inherit" },
        generation: { provider: "inherit" }, assessment: { provider: "inherit" },
      },
    }));
    expect(savedGlobals).toEqual([{
      provider: "claude", baseUrl: null, model: null, openaiModel: null, codexModel: null,
    }]);
    expect(savedRoles.sort()).toEqual(["assessment", "assist", "coaching", "conversation", "generation"]);
  });

  test("PUT /roles 400: 未知ロール・不正 provider・openai-compat の欠落（保存しない）", async () => {
    const saved: string[] = [];
    const { deps } = makeTestDeps({
      saveLlmRoleSettings: (role) => saved.push(role), getLlmSettings: () => null,
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const h = makeFetchHandler(deps);
    expect((await h(putJson("/api/llm-settings/roles", { roles: { unknownRole: { provider: "claude" } } }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings/roles", { roles: { coaching: { provider: "env" } } }))).status).toBe(400); // env はロール不可
    expect((await h(putJson("/api/llm-settings/roles", { roles: { coaching: { provider: "openai-compat", model: "m" } } }))).status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test("PUT /roles 400: global+複数ロール一括で一部が不正なら何も保存しない（部分適用防止）", async () => {
    const savedGlobals: LlmSettings[] = [];
    const savedRoles: string[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmSettings: (s) => savedGlobals.push(s),
      saveLlmRoleSettings: (role) => savedRoles.push(role),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      global: { provider: "claude" },
      roles: {
        conversation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3" },
        coaching: { provider: "bogus" },
      },
    }));
    expect(res.status).toBe(400);
    expect(savedGlobals).toHaveLength(0);
    expect(savedRoles).toHaveLength(0);
  });
});

describe("llm-settings tuning API", () => {
  const ALL_NULL_TUNING: Record<LlmRole, RoleTuning> = {
    conversation: { claudeModel: null, effort: null, serviceTier: null },
    assist: { claudeModel: null, effort: null, serviceTier: null },
    coaching: { claudeModel: null, effort: null, serviceTier: null },
    generation: { claudeModel: null, effort: null, serviceTier: null },
    assessment: { claudeModel: null, effort: null, serviceTier: null },
  };

  test("GET: 保存済みチューニングを additive に tuning へ反映する", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmRoleTuning: () => ({
        ...ALL_NULL_TUNING,
        assessment: { claudeModel: "opus", effort: "xhigh", serviceTier: "standard" },
      }),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    const body = (await res.json()) as { tuning: Record<LlmRole, RoleTuning> };
    expect(body.tuning.assessment).toEqual({ claudeModel: "opus", effort: "xhigh", serviceTier: "standard" });
    expect(body.tuning.conversation).toEqual({ claudeModel: null, effort: null, serviceTier: null });
  });

  test("PUT /roles: tuning 込みで保存され、応答の tuning に反映される", async () => {
    let current: Record<LlmRole, RoleTuning> = { ...ALL_NULL_TUNING };
    const savedPatches: Array<Partial<Record<LlmRole, Partial<RoleTuning>>>> = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmRoleTuning: () => current,
      saveLlmRoleTuning: (t) => {
        savedPatches.push(t);
        current = { ...current, ...(t as Record<LlmRole, RoleTuning>) };
      },
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: {
        conversation: { claudeModel: "sonnet", effort: "low", serviceTier: null },
        assessment: { claudeModel: "opus", effort: "xhigh", serviceTier: "standard" },
      },
    }));
    expect(res.status).toBe(200);
    expect(savedPatches).toEqual([{
      conversation: { claudeModel: "sonnet", effort: "low", serviceTier: null },
      assessment: { claudeModel: "opus", effort: "xhigh", serviceTier: "standard" },
    }]);
    const body = (await res.json()) as { tuning: Record<LlmRole, RoleTuning> };
    expect(body.tuning.conversation).toEqual({ claudeModel: "sonnet", effort: "low", serviceTier: null });
    expect(body.tuning.assessment).toEqual({ claudeModel: "opus", effort: "xhigh", serviceTier: "standard" });
  });

  test("PUT /roles: tuning 省略時は saveLlmRoleTuning を呼ばない（既存挙動不変）", async () => {
    const savedPatches: unknown[] = [];
    const savedRoles: string[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      saveLlmRoleSettings: (role) => savedRoles.push(role),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      roles: { generation: { provider: "inherit" } },
    }));
    expect(res.status).toBe(200);
    expect(savedPatches).toHaveLength(0);
    expect(savedRoles).toEqual(["generation"]);
  });

  test("PUT /roles 400: 未知ロール（tuning 側）は何も保存しない", async () => {
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { bogusRole: { claudeModel: "sonnet" } },
    }));
    expect(res.status).toBe(400);
    expect(savedPatches).toHaveLength(0);
  });

  test.each([
    // claudeModel はホワイトリスト廃止（v0.29）: 形式違反（空白のみ）だけを拒否する
    ["claudeModel", { claudeModel: "   " }],
    ["effort", { effort: "urgent" }],
    ["serviceTier", { serviceTier: "priority" }],
  ])("PUT /roles 400: tuning.%s の不正値は 400（保存しない）", async (_field, patch) => {
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { conversation: patch },
    }));
    expect(res.status).toBe(400);
    expect(savedPatches).toHaveLength(0);
  });

  test("PUT /roles 400: global+roles+tuning 一括で tuning だけ不正でも何も保存しない（原子性）", async () => {
    const savedGlobals: LlmSettings[] = [];
    const savedRoles: string[] = [];
    const savedTuning: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmSettings: (s) => savedGlobals.push(s),
      saveLlmRoleSettings: (role) => savedRoles.push(role),
      saveLlmRoleTuning: (t) => savedTuning.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      global: { provider: "claude" },
      roles: { conversation: { provider: "inherit" } },
      tuning: { assessment: { effort: "bogus" } },
    }));
    expect(res.status).toBe(400);
    expect(savedGlobals).toHaveLength(0);
    expect(savedRoles).toHaveLength(0);
    expect(savedTuning).toHaveLength(0);
  });

  test("PUT /roles: effort \"max\" は受理される（claude opus/sonnet の実カタログ効果に対応）", async () => {
    const savedPatches: Array<Partial<Record<LlmRole, Partial<RoleTuning>>>> = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { assessment: { effort: "max" } },
    }));
    expect(res.status).toBe(200);
    expect(savedPatches).toEqual([{ assessment: { effort: "max" } }]);
  });

  test("PUT /roles 400: codex 割当ロール（今回のリクエストで割当）の effort \"max\" は拒否される（codex は low/medium/high/xhigh のみ対応）", async () => {
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      roles: { assessment: { provider: "codex" } },
      tuning: { assessment: { effort: "max" } },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/effort must be one of low, medium, high, xhigh( or null)?$/);
    expect(savedPatches).toHaveLength(0);
  });

  test("PUT /roles: claude 割当ロール（今回のリクエストで割当）の effort \"max\" は許可される", async () => {
    const savedPatches: Array<Partial<Record<LlmRole, Partial<RoleTuning>>>> = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      roles: { assessment: { provider: "claude" } },
      tuning: { assessment: { effort: "max" } },
    }));
    expect(res.status).toBe(200);
    expect(savedPatches).toEqual([{ assessment: { effort: "max" } }]);
  });

  test("PUT /roles 400: 既存保存済みで codex 割当のロール（今回は roles を送らない）は effort \"max\" を拒否される", async () => {
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmRoleSettings: () => ({
        conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "codex", baseUrl: null, model: null, codexModel: "gpt-5.4" },
      }),
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { assessment: { effort: "max" } },
    }));
    expect(res.status).toBe(400);
    expect(savedPatches).toHaveLength(0);
  });

  test("PUT /roles 400: inherit ロールは今回のリクエストの global 変更（codex）へ解決し effort \"max\" を拒否する", async () => {
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      global: { provider: "codex" },
      tuning: { assessment: { effort: "max" } },
    }));
    expect(res.status).toBe(400);
    expect(savedPatches).toHaveLength(0);
  });

  test("PUT /roles 400: inherit ロールは保存済み global（codex）へ解決し effort \"max\" を拒否する（今回 global は送らない）", async () => {
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "codex", baseUrl: null, model: null, codexModel: "gpt-5.4" }),
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { assessment: { effort: "max" } },
    }));
    expect(res.status).toBe(400);
    expect(savedPatches).toHaveLength(0);
  });

  test("PUT /roles 200: global 未設定（既定 claude）なら inherit ロールの effort \"max\" は許可される（env は effort 判定に関与しない）", async () => {
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { assessment: { effort: "max" } },
    }));
    expect(res.status).toBe(200);
    expect(savedPatches).toHaveLength(1);
  });

  test("PUT /roles: tuning.global を保存できる（claudeModel は任意のモデルID・カタログ由来の値をそのまま受ける）", async () => {
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { global: { claudeModel: "claude-fable-5", effort: "high" } },
    }));
    expect(res.status).toBe(200);
    expect(savedPatches).toEqual([{ global: { claudeModel: "claude-fable-5", effort: "high" } }]);
  });

  test("PUT /roles 400: claudeModel の形式違反（空白のみ・200字超・非文字列）は拒否し何も保存しない", async () => {
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const h = makeFetchHandler(deps);
    expect((await h(putJson("/api/llm-settings/roles", { tuning: { global: { claudeModel: "   " } } }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings/roles", { tuning: { global: { claudeModel: "x".repeat(201) } } }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings/roles", { tuning: { conversation: { claudeModel: 42 } } }))).status).toBe(400);
    expect(savedPatches).toHaveLength(0);
  });

  test("PUT /roles 400: global provider=claude でも、codex に解決されるロールが1つでもあれば tuning.global.effort \"max\" は拒否する", async () => {
    // global 行の effort は全ロールへプロバイダ横断でマージされるため、codex 割当ロールが存在する状態で
    // global effort=max を許すと「保存できるが実行時に codex で失敗する」設定を作れてしまう。
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "claude", baseUrl: null, model: null, codexModel: null }),
      getLlmRoleSettings: () => ({
        conversation: { provider: "codex", baseUrl: null, model: null, codexModel: "gpt-5.5" },
        assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      }),
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { global: { effort: "max" } },
    }));
    expect(res.status).toBe(400);
    expect(savedPatches).toHaveLength(0);
  });

  test("PUT /roles 400: global provider=codex のとき tuning.global.effort \"max\" は拒否する", async () => {
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "codex", baseUrl: null, model: null, codexModel: null }),
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { global: { effort: "max" } },
    }));
    expect(res.status).toBe(400);
    expect(savedPatches).toHaveLength(0);
  });

  test("PUT /roles 400: assist=inherit は coaching の実効プロバイダへ連鎖して解決する（coaching=codex・global=claude でも assist の effort \"max\" は拒否される）", async () => {
    // converse.ts の applyLlmRoleSettings（assist の連鎖規則・binding）と同じセマンティクス: assist が inherit の間、
    // assist は global ではなく coaching の解決結果をそのまま使う。effort 検証もこれに合わせないと、
    // 「保存はできるが実行時に codex へ max がそのまま渡って失敗する」設定を作れてしまう。
    const savedPatches: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "claude", baseUrl: null, model: null, codexModel: null }),
      getLlmRoleSettings: () => ({
        conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "codex", baseUrl: null, model: null, codexModel: "gpt-5.4" },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      }),
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { assist: { effort: "max" } },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/effort must be one of low, medium, high, xhigh/);
    expect(savedPatches).toHaveLength(0);
  });

  test("PUT /roles: assist=inherit で coaching=claude（global=codex でも）なら assist の effort \"max\" は許可される（連鎖の鏡像ケース）", async () => {
    const savedPatches: Array<Partial<Record<LlmRole, Partial<RoleTuning>>>> = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "codex", baseUrl: null, model: null, codexModel: "gpt-5.4" }),
      getLlmRoleSettings: () => ({
        conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assist: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "claude", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      }),
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { assist: { effort: "max" } },
    }));
    expect(res.status).toBe(200);
    expect(savedPatches).toEqual([{ assist: { effort: "max" } }]);
  });

  test("PUT /roles: null で明示クリアできる（クリアと未指定は区別される）", async () => {
    const savedPatches: Array<Partial<Record<LlmRole, Partial<RoleTuning>>>> = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmRoleTuning: (t) => savedPatches.push(t),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      tuning: { coaching: { claudeModel: null, effort: "medium" } },
    }));
    expect(res.status).toBe(200);
    expect(savedPatches).toEqual([{ coaching: { claudeModel: null, effort: "medium" } }]);
  });
});

describe("llm-settings auth API", () => {
  test("GET: 既定は subscription/subscription・authKeys は env 検出のみ", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    const body = (await res.json()) as { authModes: LlmAuthModes; authKeys: { anthropic: boolean; codex: boolean } };
    expect(body.authModes).toEqual({ claude: "subscription", codex: "subscription" });
    expect(body.authKeys).toEqual({ anthropic: false, codex: false });
  });

  test("GET: 保存済み認証モードを additive に authModes へ反映する", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmAuthModes: (): LlmAuthModes => ({ claude: "api-key", codex: "subscription" }),
      getAuthKeysConfigured: () => ({ anthropic: true, codex: false }),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    const body = (await res.json()) as { authModes: LlmAuthModes; authKeys: { anthropic: boolean; codex: boolean } };
    expect(body.authModes).toEqual({ claude: "api-key", codex: "subscription" });
    expect(body.authKeys).toEqual({ anthropic: true, codex: false });
  });

  test("PUT /roles: claude を api-key へ切替え保存され、ランタイムキャッシュへ push される（キー設定済み）", async () => {
    const savedModes: Array<{ provider: LlmAuthProvider; mode: AuthMode }> = [];
    const appliedModes: LlmAuthModes[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmAuthModes: (): LlmAuthModes => ({ claude: "subscription", codex: "subscription" }),
      getAuthKeysConfigured: () => ({ anthropic: true, codex: false }),
      saveLlmAuthMode: (provider, mode) => savedModes.push({ provider, mode }),
      applyLlmAuthModes: (modes) => appliedModes.push(modes),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      auth: { claude: "api-key" },
    }));
    expect(res.status).toBe(200);
    expect(savedModes).toEqual([{ provider: "claude", mode: "api-key" }]);
    expect(appliedModes).toEqual([{ claude: "subscription", codex: "subscription" }]);
    const body = (await res.json()) as { authModes: LlmAuthModes };
    expect(body.authModes).toEqual({ claude: "subscription", codex: "subscription" }); // deps.getLlmAuthModes は固定フェイクのまま（保存反映はテスト対象外）
  });

  test("PUT /roles 400: claude を api-key へ切替えようとしてもキー未設定なら 400（保存しない）", async () => {
    const savedModes: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getAuthKeysConfigured: () => ({ anthropic: false, codex: false }),
      saveLlmAuthMode: (provider, mode) => savedModes.push({ provider, mode }),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      auth: { claude: "api-key" },
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "anthropic api key is not configured; save it in settings before selecting api-key mode",
    });
    expect(savedModes).toHaveLength(0);
  });

  test("PUT /roles 400: codex を api-key へ切替えようとしてもキー未設定なら 400（保存しない・ensureCodexApiKeyHome も呼ばない）", async () => {
    const savedModes: unknown[] = [];
    const ensureCalls: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getAuthKeysConfigured: () => ({ anthropic: false, codex: false }),
      saveLlmAuthMode: (provider, mode) => savedModes.push({ provider, mode }),
      ensureCodexApiKeyHome: async () => { ensureCalls.push(true); return "/fake"; },
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      auth: { codex: "api-key" },
    }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "codex api key is not configured; save it in settings before selecting api-key mode",
    });
    expect(savedModes).toHaveLength(0);
    expect(ensureCalls).toHaveLength(0);
  });

  test("PUT /roles: codex を api-key へ切替えると ensureCodexApiKeyHome を await してから保存し、registry を kill する", async () => {
    const order: string[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmAuthModes: (): LlmAuthModes => ({ claude: "subscription", codex: "subscription" }),
      getAuthKeysConfigured: () => ({ anthropic: false, codex: true }),
      saveLlmAuthMode: () => order.push("save"),
      ensureCodexApiKeyHome: async () => { order.push("ensure"); return "/fake/codex-home"; },
      killCodexAppServerRegistry: () => order.push("kill"),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      auth: { codex: "api-key" },
    }));
    expect(res.status).toBe(200);
    expect(order).toEqual(["ensure", "save", "kill"]);
  });

  test("PUT /roles: codex を api-key から subscription へ戻す場合も registry を kill する（両方向）", async () => {
    const killCalls: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmAuthModes: (): LlmAuthModes => ({ claude: "subscription", codex: "api-key" }),
      getAuthKeysConfigured: () => ({ anthropic: false, codex: true }),
      killCodexAppServerRegistry: () => killCalls.push(true),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      auth: { codex: "subscription" },
    }));
    expect(res.status).toBe(200);
    expect(killCalls).toHaveLength(1);
  });

  test("PUT /roles: codex の値が変わらない場合は registry を kill しない", async () => {
    const killCalls: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmAuthModes: (): LlmAuthModes => ({ claude: "subscription", codex: "subscription" }),
      getAuthKeysConfigured: () => ({ anthropic: false, codex: true }),
      killCodexAppServerRegistry: () => killCalls.push(true),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      auth: { codex: "subscription" },
    }));
    expect(res.status).toBe(200);
    expect(killCalls).toHaveLength(0);
  });

  test("PUT /roles: claude だけの切替では codex の registry kill は呼ばない", async () => {
    const killCalls: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getLlmAuthModes: (): LlmAuthModes => ({ claude: "subscription", codex: "subscription" }),
      getAuthKeysConfigured: () => ({ anthropic: true, codex: false }),
      killCodexAppServerRegistry: () => killCalls.push(true),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      auth: { claude: "api-key" },
    }));
    expect(res.status).toBe(200);
    expect(killCalls).toHaveLength(0);
  });

  test("PUT /roles 400: auth に不正な値（未知の文字列）は 400（保存しない）", async () => {
    const savedModes: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmAuthMode: (provider, mode) => savedModes.push({ provider, mode }),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      auth: { claude: "trial" },
    }));
    expect(res.status).toBe(400);
    expect(savedModes).toHaveLength(0);
  });

  test("PUT /roles: codex ログイン（ensureCodexApiKeyHome）が実行時に失敗したら global/roles/tuning/auth のいずれも保存しない（原子性）", async () => {
    const savedGlobals: LlmSettings[] = [];
    const savedRoles: string[] = [];
    const savedTuning: unknown[] = [];
    const savedModes: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getAuthKeysConfigured: () => ({ anthropic: false, codex: true }),
      saveLlmSettings: (s) => savedGlobals.push(s),
      saveLlmRoleSettings: (role) => savedRoles.push(role),
      saveLlmRoleTuning: (t) => savedTuning.push(t),
      saveLlmAuthMode: (provider, mode) => savedModes.push({ provider, mode }),
      ensureCodexApiKeyHome: async () => {
        throw new Error("codex login --with-api-key failed (exit 1): boom");
      },
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      roles: { generation: { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3" } },
      tuning: { assessment: { effort: "high" } },
      auth: { codex: "api-key" },
    }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/boom/);
    expect(savedGlobals).toHaveLength(0);
    expect(savedRoles).toHaveLength(0);
    expect(savedTuning).toHaveLength(0);
    expect(savedModes).toHaveLength(0);
  });

  test("PUT /roles 400: global+roles+tuning+auth 一括で auth だけ不正でも何も保存しない（原子性）", async () => {
    const savedGlobals: LlmSettings[] = [];
    const savedRoles: string[] = [];
    const savedTuning: unknown[] = [];
    const savedModes: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmSettings: (s) => savedGlobals.push(s),
      saveLlmRoleSettings: (role) => savedRoles.push(role),
      saveLlmRoleTuning: (t) => savedTuning.push(t),
      saveLlmAuthMode: (provider, mode) => savedModes.push({ provider, mode }),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      global: { provider: "claude" },
      roles: { conversation: { provider: "inherit" } },
      tuning: { assessment: { effort: "medium" } },
      auth: { claude: "bogus-mode" },
    }));
    expect(res.status).toBe(400);
    expect(savedGlobals).toHaveLength(0);
    expect(savedRoles).toHaveLength(0);
    expect(savedTuning).toHaveLength(0);
    expect(savedModes).toHaveLength(0);
  });

  test("PUT /roles: レスポンスボディに APIキーの値が一切含まれない（authKeys は boolean のみ）", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      getAuthKeysConfigured: () => ({ anthropic: true, codex: true }),
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      auth: { claude: "subscription" },
    }));
    const raw = await res.text();
    expect(raw).not.toMatch(/sk-|api[_-]?key['"]?\s*:\s*['"](?!true|false)/i);
    const body = JSON.parse(raw) as { authKeys: unknown };
    expect(body.authKeys).toEqual({ anthropic: true, codex: true });
  });

  test("PUT /roles: auth 省略時は saveLlmAuthMode・ensureCodexApiKeyHome・killCodexAppServerRegistry を一切呼ばない（既存挙動不変）", async () => {
    const savedModes: unknown[] = [];
    const ensureCalls: unknown[] = [];
    const killCalls: unknown[] = [];
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      saveLlmAuthMode: (provider, mode) => savedModes.push({ provider, mode }),
      ensureCodexApiKeyHome: async () => { ensureCalls.push(true); return "/fake"; },
      killCodexAppServerRegistry: () => killCalls.push(true),
      llmEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      roles: { generation: { provider: "inherit" } },
    }));
    expect(res.status).toBe(200);
    expect(savedModes).toHaveLength(0);
    expect(ensureCalls).toHaveLength(0);
    expect(killCalls).toHaveLength(0);
  });
});
