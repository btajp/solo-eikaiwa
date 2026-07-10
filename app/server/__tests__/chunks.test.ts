import { describe, expect, test } from "bun:test";
import { openDb } from "../db";
import { LADDER } from "../sentences";
import { MAX_COLLECT_PER_DAY, makeChunkStore, normalizeEn, type CollectCandidate } from "../chunks";

const TODAY = "2026-07-06";

function storeWithDb(sentenceEns: string[] = []) {
  const db = openDb(":memory:");
  return { db, store: makeChunkStore(db, sentenceEns) };
}

function store(sentenceEns: string[] = []) {
  return storeWithDb(sentenceEns).store;
}

function cand(over: Partial<CollectCandidate> = {}): CollectCandidate {
  return { source: "ae", promptText: "I go office yesterday", en: "I went to the office yesterday", note: "過去形", ...over };
}

describe("chunks: normalizeEn", () => {
  test("小文字化・記号除去・空白圧縮", () => {
    expect(normalizeEn("I went to the office, yesterday!")).toBe("i went to the office yesterday");
    expect(normalizeEn("  Don't   worry.  ")).toBe("dont worry");
  });
});

describe("chunks: collect", () => {
  test("実際に新規保存したチャンクだけを返す", () => {
    const s = store(["Already in the bundled sentences."]);
    const saved = s.collect([
      cand({ en: "Already in the bundled sentences." }),
      cand({ en: "A newly collected phrase." }),
      cand({ en: "A newly collected phrase!" }),
    ], TODAY);

    expect(saved.map((chunk) => ({ id: chunk.id, en: chunk.en, promptText: chunk.promptText }))).toEqual([
      { id: 1, en: "A newly collected phrase.", promptText: "I go office yesterday" },
    ]);
  });

  test("保存: stage0・due=翌日・入ったチャンクを返す", () => {
    const s = store();
    expect(s.collect([cand()], TODAY)).toHaveLength(1);
    const all = s.list();
    expect(all).toHaveLength(1);
    expect(all[0].en).toBe("I went to the office yesterday");
    expect(all[0].promptText).toBe("I go office yesterday");
    expect(all[0].note).toBe("過去形");
    expect(all[0].source).toBe("ae");
    expect(all[0].srs).toEqual({ stage: 0, due: "2026-07-07", reviews: 0 });
  });

  test("promptText か en が空の候補はスキップ", () => {
    const s = store();
    expect(s.collect([cand({ promptText: "  " }), cand({ en: "" })], TODAY)).toHaveLength(0);
    expect(s.list()).toHaveLength(0);
  });

  test("既存チャンクと正規化enが同じならスキップ（大文字小文字・記号差は同一視）", () => {
    const s = store();
    expect(s.collect([cand()], TODAY)).toHaveLength(1);
    expect(s.collect([cand({ en: "I went to the office, YESTERDAY!" })], TODAY)).toHaveLength(0);
    expect(s.list()).toHaveLength(1);
  });

  test("sentences300 の en と一致するものはスキップ", () => {
    const s = store(["I went to the office yesterday."]);
    expect(s.collect([cand()], TODAY)).toHaveLength(0);
  });

  test("1日の上限は5件（超過分はスキップ・同日2回目も残枠のみ）", () => {
    const s = store();
    const seven = Array.from({ length: 7 }, (_, i) => cand({ en: `Unique sentence number ${i} here` }));
    expect(s.collect(seven, TODAY)).toHaveLength(MAX_COLLECT_PER_DAY);
    expect(s.collect([cand({ en: "One more different sentence" })], TODAY)).toHaveLength(0);
    // 翌日は枠が回復する
    expect(s.collect([cand({ en: "One more different sentence" })], "2026-07-07")).toHaveLength(1);
    expect(s.list()).toHaveLength(6);
  });

  test("200文字を超える en はスキップ", () => {
    const s = store();
    expect(s.collect([cand({ en: "a".repeat(201) })], TODAY)).toHaveLength(0);
  });
});

describe("chunks: grade（sentences と同じ LADDER 遷移）", () => {
  test("good で stage 上昇・LADDER 間隔、bad で後退・翌日", () => {
    const s = store();
    s.collect([cand()], TODAY);
    const id = s.list()[0].id;
    const g1 = s.grade(id, "good", TODAY)!;
    expect(g1.stage).toBe(1);
    expect(g1.due).toBe("2026-07-09"); // TODAY + LADDER[1]=3
    const g2 = s.grade(id, "soso", TODAY)!;
    expect(g2.stage).toBe(1);
    expect(g2.due).toBe("2026-07-07");
    const g3 = s.grade(id, "bad", TODAY)!;
    expect(g3.stage).toBe(0);
    expect(g3.due).toBe("2026-07-07");
    expect(s.list()[0].srs.reviews).toBe(3);
    expect(LADDER[1]).toBe(3); // 前提の明示
  });

  test("未知の id は null", () => {
    expect(store().grade(999, "good", TODAY)).toBeNull();
  });
});

describe("chunks: dueChunks / visibility", () => {
  test("dueChunks は due<=today のみ・due昇順", () => {
    const s = store();
    s.collect([cand({ en: "First unique sentence" }), cand({ en: "Second unique sentence" })], TODAY);
    // 収集直後（当日）はまだ出題しない
    expect(s.dueChunks(TODAY)).toHaveLength(0);
    expect(s.dueChunks("2026-07-07")).toHaveLength(2);
    // 片方を good にすると due が先送りされる
    const [a] = s.list();
    s.grade(a.id, "good", "2026-07-07");
    const due = s.dueChunks("2026-07-08");
    expect(due).toHaveLength(1);
    expect(due[0].id).not.toBe(a.id);
  });

  test("非表示にしても元データを保持し、非表示一覧から復元できる", () => {
    const { db, store: s } = storeWithDb();
    s.collect([cand()], TODAY);
    const id = s.list()[0].id;
    expect(s.setHidden(id, true)).toBe(true);
    expect(s.list()).toHaveLength(0);
    expect(s.listHidden().map((chunk) => chunk.id)).toEqual([id]);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM collected_chunks").get()?.n).toBe(1);

    expect(s.setHidden(id, false)).toBe(true);
    expect(s.list().map((chunk) => chunk.id)).toEqual([id]);
    expect(s.listHidden()).toHaveLength(0);
  });

  test("非表示チャンクは復習対象外で、復元すると再び対象になる", () => {
    const s = store();
    s.collect([cand()], TODAY);
    const id = s.list()[0].id;
    expect(s.setHidden(id, true)).toBe(true);
    expect(s.dueChunks("2026-07-07")).toHaveLength(0);
    expect(s.setHidden(id, false)).toBe(true);
    expect(s.dueChunks("2026-07-07").map((chunk) => chunk.id)).toEqual([id]);
  });

  test("未知の id は変更せず false を返す", () => {
    const s = store();
    expect(s.setHidden(999, true)).toBe(false);
    expect(s.setHidden(999, false)).toBe(false);
  });
});
