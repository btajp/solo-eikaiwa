import { describe, expect, test } from "bun:test";
import { clozeText, STOPWORDS } from "./cloze";

describe("clozeText", () => {
  const SENT = "I usually skip breakfast and just grab coffee on my way out.";

  test("同じ no なら毎回同じ歯抜けになる（決定性）", () => {
    const a = clozeText(SENT, 42);
    const b = clozeText(SENT, 42);
    expect(a).toBe(b);
  });

  test("異なる no では（候補が複数ある文で）別の歯抜けになりうる", () => {
    // 内容語が十分ある文では、シードが違えばマスク位置が変わることを確認する。
    // 決定的なので、この2つのシードで同一になった場合はテストを見直す（フレークではない）
    const a = clozeText(SENT, 1);
    const b = clozeText(SENT, 2);
    expect(a).not.toBe(b);
  });

  test("最低1語はマスクされ、マスクはアンダースコア列で表現される", () => {
    const out = clozeText(SENT, 7);
    expect(out).toMatch(/_{3,}/);
  });

  test("ストップワードはマスクされない", () => {
    // 内容語が1つ（breakfast）だけの文 — 必ずそれがマスクされ、機能語は残る
    const out = clozeText("I have it for breakfast.", 3);
    expect(out).toContain("I have it for");
    expect(out).not.toContain("breakfast");
    expect(out).toMatch(/_{3,}/);
  });

  test("句読点・大文字小文字・語順は保持される", () => {
    const out = clozeText("Could you say that again, please?", 11);
    expect(out.endsWith("?")).toBe(true);
    expect(out).toContain(",");
    // マスク済み語以外の部分文字列は原文のまま
    const restored = out.replace(/_{3,}/g, "");
    for (const frag of restored.split(/\s+/).filter(Boolean)) {
      expect("Could you say that again, please?").toContain(frag.replace(/[,?]/g, ""));
    }
  });

  test("全部ストップワードの短文では最長の語がマスクされる（最低1語保証）", () => {
    const out = clozeText("It is what it is.", 5);
    expect(out).toMatch(/_{3,}/);
    // what（4文字・最長）がマスクされる
    expect(out.toLowerCase()).not.toContain("what");
  });

  test("マスク数は内容語の約40%（最低1語）", () => {
    // 内容語8語（Yesterday/morning/Tanaka/quickly/finished/writing/detailed/reports）→ round(8*0.4)=3語マスク
    const s = "Yesterday morning Tanaka quickly finished writing detailed reports.";
    const out = clozeText(s, 9);
    const masks = out.match(/_{3,}/g) ?? [];
    expect(masks.length).toBe(3);
  });

  test("STOPWORDS は小文字で管理されている", () => {
    for (const w of STOPWORDS) expect(w).toBe(w.toLowerCase());
  });

  test("no.50 実データ回帰: 非ASCII語（café）がトークン分断されず、丸ごとマスクまたは保持される", () => {
    // sentences300.json no.50: "There might be a nice café near the station."
    const en = "There might be a nice café near the station.";
    const out = clozeText(en, 50);
    // "café" がまとめてマスク／非マスクされていれば、"café" を除去した残りに「é」単体は残らない
    expect(out.replace(/café/g, "")).not.toContain("é");
  });

  test("no.286 実データ回帰: 直線引用符は単語に吸収されず、両方とも出力に保存される", () => {
    // sentences300.json no.286: "When you say 'rollback', do you mean the whole release?"
    const en = "When you say 'rollback', do you mean the whole release?";
    const out = clozeText(en, 286);
    const quoteCount = (out.match(/'/g) ?? []).length;
    expect(quoteCount).toBe(2);
  });
});
