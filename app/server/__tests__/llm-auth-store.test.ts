import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureLlmAuthSchema, makeLlmAuthStore, claudeSpawnEnv,
  getActiveAuthModes, setActiveAuthModes,
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
  test("subscription: undefined を返す（env上書きなし＝現行どおりprocess.env継承）", () => {
    expect(claudeSpawnEnv("subscription", { PATH: "/usr/bin" })).toBeUndefined();
  });

  test("api-key: baseEnv を土台に ANTHROPIC_API_KEY を含む env を返す", () => {
    const out = claudeSpawnEnv("api-key", { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test" });
    expect(out).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test" });
  });
});

describe("getActiveAuthModes / setActiveAuthModes", () => {
  test("既定は subscription/subscription", () => {
    setActiveAuthModes({ claude: "subscription", codex: "subscription" }); // 他テストの汚染からの防御的リセット
    expect(getActiveAuthModes()).toEqual({ claude: "subscription", codex: "subscription" });
  });

  test("setActiveAuthModes で反映した値が getActiveAuthModes に見える（再起動不要のためのランタイムキャッシュ）", () => {
    setActiveAuthModes({ claude: "api-key", codex: "subscription" });
    expect(getActiveAuthModes()).toEqual({ claude: "api-key", codex: "subscription" });
    setActiveAuthModes({ claude: "subscription", codex: "subscription" }); // 他テストへの汚染防止
  });
});
