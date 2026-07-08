import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../db";
import { loadSentences, makeSentenceStore, type Sentence } from "../sentences";
import { addDaysYmd, localYmd } from "../dates";

const FIVE: Sentence[] = [1, 2, 3, 4, 5].map((n) => ({
  no: n,
  category_no: 1,
  category: "現在形",
  domain: n % 2 === 0 ? "business" : "daily",
  en: `Sentence number ${n}.`,
  ja: `例文 ${n}`,
  note: `ポイント ${n}`,
}));

function writeFixture(sentences: unknown): string {
  const dir = mkdtempSync(path.join(tmpdir(), "sent-"));
  const file = path.join(dir, "sentences300.json");
  writeFileSync(file, JSON.stringify(sentences), "utf8");
  return file;
}

function memStore(sentences: Sentence[] = FIVE, bundled = new Map<number, string>()) {
  // 実リポジトリの同梱解説ファイルに依存しないよう、テストは常に明示の Map を渡す
  return makeSentenceStore(openDb(":memory:"), sentences, bundled);
}

describe("sentences / loadSentences", () => {
  test("正常なJSONを読み込める", () => {
    const file = writeFixture(FIVE);
    expect(loadSentences(file)).toHaveLength(5);
  });

  test("不正な形状の項目は警告してスキップする", () => {
    const file = writeFixture([...FIVE, { no: 6, en: "missing fields" }]);
    expect(loadSentences(file)).toHaveLength(5);
  });

  test("ファイルが無ければ throw（起動時に気づけること）", () => {
    expect(() => loadSentences("/nonexistent/nope.json")).toThrow();
  });

  // v0.26 content-ladder wave4: spoken function例文が付ける band フィールド(additive)への耐性。
  // band は省略可・値がある場合は3値のいずれかのみ有効とする。
  test("band フィールドがある項目も読み込める（省略可・foundation/development/fluencyのいずれか）", () => {
    const file = writeFixture([...FIVE, { no: 6, category_no: 26, category: "会話機能: 依頼する", domain: "daily", en: "Can you help me?", ja: "手伝ってくれる？", note: "", band: "foundation" }]);
    const loaded = loadSentences(file);
    expect(loaded).toHaveLength(6);
    expect(loaded.find((s) => s.no === 6)?.band).toBe("foundation");
  });

  test("band に不正な値がある項目は警告してスキップする（他項目は読み込める）", () => {
    const file = writeFixture([...FIVE, { no: 6, category_no: 26, category: "x", domain: "daily", en: "x", ja: "x", note: "", band: "not-a-band" }]);
    expect(loadSentences(file)).toHaveLength(5);
  });

  // band 以外の未知フィールドが将来追加されても既存項目の読み込みを壊さないことの耐性テスト
  // （content-gen.tsのgenSpokenFunctionSentences等、追加メタデータを持つ生成物を想定した回帰防止）。
  test("既知フィールド以外の未知の追加フィールドがあっても読み込みを壊さない（将来の拡張耐性）", () => {
    const file = writeFixture([{ ...FIVE[0], sourceHash: "abc123", promptVersion: 2 }]);
    const loaded = loadSentences(file);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].en).toBe(FIVE[0].en);
  });
});

describe("sentences / 日付ヘルパ", () => {
  test("localYmd はローカル日付で YYYY-MM-DD", () => {
    expect(localYmd(new Date(2026, 6, 6))).toBe("2026-07-06"); // 月は0起点
  });
  test("addDaysYmd は日を跨いで加算できる", () => {
    expect(addDaysYmd("2026-07-30", 3)).toBe("2026-08-02");
  });
});

describe("sentences / SRS ladder", () => {
  test("good 連続で stage が上がり間隔が伸びる", () => {
    const store = memStore();
    const r1 = store.grade(1, "good", "2026-07-06");
    expect(r1).toEqual({ no: 1, stage: 1, due: "2026-07-09" }); // 0→1, +3日
    const r2 = store.grade(1, "good", "2026-07-09");
    expect(r2).toEqual({ no: 1, stage: 2, due: "2026-07-16" }); // 1→2, +7日
  });

  test("bad で stage が後退し翌日再出題", () => {
    const store = memStore();
    store.grade(1, "good", "2026-07-06");
    store.grade(1, "good", "2026-07-09"); // stage 2
    const r = store.grade(1, "bad", "2026-07-16");
    expect(r).toEqual({ no: 1, stage: 1, due: "2026-07-17" });
  });

  test("soso は stage 不変で翌日再出題", () => {
    const store = memStore();
    store.grade(1, "good", "2026-07-06"); // stage 1
    const r = store.grade(1, "soso", "2026-07-09");
    expect(r).toEqual({ no: 1, stage: 1, due: "2026-07-10" });
  });

  test("stage は 5 で頭打ち・0 で底打ち", () => {
    const store = memStore();
    let today = "2026-07-06";
    for (let i = 0; i < 8; i++) {
      const r = store.grade(1, "good", today)!;
      today = r.due;
    }
    expect(store.list().find((s) => s.no === 1)!.srs!.stage).toBe(5);
    const r = store.grade(2, "bad", "2026-07-06");
    expect(r).toEqual({ no: 2, stage: 0, due: "2026-07-07" });
  });

  test("未知の no は null", () => {
    expect(memStore().grade(999, "good", "2026-07-06")).toBeNull();
  });

  test("reviews が加算され list に反映される", () => {
    const store = memStore();
    store.grade(1, "good", "2026-07-06");
    store.grade(1, "soso", "2026-07-09");
    const s1 = store.list().find((s) => s.no === 1)!;
    expect(s1.srs).toMatchObject({ stage: 1, reviews: 2 });
  });
});

describe("sentences / queue", () => {
  test("復習（due<=today）を due 昇順で先に、未学習を no 順で new 件まで補充", () => {
    const store = memStore();
    store.grade(3, "good", "2026-07-01"); // due 2026-07-04
    store.grade(2, "good", "2026-07-02"); // due 2026-07-05
    store.grade(5, "good", "2026-07-06"); // due 2026-07-09（未到来）
    const q = store.queue(2, "2026-07-06");
    // 復習: no3(due07-04) → no2(due07-05)。新規: no1, no4（no5は復習予約済みなので新規に出ない）
    expect(q.map((s) => s.no)).toEqual([3, 2, 1, 4]);
  });

  test("new=0 なら復習のみ", () => {
    const store = memStore();
    store.grade(1, "good", "2026-07-01");
    const q = store.queue(0, "2026-07-06");
    expect(q.map((s) => s.no)).toEqual([1]);
  });

  test("復習なし・新規のみでも動く", () => {
    const q = memStore().queue(3, "2026-07-06");
    expect(q.map((s) => s.no)).toEqual([1, 2, 3]);
    expect(q[0].srs).toBeNull();
  });

  test("入力配列が no 順でなくても、新規は no 昇順で返す", () => {
    // 入力順序が [3, 1, 2] だが、キューは [1, 2] の順（新規枠2件）
    const outOfOrder: Sentence[] = [
      { no: 3, category_no: 1, category: "現在形", domain: "daily", en: "Three", ja: "3番", note: "" },
      { no: 1, category_no: 1, category: "現在形", domain: "daily", en: "One", ja: "1番", note: "" },
      { no: 2, category_no: 1, category: "現在形", domain: "business", en: "Two", ja: "2番", note: "" },
    ];
    const store = makeSentenceStore(openDb(":memory:"), outOfOrder);
    const q = store.queue(2, "2026-07-06");
    expect(q.map((s) => s.no)).toEqual([1, 2]);
  });
});

describe("sentences / SentenceStore の band 耐性", () => {
  test("band付きの例文もlist/queueでbandがそのまま透過する（SRS選定ロジックは不変）", () => {
    const withBand: Sentence[] = [
      { no: 1, category_no: 26, category: "会話機能: 依頼する", domain: "daily", en: "Can you help me?", ja: "手伝ってくれる？", note: "", band: "foundation" },
    ];
    const store = makeSentenceStore(openDb(":memory:"), withBand);
    expect(store.list()[0].band).toBe("foundation");
    expect(store.queue(1, "2026-07-06")[0].band).toBe("foundation");
  });
});

describe("sentences / explanations", () => {
  test("同梱解説がSQLiteキャッシュより優先される", () => {
    const store = memStore(FIVE, new Map([[1, "同梱の解説"]]));
    store.saveExplanation(1, "後から生成された解説");
    expect(store.getExplanation(1)).toBe("同梱の解説");
  });

  test("同梱になければSQLiteキャッシュ、それもなければnull", () => {
    const store = memStore();
    expect(store.getExplanation(2)).toBeNull();
    store.saveExplanation(2, "生成解説");
    expect(store.getExplanation(2)).toBe("生成解説");
  });
});
