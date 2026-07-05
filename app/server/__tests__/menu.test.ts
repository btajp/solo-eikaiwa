import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildTodayMenu, loadContent, parseContentFile, pickNext,
  type ContentItem, type MenuDeps, type UsageMap,
} from "../menu";

function makeContentDirs(): { topicsDir: string; scenariosDir: string; usageFile: string; menuCacheDir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "menu-"));
  const topicsDir = path.join(dir, "topics");
  const scenariosDir = path.join(dir, "scenarios");
  const menuCacheDir = path.join(dir, "cache");
  mkdirSync(topicsDir, { recursive: true });
  mkdirSync(scenariosDir, { recursive: true });
  const topic = (id: string, title: string) =>
    `---\nid: ${id}\nkind: topic\ntitle: "${title}"\ntitle_ja: "ja-${id}"\n---\nHints:\n- hint one\n- hint two\n- hint three\n`;
  const scenario = (id: string, title: string) =>
    `---\nid: ${id}\nkind: scenario\ntitle: "${title}"\ntitle_ja: "ja-${id}"\n---\nSetup:\n- You are the IT lead\n- Goal: agree next steps\n`;
  writeFileSync(path.join(topicsDir, "t1.md"), topic("t1", "Topic One"));
  writeFileSync(path.join(topicsDir, "t2.md"), topic("t2", "Topic Two"));
  writeFileSync(path.join(topicsDir, "t3.md"), topic("t3", "Topic Three"));
  writeFileSync(path.join(scenariosDir, "s1.md"), scenario("s1", "Scenario One"));
  writeFileSync(path.join(scenariosDir, "s2.md"), scenario("s2", "Scenario Two"));
  return { topicsDir, scenariosDir, usageFile: path.join(dir, "usage.json"), menuCacheDir };
}

const JULY5 = () => new Date("2026-07-05T09:00:00Z");

describe("parseContentFile / loadContent", () => {
  test("frontmatter と hints を抽出する", () => {
    const item = parseContentFile(
      `---\nid: abc\nkind: topic\ntitle: "Hello Title"\ntitle_ja: "こんにちは"\n---\nbody\n- first hint\n- second hint\n`,
    );
    expect(item).toEqual({
      id: "abc", kind: "topic", title: "Hello Title", titleJa: "こんにちは",
      hints: ["first hint", "second hint"],
    });
  });

  test("frontmatter が無い・必須キー欠落は null", () => {
    expect(parseContentFile("just text")).toBeNull();
    expect(parseContentFile("---\nkind: topic\n---\n")).toBeNull();
  });

  test("loadContent は .md をソート順に読み、壊れたファイルを除外する", () => {
    const { topicsDir } = makeContentDirs();
    writeFileSync(path.join(topicsDir, "broken.md"), "no frontmatter");
    const items = loadContent(topicsDir);
    expect(items.map((i) => i.id)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("pickNext", () => {
  const items: ContentItem[] = [
    { id: "a", kind: "topic", title: "A", titleJa: "", hints: [] },
    { id: "b", kind: "topic", title: "B", titleJa: "", hints: [] },
    { id: "c", kind: "topic", title: "C", titleJa: "", hints: [] },
  ];

  test("未使用が最優先、同着は id 順", () => {
    const usage: UsageMap = { a: ["2026-07-01"] };
    expect(pickNext(items, usage, "2026-07-05").id).toBe("b");
  });

  test("全部使用済みなら最終使用が最も古いものを選ぶ", () => {
    const usage: UsageMap = { a: ["2026-07-01"], b: ["2026-07-03"], c: ["2026-07-02"] };
    expect(pickNext(items, usage, "2026-07-05").id).toBe("a");
  });

  test("前日と前々日の両方に使ったアイテムは避ける（3日連続回避）", () => {
    const usage: UsageMap = { a: ["2026-07-03", "2026-07-04"], b: ["2026-07-04"], c: ["2026-07-04"] };
    // a は最終使用が古い側だが 7/3・7/4 連続使用なので除外され、b/c から id 順で b
    expect(pickNext(items, usage, "2026-07-05").id).toBe("b");
  });

  test("空配列は throw", () => {
    expect(() => pickNext([], {}, "2026-07-05")).toThrow();
  });
});

describe("buildTodayMenu", () => {
  test("60分版: spec §5.2 の5ブロック構成・分数で、topic/scenario が params に入る", () => {
    const dirs = makeContentDirs();
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(menu.date).toBe("2026-07-05");
    expect(menu.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["chunk-placeholder", 8],
      ["four-three-two", 16],
      ["roleplay", 20],
      ["shadowing", 8],
      ["reflection", 5],
    ]);
    const ftt = menu.blocks[1].params.topic as ContentItem;
    const rp = menu.blocks[2].params.scenario as ContentItem;
    const shadow = menu.blocks[3].params.topic as ContentItem;
    expect(ftt.id).toBe("t1");
    expect(rp.id).toBe("s1");
    expect(shadow.id).not.toBe(ftt.id); // シャドーイングは別トピック（次のローテーション候補）
  });

  test("30分版: spec §5.3 の4ブロック構成・分数", () => {
    const dirs = makeContentDirs();
    const menu = buildTodayMenu(30, { ...dirs, today: JULY5 });
    expect(menu.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["chunk-placeholder", 6],
      ["four-three-two", 12],
      ["roleplay", 10],
      ["reflection", 2],
    ]);
  });

  test("使用記録: 4/3/2とロールプレイのみ記録され、シャドーイングのプレビューは記録されない", () => {
    const dirs = makeContentDirs();
    buildTodayMenu(60, { ...dirs, today: JULY5 });
    const usage = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as UsageMap;
    expect(usage.t1).toEqual(["2026-07-05"]);
    expect(usage.s1).toEqual(["2026-07-05"]);
    expect(usage.t2).toBeUndefined();
  });

  test("同日同minutesの再呼び出しは日次キャッシュから同一メニューを返し、使用記録を重ねない", () => {
    const dirs = makeContentDirs();
    const first = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const second = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(second).toEqual(first);
    const usage = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as UsageMap;
    expect(usage.t1).toEqual(["2026-07-05"]); // 1回だけ
    expect(existsSync(path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json"))).toBe(true);
  });

  test("破損したキャッシュファイルは無視して再構築し、正しいJSONで上書きする", () => {
    const dirs = makeContentDirs();
    mkdirSync(dirs.menuCacheDir, { recursive: true });
    const cacheFile = path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json");
    writeFileSync(cacheFile, "{ this is not valid json");
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(menu.date).toBe("2026-07-05");
    expect(menu.blocks.length).toBe(5);
    const rewritten = JSON.parse(readFileSync(cacheFile, "utf8")) as typeof menu;
    expect(rewritten).toEqual(menu);
  });

  test("キャッシュが妥当なJSONでもMenuの形でない（blocksが配列でない/空）なら再構築して上書きする", () => {
    const dirs = makeContentDirs();
    mkdirSync(dirs.menuCacheDir, { recursive: true });
    const cacheFile = path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json");
    writeFileSync(cacheFile, JSON.stringify({ minutes: 60, date: "2026-07-05", blocks: "not-an-array" }));
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(menu.date).toBe("2026-07-05");
    expect(menu.blocks.length).toBe(5);
    const rewritten = JSON.parse(readFileSync(cacheFile, "utf8")) as typeof menu;
    expect(rewritten).toEqual(menu);
  });

  test("キャッシュのblocksが空配列でも再構築する", () => {
    const dirs = makeContentDirs();
    mkdirSync(dirs.menuCacheDir, { recursive: true });
    const cacheFile = path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json");
    writeFileSync(cacheFile, JSON.stringify({ minutes: 60, date: "2026-07-05", blocks: [] }));
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(menu.blocks.length).toBe(5);
  });

  test("破損した使用状況ファイルは空として扱い、メニューは構築され新規記録が作られる", () => {
    const dirs = makeContentDirs();
    writeFileSync(dirs.usageFile, "{ broken usage json");
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(menu.date).toBe("2026-07-05");
    const usage = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as UsageMap;
    expect(usage.t1).toEqual(["2026-07-05"]);
    expect(usage.s1).toEqual(["2026-07-05"]);
  });

  test("同日に60分版→30分版と続けて構築しても、各アイテムの使用日に同日が重複記録されない", () => {
    const dirs = makeContentDirs();
    buildTodayMenu(60, { ...dirs, today: JULY5 });
    const menu30 = buildTodayMenu(30, { ...dirs, today: JULY5 });
    expect(menu30.date).toBe("2026-07-05");
    const usage = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as UsageMap;
    for (const dates of Object.values(usage)) {
      const todayCount = dates.filter((d) => d === "2026-07-05").length;
      expect(todayCount).toBeLessThanOrEqual(1);
    }
  });
});

describe("four-three-two の roundsSec", () => {
  test("60分・30分とも roundsSec は [120, 90, 60]（スキャフォールド較正値）", () => {
    const dirs = makeContentDirs();
    const m60 = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const ftt60 = m60.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt60.params.roundsSec).toEqual([120, 90, 60]);
    const m30 = buildTodayMenu(30, { ...dirs, today: JULY5 });
    const ftt30 = m30.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt30.params.roundsSec).toEqual([120, 90, 60]);
  });
});
