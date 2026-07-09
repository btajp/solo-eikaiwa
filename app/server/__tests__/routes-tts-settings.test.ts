import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq, putJson } from "./helpers/http";
import type { TtsSettings } from "../tts";

describe("tts-settings API", () => {
  test("GET: 未設定なら null 値 + 既定 + apiKeyConfigured を返す", async () => {
    const { deps } = makeTestDeps({ getTtsSettings: () => null, ttsEnv: () => ({ apiKeyConfigured: false }) });
    const res = await makeFetchHandler(deps)(getReq("/api/tts-settings"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      provider: "auto",
      baseUrl: null, model: null, voice: null,
      apiKeyConfigured: false,
      defaults: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini-tts", voice: "alloy" },
    });
  });

  test("GET: 保存済み設定を反映する", async () => {
    const { deps } = makeTestDeps({
      getTtsSettings: () => ({ baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky" }),
      ttsEnv: () => ({ apiKeyConfigured: true }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/tts-settings"));
    const body = await res.json();
    expect(body.baseUrl).toBe("http://localhost:8880/v1");
    expect(body.model).toBe("kokoro");
    expect(body.voice).toBe("af_sky");
    expect(body.apiKeyConfigured).toBe(true);
  });

  test("PUT: 正常値を保存し、保存後のビューを返す", async () => {
    const saved: TtsSettings[] = [];
    let current: TtsSettings | null = null;
    const { deps } = makeTestDeps({
      getTtsSettings: () => current,
      saveTtsSettings: (s) => { saved.push(s); current = s; },
      ttsEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/tts-settings", {
      baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky",
    }));
    expect(res.status).toBe(200);
    expect(saved).toEqual([{ baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky" }]);
    expect((await res.json()).baseUrl).toBe("http://localhost:8880/v1");
  });

  test("PUT: 空文字/未指定は null（既定へ戻す）として保存する", async () => {
    const saved: TtsSettings[] = [];
    const { deps } = makeTestDeps({ saveTtsSettings: (s) => saved.push(s), getTtsSettings: () => null });
    const res = await makeFetchHandler(deps)(putJson("/api/tts-settings", { baseUrl: "", model: "", voice: "" }));
    expect(res.status).toBe(200);
    expect(saved).toEqual([{ baseUrl: null, model: null, voice: null }]);
  });

  test("PUT 400: baseUrl が http(s) でない・保存しない", async () => {
    const saved: TtsSettings[] = [];
    const { deps } = makeTestDeps({ saveTtsSettings: (s) => saved.push(s), getTtsSettings: () => null });
    const h = makeFetchHandler(deps);
    expect((await h(putJson("/api/tts-settings", { baseUrl: "not-a-url" }))).status).toBe(400);
    expect((await h(putJson("/api/tts-settings", { baseUrl: "ftp://x/y" }))).status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test("PUT: provider を保存できる（say/openai-compat/auto）・不正値は 400 で何も保存しない", async () => {
    const savedProviders: string[] = [];
    const savedSettings: TtsSettings[] = [];
    let current = "auto" as "auto" | "say" | "openai-compat";
    const { deps } = makeTestDeps({
      getTtsSettings: () => null,
      saveTtsSettings: (s) => savedSettings.push(s),
      getTtsProvider: () => current,
      saveTtsProvider: (p) => { savedProviders.push(p); current = p; },
      ttsEnv: () => ({ apiKeyConfigured: false }),
    });
    const h = makeFetchHandler(deps);
    const ok = await h(putJson("/api/tts-settings", { provider: "say" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).provider).toBe("say");
    expect(savedProviders).toEqual(["say"]);

    const bad = await h(putJson("/api/tts-settings", { provider: "sparkle" }));
    expect(bad.status).toBe(400);
    expect(savedProviders).toEqual(["say"]);
    expect(savedSettings).toHaveLength(1); // 不正 provider のリクエストでは settings も保存されない
  });

  test("PUT: provider 未指定なら変更しない（settings のみ更新）", async () => {
    const savedProviders: string[] = [];
    const { deps } = makeTestDeps({
      getTtsSettings: () => null,
      getTtsProvider: () => "say",
      saveTtsProvider: (p) => savedProviders.push(p),
      ttsEnv: () => ({ apiKeyConfigured: false }),
    });
    const res = await makeFetchHandler(deps)(putJson("/api/tts-settings", { voice: "af_sky" }));
    expect(res.status).toBe(200);
    expect((await res.json()).provider).toBe("say");
    expect(savedProviders).toHaveLength(0);
  });
});
