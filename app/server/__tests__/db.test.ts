import { describe, expect, test } from "bun:test";
import { makeLibraryStore, openDb } from "../db";

function memStore() {
  return makeLibraryStore(openDb(":memory:"));
}

describe("db / libraryStore", () => {
  test("save して list できる（新着順・スキーマ自動作成）", () => {
    const store = memStore();
    store.saveModelTalk({ topicId: "t1", topicTitle: "Zero Trust", topicTitleJa: "ゼロトラスト", text: "First talk." });
    store.saveModelTalk({ topicId: "t2", topicTitle: "ABAC", topicTitleJa: "ABAC", text: "Second talk." });
    const list = store.listModelTalks();
    expect(list).toHaveLength(2);
    expect(list[0].topicId).toBe("t2"); // 新着順
    expect(list[1]).toMatchObject({ topicId: "t1", topicTitle: "Zero Trust", text: "First talk." });
    expect(typeof list[0].id).toBe("number");
    expect(list[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("同一 topicId の直近行と同一 text は重複挿入しない", () => {
    const store = memStore();
    store.saveModelTalk({ topicId: "t1", topicTitle: "Zero Trust", topicTitleJa: "ゼロトラスト", text: "Same talk." });
    store.saveModelTalk({ topicId: "t1", topicTitle: "Zero Trust", topicTitleJa: "ゼロトラスト", text: "Same talk." });
    expect(store.listModelTalks()).toHaveLength(1);
    // text が変われば挿入される
    store.saveModelTalk({ topicId: "t1", topicTitle: "Zero Trust", topicTitleJa: "ゼロトラスト", text: "New talk." });
    expect(store.listModelTalks()).toHaveLength(2);
  });

  test("limit が効く", () => {
    const store = memStore();
    for (let i = 0; i < 5; i++) {
      store.saveModelTalk({ topicId: `t${i}`, topicTitle: `T${i}`, topicTitleJa: `題名${i}`, text: `talk ${i}` });
    }
    expect(store.listModelTalks(2)).toHaveLength(2);
  });

  test("openDb: llm_role_settings テーブルを作成する", () => {
    const db = openDb(":memory:");
    const row = db
      .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get("llm_role_settings");
    expect(row?.name).toBe("llm_role_settings");
  });

  test("openDb: tts_settings テーブルを作成する", () => {
    const db = openDb(":memory:");
    const row = db
      .query<{ name: string }, [string]>("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
      .get("tts_settings");
    expect(row?.name).toBe("tts_settings");
  });
});
