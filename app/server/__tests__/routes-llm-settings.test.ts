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
