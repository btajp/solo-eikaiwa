import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureTtsProviderSchema, makeTtsProviderStore } from "../tts-provider-store";

function fresh() {
  const db = new Database(":memory:");
  ensureTtsProviderSchema(db);
  return { db, store: makeTtsProviderStore(db) };
}

describe("tts-provider-store", () => {
  test("行不在は auto（従来の暗黙決定）", () => {
    expect(fresh().store.get()).toBe("auto");
  });

  test("save → get で保存値を返し、再 save は単一行を上書きする", () => {
    const { db, store } = fresh();
    store.save("say");
    expect(store.get()).toBe("say");
    store.save("openai-compat");
    expect(store.get()).toBe("openai-compat");
    const count = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tts_provider_settings").get();
    expect(count?.n).toBe(1);
  });

  test("未知値の保存済み行は auto に正規化して返す（安全側=従来挙動）", () => {
    const { db, store } = fresh();
    db.run("INSERT INTO tts_provider_settings (id, provider, updated_at) VALUES (1, 'bogus', '2026-01-01T00:00:00Z')");
    expect(store.get()).toBe("auto");
  });
});
