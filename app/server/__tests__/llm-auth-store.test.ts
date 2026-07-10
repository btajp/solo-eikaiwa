import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureLlmAuthSchema, makeLlmAuthStore, claudeSpawnEnv,
  getActiveAuthModes, setActiveAuthModes, getActiveAuthSecrets, setActiveAuthSecrets,
} from "../llm-auth-store";

function freshStore() {
  const db = new Database(":memory:");
  ensureLlmAuthSchema(db);
  return makeLlmAuthStore(db);
}

describe("llm-auth-store", () => {
  test("getAll: 未設定なら claude/codex とも既定 subscription を返す", () => {
    const store = freshStore();
    expect(store.getAll()).toEqual({ claude: "subscription", codex: "subscription" });
  });

  test("set→getAll: 指定した provider だけ反映され、他方は既定のまま", () => {
    const store = freshStore();
    store.set("claude", "api-key");
    expect(store.getAll()).toEqual({ claude: "api-key", codex: "subscription" });
  });

  test("set: 同一providerへの再呼び出しはupsert（api-key→subscriptionへ戻せる）", () => {
    const store = freshStore();
    store.set("codex", "api-key");
    store.set("codex", "subscription");
    expect(store.getAll()).toEqual({ claude: "subscription", codex: "subscription" });
  });

  test("set: claude/codex 両方を独立に更新できる", () => {
    const store = freshStore();
    store.set("claude", "api-key");
    store.set("codex", "api-key");
    expect(store.getAll()).toEqual({ claude: "api-key", codex: "api-key" });
  });
});

describe("claudeSpawnEnv", () => {
  test("subscription: 最小envを返し、親のAPIキーを明示的に継承しない", () => {
    expect(claudeSpawnEnv("subscription", {
      HOME: "/Users/test", PATH: "/usr/bin", ANTHROPIC_API_KEY: "ambient", TTS_API_KEY: "other",
    })).toEqual({ HOME: "/Users/test", PATH: "/usr/bin" });
  });

  test("api-key: 承認済みANTHROPIC_API_KEYだけを最小envへ追加する", () => {
    const out = claudeSpawnEnv("api-key", { PATH: "/usr/bin", TTS_API_KEY: "other" }, "sk-test");
    expect(out).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test" });
  });

  test("api-key: 鍵が無い場合はsubscriptionへフォールバックせず明示エラー", () => {
    expect(() => claudeSpawnEnv("api-key", { PATH: "/usr/bin" }, undefined)).toThrow(/api-key.*no key/i);
  });
});

describe("getActiveAuthModes / setActiveAuthModes", () => {
  afterEach(() => {
    // 他テストファイルへの汚染防止（グローバルなランタイムキャッシュのため。assertion 失敗時も必ず走る）
    setActiveAuthModes({ claude: "subscription", codex: "subscription" });
    setActiveAuthSecrets({});
  });

  test("既定は subscription/subscription", () => {
    expect(getActiveAuthModes()).toEqual({ claude: "subscription", codex: "subscription" });
  });

  test("setActiveAuthModes で反映した値が getActiveAuthModes に見える（再起動不要のためのランタイムキャッシュ）", () => {
    setActiveAuthModes({ claude: "api-key", codex: "subscription" });
    expect(getActiveAuthModes()).toEqual({ claude: "api-key", codex: "subscription" });
  });

  test("setActiveAuthSecretsで値を保持するが、認証モードとは独立して更新できる", () => {
    setActiveAuthSecrets({ anthropic: "sk-a", codex: "sk-c" });
    expect(getActiveAuthSecrets()).toEqual({ anthropic: "sk-a", codex: "sk-c" });
  });
});
