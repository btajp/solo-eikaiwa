import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../content";
import { parseListeningFile } from "../listening";

const VALID = `---
id: morning-routine
title: "My morning routine"
title_ja: "朝のルーティン"
domain: daily
level: [1, 3]
---

I wake up at seven every day. Then I make a cup of coffee and check the news.

After breakfast, I walk to the station. The walk takes about ten minutes.`;

describe("parseFrontmatter", () => {
  test("frontmatter を fields と body に分解する", () => {
    const fm = parseFrontmatter(VALID)!;
    expect(fm.fields.id).toBe("morning-routine");
    expect(fm.fields.title).toBe("My morning routine");
    expect(fm.fields.domain).toBe("daily");
    expect(fm.body.trim().startsWith("I wake up")).toBe(true);
  });

  test("frontmatter が無ければ null", () => {
    expect(parseFrontmatter("no frontmatter here")).toBeNull();
  });
});

describe("parseListeningFile", () => {
  test("正常系: 段落を空行区切りで分割する", () => {
    const it = parseListeningFile(VALID)!;
    expect(it.id).toBe("morning-routine");
    expect(it.title).toBe("My morning routine");
    expect(it.titleJa).toBe("朝のルーティン");
    expect(it.domain).toBe("daily");
    expect(it.level).toEqual([1, 3]);
    expect(it.paragraphs).toHaveLength(2);
    expect(it.paragraphs[0].startsWith("I wake up")).toBe(true);
  });

  test("frontmatter 無しは null", () => {
    expect(parseListeningFile("just prose, no frontmatter")).toBeNull();
  });

  test("id / title 欠落は null", () => {
    const noId = `---\ntitle: "T"\ndomain: daily\n---\n\nBody paragraph.`;
    const noTitle = `---\nid: x\ndomain: daily\n---\n\nBody paragraph.`;
    expect(parseListeningFile(noId)).toBeNull();
    expect(parseListeningFile(noTitle)).toBeNull();
  });

  test("本文が空（段落ゼロ）は null", () => {
    const empty = `---\nid: x\ntitle: "T"\ndomain: daily\nlevel: [1, 3]\n---\n\n   `;
    expect(parseListeningFile(empty)).toBeNull();
  });

  test("不正 domain / level は content と同じ挙動でフォールバック（it / [1,6]）", () => {
    const bad = `---\nid: x\ntitle: "T"\ndomain: nope\nlevel: [9, 9]\n---\n\nBody paragraph one.\n\nBody paragraph two.`;
    const it = parseListeningFile(bad)!;
    expect(it.domain).toBe("it");
    expect(it.level).toEqual([1, 6]);
  });
});
