import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../content";
import { dialogueScriptText, parseListeningFile } from "../listening";

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

  test("モノローグ（format無し）は format=monologue・speakers/turns 空", () => {
    const it = parseListeningFile(VALID)!;
    expect(it.format).toBe("monologue");
    expect(it.speakers).toEqual([]);
    expect(it.turns).toEqual([]);
  });
});

const VALID_DIALOGUE = `---
id: asking-for-help
title: "Asking for Help"
title_ja: "助けを求める"
domain: business
level: [1, 2]
format: dialogue
speakers: "Ken, Emma"
---

Ken: Hey Emma, do you have a minute?

Emma: Sure, what's up?

Ken: I can't open the shared folder.

Emma: Don't worry, it's a common problem.`;

describe("parseListeningFile / dialogue（#220 対話型多聴）", () => {
  test("正常系: format=dialogue で話者と発話ターンを段落から復元する", () => {
    const it = parseListeningFile(VALID_DIALOGUE)!;
    expect(it.format).toBe("dialogue");
    expect(it.speakers).toEqual(["Ken", "Emma"]); // 初出順
    expect(it.turns).toEqual([
      { speaker: "Ken", text: "Hey Emma, do you have a minute?" },
      { speaker: "Emma", text: "Sure, what's up?" },
      { speaker: "Ken", text: "I can't open the shared folder." },
      { speaker: "Emma", text: "Don't worry, it's a common problem." },
    ]);
    // paragraphs は話者ラベル付きの生の段落のまま（talk-explain 等の既存経路が使う）
    expect(it.paragraphs[0]).toBe("Ken: Hey Emma, do you have a minute?");
  });

  test("話者ラベルの無い段落が混じる dialogue は null（壊れたファイルとして除外）", () => {
    const broken = VALID_DIALOGUE + "\n\nJust prose without a label.";
    expect(parseListeningFile(broken)).toBeNull();
  });

  test("話者が1人しか登場しない dialogue は null", () => {
    const solo = `---\nid: x\ntitle: "T"\ndomain: daily\nlevel: [1, 2]\nformat: dialogue\n---\n\nKen: Hello there.\n\nKen: Anyone here?`;
    expect(parseListeningFile(solo)).toBeNull();
  });

  test("dialogueScriptText はラベル抜きの発話本文だけを空行区切りで結合する（TTS/検証の単位）", () => {
    const it = parseListeningFile(VALID_DIALOGUE)!;
    expect(dialogueScriptText(it.turns)).toBe(
      "Hey Emma, do you have a minute?\n\nSure, what's up?\n\nI can't open the shared folder.\n\nDon't worry, it's a common problem.",
    );
  });
});
