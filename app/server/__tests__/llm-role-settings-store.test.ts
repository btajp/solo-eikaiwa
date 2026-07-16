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

  test("save→getAll 往復一致: 公式URLの openai-compat 行も読み取り時に再解釈しない（保存値のまま返す）", () => {
    // 保存の可否は route が検証する（公式URLは 400）。store は渡された値を変換せずそのまま返す契約。
    const store = freshStore();
    store.save("conversation", { provider: "openai-compat", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", codexModel: null });
    expect(store.getAll().conversation).toEqual({
      provider: "openai-compat", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", codexModel: null,
    });
  });

  test("ensure: 公式URLを指す旧 openai-compat 行は起動時に一度だけ openai 行へ書き戻す", () => {
    const db = new Database(":memory:");
    ensureLlmRoleSettingsSchema(db);
    // 旧バージョンが書いた行を再現（route 検証導入後はこの組合せの新規保存はできない）
    db.run(
      "INSERT INTO llm_role_settings (role, provider, base_url, model, codex_model, updated_at) VALUES ('conversation', 'openai-compat', 'https://api.openai.com/v1', 'gpt-4.1-mini', NULL, '2026-01-01T00:00:00Z')",
    );
    ensureLlmRoleSettingsSchema(db); // 新バージョンの起動を再現
    // 仮想移行（読み取り時の再解釈）ではなく物理行が移行されている
    const row = db
      .query<{ provider: string; base_url: string | null; model: string | null }, []>(
        "SELECT provider, base_url, model FROM llm_role_settings WHERE role = 'conversation'",
      )
      .get();
    expect(row).toEqual({ provider: "openai", base_url: null, model: "gpt-4.1-mini" });
    expect(makeLlmRoleSettingsStore(db).getAll().conversation).toEqual({
      provider: "openai", baseUrl: null, model: "gpt-4.1-mini", codexModel: null,
    });
  });

  test("ensure: 公式URL以外の openai-compat 行・openai 行は書き戻しの対象外（何度実行しても不変）", () => {
    const db = new Database(":memory:");
    ensureLlmRoleSettingsSchema(db);
    db.run(
      "INSERT INTO llm_role_settings (role, provider, base_url, model, codex_model, updated_at) VALUES ('conversation', 'openai-compat', 'http://localhost:11434/v1', 'llama3', NULL, '2026-01-01T00:00:00Z')",
    );
    db.run(
      "INSERT INTO llm_role_settings (role, provider, base_url, model, codex_model, updated_at) VALUES ('coaching', 'openai', NULL, 'gpt-4.1-mini', NULL, '2026-01-01T00:00:00Z')",
    );
    ensureLlmRoleSettingsSchema(db);
    ensureLlmRoleSettingsSchema(db);
    const all = makeLlmRoleSettingsStore(db).getAll();
    expect(all.conversation).toEqual({ provider: "openai-compat", baseUrl: "http://localhost:11434/v1", model: "llama3", codexModel: null });
    expect(all.coaching).toEqual({ provider: "openai", baseUrl: null, model: "gpt-4.1-mini", codexModel: null });
  });
});
