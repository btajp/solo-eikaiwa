import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureLlmRoleTuningSchema, makeLlmRoleTuningStore, EFFORTS, CODEX_EFFORTS } from "../llm-role-tuning-store";

function freshStore() {
  const db = new Database(":memory:");
  ensureLlmRoleTuningSchema(db);
  return makeLlmRoleTuningStore(db);
}

describe("llm-role-tuning-store", () => {
  test("getAll: 未設定なら5ロールとも全項目 null を返す", () => {
    const store = freshStore();
    const all = store.getAll();
    expect(Object.keys(all).sort()).toEqual(["assessment", "assist", "coaching", "conversation", "generation"]);
    for (const role of Object.keys(all) as Array<keyof typeof all>) {
      expect(all[role]).toEqual({ claudeModel: null, effort: null, serviceTier: null });
    }
  });

  test("setAll→getAll: 指定したロールだけ反映され、他ロールは全null のまま", () => {
    const store = freshStore();
    store.setAll({ assessment: { claudeModel: "opus", effort: "xhigh", serviceTier: "standard" } });
    const all = store.getAll();
    expect(all.assessment).toEqual({ claudeModel: "opus", effort: "xhigh", serviceTier: "standard" });
    expect(all.coaching).toEqual({ claudeModel: null, effort: null, serviceTier: null });
  });

  test("global 行: getGlobal は未設定なら全 null、setAll({global}) で保存・取得できる（5ロールの getAll には混ざらない）", () => {
    const store = freshStore();
    expect(store.getGlobal()).toEqual({ claudeModel: null, effort: null, serviceTier: null });
    store.setAll({ global: { claudeModel: "claude-fable-5", effort: "high", serviceTier: null } });
    expect(store.getGlobal()).toEqual({ claudeModel: "claude-fable-5", effort: "high", serviceTier: null });
    const all = store.getAll();
    expect(Object.keys(all).sort()).toEqual(["assessment", "assist", "coaching", "conversation", "generation"]);
    expect(all.conversation).toEqual({ claudeModel: null, effort: null, serviceTier: null });
  });

  test("setAll: 同一ロールへの再呼び出しは upsert（全フィールド null で既定へ戻せる・DELETE を使わない）", () => {
    const store = freshStore();
    store.setAll({ generation: { claudeModel: "sonnet", effort: "medium", serviceTier: null } });
    store.setAll({ generation: { claudeModel: null, effort: null, serviceTier: null } });
    expect(store.getAll().generation).toEqual({ claudeModel: null, effort: null, serviceTier: null });
  });

  test("setAll: 部分指定（一部フィールドのみ渡す）は他フィールドの既存値を保持する", () => {
    const store = freshStore();
    store.setAll({ conversation: { claudeModel: "sonnet", effort: "low", serviceTier: "fast" } });
    store.setAll({ conversation: { effort: "high" } });
    expect(store.getAll().conversation).toEqual({ claudeModel: "sonnet", effort: "high", serviceTier: "fast" });
  });

  test("setAll: 複数ロールを1回の呼び出しでまとめて更新できる", () => {
    const store = freshStore();
    store.setAll({
      conversation: { claudeModel: "sonnet" },
      assessment: { effort: "xhigh" },
    });
    const all = store.getAll();
    expect(all.conversation).toEqual({ claudeModel: "sonnet", effort: null, serviceTier: null });
    expect(all.assessment).toEqual({ claudeModel: null, effort: "xhigh", serviceTier: null });
  });
});

describe("CODEX_EFFORTS", () => {
  test("EFFORTS から \"max\" を除いた集合である（codex はリクエストレベルで max を受け付けないため）", () => {
    expect(CODEX_EFFORTS).toEqual(["low", "medium", "high", "xhigh"]);
    expect(CODEX_EFFORTS).not.toContain("max");
    expect(EFFORTS).toContain("max");
  });
});
