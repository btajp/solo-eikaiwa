import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildQuickMenu, buildTodayMenu, FTT_MINI_ROUNDS_SEC, loadContent, parseContentFile, pickNext, QUICK_KINDS,
  type ContentItem, type MenuDeps, type QuickKind, type UsageMap,
} from "../menu";

function makeContentDirs(): { topicsDir: string; scenariosDir: string; usageFile: string; menuCacheDir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "menu-"));
  const topicsDir = path.join(dir, "topics");
  const scenariosDir = path.join(dir, "scenarios");
  const menuCacheDir = path.join(dir, "cache");
  mkdirSync(topicsDir, { recursive: true });
  mkdirSync(scenariosDir, { recursive: true });
  mkdirSync(menuCacheDir, { recursive: true });
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
      domain: "it", level: [1, 6],
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

  test("domain と level をパースする", () => {
    const item = parseContentFile(
      `---\nid: abc\nkind: topic\ntitle: "T"\ntitle_ja: "t"\ndomain: daily\nlevel: [2, 4]\n---\n- hint\n`,
    );
    expect(item?.domain).toBe("daily");
    expect(item?.level).toEqual([2, 4]);
  });

  test("domain / level 省略時はデフォルト（it / [1,6]）", () => {
    const item = parseContentFile(
      `---\nid: abc\nkind: topic\ntitle: "T"\ntitle_ja: "t"\n---\n- hint\n`,
    );
    expect(item?.domain).toBe("it");
    expect(item?.level).toEqual([1, 6]);
  });

  test("不正な domain / level は警告してデフォルトにフォールバック", () => {
    const bad = parseContentFile(
      `---\nid: abc\nkind: topic\ntitle: "T"\ntitle_ja: "t"\ndomain: cooking\nlevel: [0, 9]\n---\n- hint\n`,
    );
    expect(bad?.domain).toBe("it");
    expect(bad?.level).toEqual([1, 6]);
    const reversed = parseContentFile(
      `---\nid: abc\nkind: topic\ntitle: "T"\ntitle_ja: "t"\nlevel: [5, 2]\n---\n- hint\n`,
    );
    expect(reversed?.level).toEqual([1, 6]);
  });
});

describe("pickNext", () => {
  const items: ContentItem[] = [
    { id: "a", kind: "topic", title: "A", titleJa: "", hints: [], domain: "it", level: [1, 6] },
    { id: "b", kind: "topic", title: "B", titleJa: "", hints: [], domain: "it", level: [1, 6] },
    { id: "c", kind: "topic", title: "C", titleJa: "", hints: [], domain: "it", level: [1, 6] },
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
      ["warmup-reading", 8],
      ["four-three-two", 16],
      ["roleplay", 20],
      ["shadowing", 8],
      ["reflection", 5],
    ]);
    const warmup = menu.blocks[0].params.topic as ContentItem;
    const ftt = menu.blocks[1].params.topic as ContentItem;
    const rp = menu.blocks[2].params.scenario as ContentItem;
    const shadow = menu.blocks[3].params.topic as ContentItem;
    expect(ftt.id).toBe("t1");
    expect(rp.id).toBe("s1");
    expect(shadow.id).not.toBe(ftt.id); // シャドーイングは別トピック（次のローテーション候補）
    expect(warmup).toBe(ftt); // 音読ウォームアップは4/3/2と同じトピックオブジェクト（同一Claude呼び出しのキャッシュを共有するため）
  });

  test("30分版: spec §5.3 の4ブロック構成・分数", () => {
    const dirs = makeContentDirs();
    const menu = buildTodayMenu(30, { ...dirs, today: JULY5 });
    expect(menu.blocks.map((b) => [b.kind, b.minutes])).toEqual([
      ["warmup-reading", 6],
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

describe("buildQuickMenu", () => {
  test("warmup: 1ブロック・6分・topic埋め込み・usage記録", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const m = buildQuickMenu("warmup", deps);
    expect(m.minutes).toBe(6);
    expect(m.blocks).toHaveLength(1);
    expect(m.blocks[0].kind).toBe("warmup-reading");
    expect(m.blocks[0].minutes).toBe(6);
    expect((m.blocks[0].params.topic as { id: string }).id).toBe("t1");
    const usage = JSON.parse(readFileSync(usageFile, "utf8"));
    expect(usage.t1).toEqual(["2026-07-05"]);
  });

  test("ftt-mini: four-three-two・8分・roundsSec=[120,90]", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const m = buildQuickMenu("ftt-mini", deps);
    expect(m.minutes).toBe(8);
    expect(m.blocks[0].kind).toBe("four-three-two");
    expect(m.blocks[0].params.roundsSec).toEqual([...FTT_MINI_ROUNDS_SEC]);
    expect(FTT_MINI_ROUNDS_SEC).toEqual([120, 90]);
  });

  test("roleplay: scenario・10分 / shadowing: topic・5分", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const r = buildQuickMenu("roleplay", deps);
    expect(r.minutes).toBe(10);
    expect(r.blocks[0].kind).toBe("roleplay");
    expect((r.blocks[0].params.scenario as { id: string }).id).toBe("s1");
    const s = buildQuickMenu("shadowing", deps);
    expect(s.minutes).toBe(5);
    expect(s.blocks[0].kind).toBe("shadowing");
  });

  test("ローテーションを buildTodayMenu と共有する（同日の再実行は次のアイテム）", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const first = buildQuickMenu("warmup", deps);
    const second = buildQuickMenu("warmup", deps);
    expect((first.blocks[0].params.topic as { id: string }).id).toBe("t1");
    expect((second.blocks[0].params.topic as { id: string }).id).toBe("t2");
    // キャッシュファイルは作らない
    expect(readdirSync(menuCacheDir).filter((f) => f.startsWith("menu-"))).toHaveLength(0);
  });

  test("QUICK_KINDS は4種", () => {
    expect(QUICK_KINDS).toEqual(["warmup", "ftt-mini", "roleplay", "shadowing"]);
  });
});
