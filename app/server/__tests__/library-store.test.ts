import { describe, expect, test } from "bun:test";
import { makeLibraryStore, openDb } from "../db";

describe("model talk library store", () => {
  test("題名の日英を保存し、同じ本文の再保存でも題名は最新化する", () => {
    const db = openDb(":memory:");
    try {
      const store = makeLibraryStore(db);
      store.saveModelTalk({ topicId: "topic-1", topicTitle: "First title", topicTitleJa: "最初の題名", text: "Talk text." });
      store.saveModelTalk({ topicId: "topic-1", topicTitle: "Updated title", topicTitleJa: "更新後の題名", text: "Talk text." });

      expect(store.listModelTalks()).toHaveLength(1);
      expect(store.listModelTalks()[0]).toMatchObject({
        topicId: "topic-1", topicTitle: "Updated title", topicTitleJa: "更新後の題名", text: "Talk text.",
      });
    } finally {
      db.close();
    }
  });

  test("旧形式の記録は英語題名を保ち、日本語題名を空として返す", () => {
    const db = openDb(":memory:");
    try {
      db.run(
        "INSERT INTO model_talks (created_at, topic_id, topic_title, text) VALUES (?, ?, ?, ?)",
        ["2026-07-11T00:00:00.000Z", "legacy-topic", "Legacy title", "Talk text."],
      );
      const entry = makeLibraryStore(db).listModelTalks()[0];
      expect(entry).toMatchObject({ topicTitle: "Legacy title", topicTitleJa: "" });
    } finally {
      db.close();
    }
  });
});
