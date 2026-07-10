import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq, putJson } from "./helpers/http";
import type { SecretName, SecretStatus } from "../secrets";

function delReq(path: string): Request {
  return new Request(`http://localhost${path}`, { method: "DELETE" });
}

const EMPTY_STATUS: Record<SecretName, SecretStatus> = {
  ANTHROPIC_API_KEY: { configured: false, source: null },
  CODEX_API_KEY: { configured: false, source: null },
  OPENAI_COMPAT_API_KEY: { configured: false, source: null },
  TTS_API_KEY: { configured: false, source: null },
};

describe("secrets API", () => {
  test("GET: 鍵ごとの有無とソースのみを返す（値のフィールド自体が存在しない）", async () => {
    const { deps } = makeTestDeps({
      getSecretsStatus: () => ({
        ...EMPTY_STATUS,
        ANTHROPIC_API_KEY: { configured: true, source: "keychain" },
        TTS_API_KEY: { configured: true, source: "env" },
      }),
    });
    const res = await makeFetchHandler(deps)(getReq("/api/secrets"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ANTHROPIC_API_KEY: { configured: true, source: "keychain" },
      CODEX_API_KEY: { configured: false, source: null },
      OPENAI_COMPAT_API_KEY: { configured: false, source: null },
      TTS_API_KEY: { configured: true, source: "env" },
    });
  });

  test("PUT: 保存 → 再解決が走り、応答（本文全体）に値が一切含まれない", async () => {
    const saved: Array<{ name: string; value: string }> = [];
    let applied = 0;
    const { deps } = makeTestDeps({
      saveSecret: async (name, value) => { saved.push({ name, value }); },
      getSecretsStatus: () => ({ ...EMPTY_STATUS, TTS_API_KEY: { configured: true, source: "keychain" } }),
      applySecretsChange: (name) => { applied++; return { applied: true, error: null }; },
    });
    const res = await makeFetchHandler(deps)(putJson("/api/secrets", {
      name: "TTS_API_KEY", value: "sk-very-secret-value", baseUrl: "https://api.openai.com/v1",
    }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("sk-very-secret-value");
    expect(saved).toEqual([{ name: "TTS_API_KEY", value: "sk-very-secret-value" }]);
    expect(applied).toBe(1);
  });

  test("origin-bound keyは安全な接続先だけを正規化originへ束縛する", async () => {
    const bound: Array<[string, string]> = [];
    const saved: string[] = [];
    const { deps } = makeTestDeps({
      saveSecret: async (name) => { saved.push(name); },
      bindSecretOrigin: (name, origin) => { bound.push([name, origin]); },
    });
    const h = makeFetchHandler(deps);

    const ok = await h(putJson("/api/secrets", {
      name: "OPENAI_COMPAT_API_KEY", value: "sk-local", baseUrl: "HTTPS://Models.Example:443/v1/",
    }));
    expect(ok.status).toBe(200);
    expect(bound).toEqual([["OPENAI_COMPAT_API_KEY", "https://models.example"]]);

    for (const baseUrl of ["http://192.168.1.10:11434/v1", "https://user:pass@example.com/v1", "ftp://example.com/v1"]) {
      const res = await h(putJson("/api/secrets", { name: "TTS_API_KEY", value: "sk-tts", baseUrl }));
      expect(res.status, baseUrl).toBe(400);
    }
    expect(saved).toEqual(["OPENAI_COMPAT_API_KEY"]);
  });

  test("PUT 400: ホワイトリスト外の名前・不正な値は保存せず、エラー応答にも値を含めない", async () => {
    const saved: unknown[] = [];
    const { deps } = makeTestDeps({ saveSecret: async (n, v) => { saved.push([n, v]); } });
    const h = makeFetchHandler(deps);
    const r1 = await h(putJson("/api/secrets", { name: "OPENAI_API_KEY", value: "sk-x" }));
    expect(r1.status).toBe(400);
    const r2 = await h(putJson("/api/secrets", { name: "TTS_API_KEY", value: 'bad value"with quotes' }));
    expect(r2.status).toBe(400);
    expect(await r2.text()).not.toContain("bad value");
    const r3 = await h(putJson("/api/secrets", { name: "TTS_API_KEY", value: "" }));
    expect(r3.status).toBe(400);
    expect(saved).toHaveLength(0);
  });

  test("PUT 500: Keychain 書き込み失敗はエラーメッセージを返すが、値は含めない", async () => {
    const events: string[] = [];
    const { deps } = makeTestDeps({
      removeSecretOrigin: () => { events.push("unbind"); },
      saveSecret: async () => {
        events.push("save");
        throw new Error("keychain write failed for TTS_API_KEY: keychain locked: sk-secret-xyz");
      },
      bindSecretOrigin: () => { events.push("bind"); },
      applySecretsChange: () => {
        events.push("apply");
        return { applied: true, error: null };
      },
    });
    const res = await makeFetchHandler(deps)(putJson("/api/secrets", {
      name: "TTS_API_KEY", value: "sk-secret-xyz", baseUrl: "https://api.openai.com/v1",
    }));
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain("keychain locked");
    expect(body).toContain("[redacted]");
    expect(body).not.toContain("sk-secret-xyz");
    expect(events).toEqual(["unbind", "save", "apply"]);
  });

  test("DELETE 500: Keychain 削除失敗時も送信先の承認を先に外す", async () => {
    const events: string[] = [];
    const { deps } = makeTestDeps({
      removeSecretOrigin: () => { events.push("unbind"); },
      removeSecret: async () => {
        events.push("remove");
        throw new Error("keychain delete failed");
      },
      applySecretsChange: () => {
        events.push("apply");
        return { applied: true, error: null };
      },
    });
    const res = await makeFetchHandler(deps)(delReq("/api/secrets/TTS_API_KEY"));
    expect(res.status).toBe(500);
    expect(events).toEqual(["unbind", "remove", "apply"]);
  });

  test("PUT: CODEX_API_KEY の保存では codex 常駐プロセスの kill と auth.json リフレッシュを行う・他の鍵では行わない", async () => {
    let killed = 0;
    let refreshed = 0;
    const { deps } = makeTestDeps({
      saveSecret: async () => {},
      killCodexAppServerRegistry: () => { killed++; },
      refreshCodexAuth: async () => { refreshed++; },
    });
    const h = makeFetchHandler(deps);
    await h(putJson("/api/secrets", { name: "CODEX_API_KEY", value: "sk-codex" }));
    expect(killed).toBe(1);
    expect(refreshed).toBe(1);
    const tts = await h(putJson("/api/secrets", {
      name: "TTS_API_KEY", value: "sk-tts", baseUrl: "https://api.openai.com/v1",
    }));
    expect(tts.status).toBe(200);
    expect(killed).toBe(1);
    expect(refreshed).toBe(1);
  });

  test("PUT/DELETE: auth.json リフレッシュ失敗は applied:false + error として情報的に返す（保存自体は成功・値は含めない）", async () => {
    const { deps } = makeTestDeps({
      saveSecret: async () => {},
      removeSecret: async () => {},
      refreshCodexAuth: async () => { throw new Error("codex auth mode is api-key but no key is configured"); },
    });
    const h = makeFetchHandler(deps);
    const res = await h(delReq("/api/secrets/CODEX_API_KEY"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.error).toContain("api-key");
    expect(body.secrets).toBeDefined();
  });

  test("DELETE: claude api-keyモードで鍵が消えた不整合をapplied:falseで通知する", async () => {
    const { deps } = makeTestDeps({
      removeSecret: async () => {},
      refreshClaudeAuth: async () => {
        throw new Error("claude auth mode is api-key but no key is configured; save a key or switch to subscription");
      },
    });
    const res = await makeFetchHandler(deps)(delReq("/api/secrets/ANTHROPIC_API_KEY"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.applied).toBe(false);
    expect(body.error).toContain("api-key");
    expect(body.error).not.toContain("sk-");
  });

  test("DELETE: 削除 → 再解決。未知の名前は 400", async () => {
    const removed: string[] = [];
    let applied = 0;
    const { deps } = makeTestDeps({
      removeSecret: async (name) => { removed.push(name); },
      applySecretsChange: () => { applied++; return { applied: true, error: null }; },
    });
    const h = makeFetchHandler(deps);
    const ok = await h(delReq("/api/secrets/ANTHROPIC_API_KEY"));
    expect(ok.status).toBe(200);
    expect(removed).toEqual(["ANTHROPIC_API_KEY"]);
    expect(applied).toBe(1);
    expect((await h(delReq("/api/secrets/NOT_A_KEY"))).status).toBe(400);
    expect(removed).toHaveLength(1);
  });
});
