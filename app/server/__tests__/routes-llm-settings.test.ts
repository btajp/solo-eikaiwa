import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq, putJson } from "./helpers/http";
import type { LlmSettings } from "../llm-provider";

describe("llm-settings API", () => {
  test("GET: 未設定なら provider:env と env 情報を返す（APIキーは boolean のみ）", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: "env", baseUrl: null, model: null, codexModel: null,
      apiKeyConfigured: false, envProvider: "claude",
      roles: {
        conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
    });
  });

  test("GET: 保存済み openai-compat 設定を返す（apiKeyConfigured=true）", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null }),
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    expect(await res.json()).toEqual({
      provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null,
      apiKeyConfigured: true, envProvider: "claude",
      roles: {
        conversation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      },
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
    expect(saved[0]).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
    expect(applied[0]).toEqual(saved[0]);
  });

  test("PUT codex: 任意 model を保存する（baseUrl/model は null）", async () => {
    const saved: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    await makeFetchHandler(deps)(putJson("/api/llm-settings", { provider: "codex", codexModel: "o4-mini" }));
    expect(saved[0]).toEqual({ provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" });
  });

  test("PUT env: リセットとして provider:env を保存する", async () => {
    const saved: LlmSettings[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    await makeFetchHandler(deps)(putJson("/api/llm-settings", { provider: "env" }));
    expect(saved[0]).toEqual({ provider: "env", baseUrl: null, model: null, codexModel: null });
  });

  test("PUT 400: 不正 provider・openai-compat の baseUrl 欠落/不正URL・model 欠落（保存しない）", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({
      saveLlmSettings: (s) => saved.push(s), getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    const h = makeFetchHandler(deps);
    expect((await h(putJson("/api/llm-settings", { provider: "gemini" }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings", { provider: "openai-compat", model: "m" }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings", { provider: "openai-compat", baseUrl: "not a url", model: "m" }))).status).toBe(400);
    expect((await h(putJson("/api/llm-settings", { provider: "openai-compat", baseUrl: "http://x/v1" }))).status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test("PUT: apply が throw しても保存は成功扱いで applied:false + error を返す（crash化させない）", async () => {
    const { deps } = makeTestDeps({
      getLlmSettings: () => ({ provider: "claude", baseUrl: null, model: null, codexModel: null }),
      saveLlmSettings: () => {},
      applyLlmSettings: () => { throw new Error("boom apply"); },
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
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
        coaching: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        generation: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
        assessment: { provider: "inherit", baseUrl: null, model: null, codexModel: null },
      }),
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-settings"));
    expect((await res.json()).roles.conversation).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
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
    // 保存後に「現在の全体設定 + 保存済みロール」で再解決する（effectiveGlobal は未設定→env）
    expect(appliedGlobals).toEqual([{ provider: "env", baseUrl: null, model: null, codexModel: null }]);
  });

  test("PUT /roles: global も同時に更新できる（全体設定 + ロールを一括保存）", async () => {
    const savedGlobals: LlmSettings[] = [];
    const savedRoles: string[] = [];
    let current: LlmSettings | null = null;
    const { deps } = makeTestDeps({
      getLlmSettings: () => current,
      saveLlmSettings: (s) => { savedGlobals.push(s); current = s; },
      saveLlmRoleSettings: (role) => savedRoles.push(role),
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
    });
    await makeFetchHandler(deps)(putJson("/api/llm-settings/roles", {
      global: { provider: "env" },
      roles: {
        conversation: { provider: "inherit" }, coaching: { provider: "inherit" },
        generation: { provider: "inherit" }, assessment: { provider: "inherit" },
      },
    }));
    expect(savedGlobals).toEqual([{ provider: "env", baseUrl: null, model: null, codexModel: null }]);
    expect(savedRoles.sort()).toEqual(["assessment", "coaching", "conversation", "generation"]);
  });

  test("PUT /roles 400: 未知ロール・不正 provider・openai-compat の欠落（保存しない）", async () => {
    const saved: string[] = [];
    const { deps } = makeTestDeps({
      saveLlmRoleSettings: (role) => saved.push(role), getLlmSettings: () => null,
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
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
      llmEnv: () => ({ provider: "claude", apiKeyConfigured: false }),
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
