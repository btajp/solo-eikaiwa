import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureLlmRoleSettingsSchema, makeLlmRoleSettingsStore } from "../llm-role-settings-store";

function freshStore() {
  const db = new Database(":memory:");
  ensureLlmRoleSettingsSchema(db);
  return makeLlmRoleSettingsStore(db);
}

describe("llm-role-settings-store", () => {
  test("getAll: 未設定なら5ロールとも inherit を返す", () => {
    const store = freshStore();
    const all = store.getAll();
    expect(Object.keys(all).sort()).toEqual(["assessment", "assist", "coaching", "conversation", "generation"]);
    for (const role of Object.keys(all) as Array<keyof typeof all>) {
      expect(all[role]).toEqual({ provider: "inherit", baseUrl: null, model: null, codexModel: null });
    }
  });

  test("save→getAll: 保存したロールだけ反映され、他は inherit のまま", () => {
    const store = freshStore();
    store.save("conversation", { provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
    const all = store.getAll();
    expect(all.conversation).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
    expect(all.coaching).toEqual({ provider: "inherit", baseUrl: null, model: null, codexModel: null });
  });

  test("save: 同一ロールは upsert（provider='inherit' で inherit へ戻せる・DELETE を使わない）", () => {
    const store = freshStore();
    store.save("generation", { provider: "codex", baseUrl: null, model: null, codexModel: "o4-mini" });
    store.save("generation", { provider: "inherit", baseUrl: null, model: null, codexModel: null });
    expect(store.getAll().generation).toEqual({ provider: "inherit", baseUrl: null, model: null, codexModel: null });
  });
});
