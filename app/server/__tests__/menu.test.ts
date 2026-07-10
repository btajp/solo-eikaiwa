import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BLOCK_KINDS, buildQuickMenu, buildTodayMenu, invalidateTodayMenuCache, QUICK_KINDS, type MenuDeps, type QuickKind,
} from "../menu";
import { loadContent, parseContentFile, type ContentItem, type Domain } from "../content";
import {
  pickInDomain, pickInDomainWithFallback, pickNext, pickNextByDomain, pickNextByDomainWithFallback,
  type RotationState, type UsageMap,
} from "../rotation";
import { DEFAULT_LEVEL } from "../progression";

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
      hints: ["first hint", "second hint"], starters: [],
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

  test("starters（> 行）を hints と分けて抽出する", () => {
    const item = parseContentFile(
      `---\nid: abc\nkind: scenario\ntitle: "T"\ntitle_ja: "t"\n---\nRoleplay setup:\n- a hint\n> Hello there.\n> How are you today?\n`,
    );
    expect(item?.hints).toEqual(["a hint"]);
    expect(item?.starters).toEqual(["Hello there.", "How are you today?"]);
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
    { id: "a", kind: "topic", title: "A", titleJa: "", hints: [], starters: [], domain: "it", level: [1, 6] },
    { id: "b", kind: "topic", title: "B", titleJa: "", hints: [], starters: [], domain: "it", level: [1, 6] },
    { id: "c", kind: "topic", title: "C", titleJa: "", hints: [], starters: [], domain: "it", level: [1, 6] },
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
    const state = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as RotationState;
    expect(state.usage.t1).toEqual(["2026-07-05"]);
    expect(state.usage.s1).toEqual(["2026-07-05"]);
    expect(state.usage.t2).toBeUndefined();
  });

  test("同日同minutesの再呼び出しは日次キャッシュから同一メニューを返し、使用記録を重ねない", () => {
    const dirs = makeContentDirs();
    const first = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const second = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(second).toEqual(first);
    const state = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as RotationState;
    expect(state.usage.t1).toEqual(["2026-07-05"]); // 1回だけ
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

  test("廃止済みブロックを含むキャッシュは再構築する", () => {
    const dirs = makeContentDirs();
    const cacheFile = path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json");
    writeFileSync(cacheFile, JSON.stringify({
      minutes: 60, date: "2026-07-05", level: DEFAULT_LEVEL,
      blocks: [{ id: "legacy", kind: "chunk-placeholder", title: "legacy", minutes: 1, params: {} }],
    }));

    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });

    expect(BLOCK_KINDS).toEqual(["warmup-reading", "four-three-two", "roleplay", "shadowing", "reflection"]);
    expect(menu.blocks.every((block) => BLOCK_KINDS.includes(block.kind))).toBe(true);
    expect(JSON.parse(readFileSync(cacheFile, "utf8"))).toEqual(menu);
  });

  test("level フィールドの無い旧形式キャッシュ（Phase B 以前）は無効として再構築する", () => {
    const dirs = makeContentDirs();
    mkdirSync(dirs.menuCacheDir, { recursive: true });
    const cacheFile = path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json");
    // blocks は妥当な形だが level フィールドが無い（旧形式）
    writeFileSync(cacheFile, JSON.stringify({
      minutes: 60, date: "2026-07-05",
      blocks: [{ id: "b1", kind: "reflection", title: "old", minutes: 5, params: {} }],
    }));
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(menu.blocks.length).toBe(5); // 旧キャッシュは使われず再構築された
    expect(menu.level).toBe(DEFAULT_LEVEL);
    const rewritten = JSON.parse(readFileSync(cacheFile, "utf8")) as typeof menu;
    expect(rewritten).toEqual(menu);
  });

  test("日本語ヒントの既定値が無い旧キャッシュは当日の教材を変えずに補完する", () => {
    const dirs = makeContentDirs();
    const first = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const cacheFile = path.join(dirs.menuCacheDir, "menu-2026-07-05-60.json");
    const old = JSON.parse(readFileSync(cacheFile, "utf8")) as typeof first;
    for (const block of old.blocks) {
      if (block.kind === "warmup-reading" || block.kind === "four-three-two") delete block.params.hintMode;
    }
    writeFileSync(cacheFile, JSON.stringify(old));

    const rebuilt = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const topicBlocks = rebuilt.blocks.filter((block) => block.kind === "warmup-reading" || block.kind === "four-three-two");
    expect(topicBlocks.map((block) => block.params.hintMode)).toEqual(["ja", "ja"]);
    expect(rebuilt.blocks.map((block) => block.id)).toEqual(first.blocks.map((block) => block.id));
    expect(rebuilt.blocks.map((block) => block.topicTitle)).toEqual(first.blocks.map((block) => block.topicTitle));
  });

  test("破損した使用状況ファイルは空として扱い、メニューは構築され新規記録が作られる", () => {
    const dirs = makeContentDirs();
    writeFileSync(dirs.usageFile, "{ broken usage json");
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    expect(menu.date).toBe("2026-07-05");
    const state = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as RotationState;
    expect(state.usage.t1).toEqual(["2026-07-05"]);
    expect(state.usage.s1).toEqual(["2026-07-05"]);
  });

  test("同日に60分版→30分版と続けて構築しても、各アイテムの使用日に同日が重複記録されない", () => {
    const dirs = makeContentDirs();
    buildTodayMenu(60, { ...dirs, today: JULY5 });
    const menu30 = buildTodayMenu(30, { ...dirs, today: JULY5 });
    expect(menu30.date).toBe("2026-07-05");
    const state = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as RotationState;
    for (const dates of Object.values(state.usage)) {
      const todayCount = dates.filter((d) => d === "2026-07-05").length;
      expect(todayCount).toBeLessThanOrEqual(1);
    }
  });

  test("各ブロックが titleKey を持ち、topic 系は topicTitle を返す（title は従来の日本語のまま）", () => {
    const dirs = makeContentDirs();
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    // makeContentDirs の s1 は domain 省略＝既定 "it" なので roleplay-it になる
    expect(menu.blocks.map((b) => b.titleKey)).toEqual([
      "warmup", "ftt", "roleplay-it", "shadowing", "reflection",
    ]);
    const ftt = menu.blocks[1];
    expect(ftt.topicTitle).toBe("Topic One");
    expect(ftt.title).toBe("4/3/2: Topic One"); // title(JA) は据え置き
    expect(menu.blocks[0].topicTitle).toBeUndefined(); // warmup は topicTitle なし
    expect(menu.blocks[4].topicTitle).toBeUndefined(); // reflection も無し
  });
});

describe("four-three-two の roundsSec", () => {
  test("60分・30分とも roundsSec は DEFAULT_LEVEL(5) から計算される [80, 60, 40]", () => {
    const dirs = makeContentDirs();
    const m60 = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const ftt60 = m60.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt60.params.roundsSec).toEqual([80, 60, 40]);
    const m30 = buildTodayMenu(30, { ...dirs, today: JULY5 });
    const ftt30 = m30.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt30.params.roundsSec).toEqual([80, 60, 40]);
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
    const state = JSON.parse(readFileSync(usageFile, "utf8")) as RotationState;
    expect(state.usage.t1).toEqual(["2026-07-05"]);
  });

  test("ftt-mini: four-three-two・8分・roundsSec=[80,60]（DEFAULT_LEVEL=5から計算）", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const m = buildQuickMenu("ftt-mini", deps);
    expect(m.minutes).toBe(8);
    expect(m.blocks[0].kind).toBe("four-three-two");
    expect(m.blocks[0].params.roundsSec).toEqual([80, 60]);
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

  test("roleplay: domain 指定でそのドメインのシナリオだけが選ばれ、カーソルは動かない", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    // s1=daily(タグ付き), s2=タグなし(既定 it)
    writeFileSync(
      path.join(scenariosDir, "s1.md"),
      `---\nid: s1\nkind: scenario\ntitle: "Daily One"\ntitle_ja: "ja-s1"\ndomain: daily\nlevel: [1, 3]\n---\nSetup:\n- You are at a cafe\n`,
    );
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5, domain: "daily" };
    const m = buildQuickMenu("roleplay", deps);
    expect((m.blocks[0].params.scenario as { id: string }).id).toBe("s1");
    expect(m.blocks[0].title).toBe("日常ロールプレイ: Daily One");
    const state = JSON.parse(readFileSync(usageFile, "utf8")) as RotationState;
    expect(state.lastDomain.scenario).toBe(""); // 明示指定はラウンドロビンに影響しない
  });

  test("roleplay: domain 指定で帯域外しかない場合はドメイン内全体にフォールバックする", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    writeFileSync(
      path.join(scenariosDir, "s1.md"),
      `---\nid: s1\nkind: scenario\ntitle: "Hard Business"\ntitle_ja: "ja-s1"\ndomain: business\nlevel: [5, 6]\n---\nSetup:\n- Negotiate a contract\n`,
    );
    // DEFAULT_LEVEL=5 → stage1。business は帯域外の s1 のみ → フォールバックで s1 が選ばれる
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5, domain: "business" };
    const m = buildQuickMenu("roleplay", deps);
    expect((m.blocks[0].params.scenario as { id: string }).id).toBe("s1");
    expect(m.blocks[0].title).toBe("ビジネスロールプレイ: Hard Business");
  });

  test("roleplay: domain 省略時は従来どおりラウンドロビンでカーソルが進む", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    buildQuickMenu("roleplay", deps);
    const state = JSON.parse(readFileSync(usageFile, "utf8")) as RotationState;
    expect(state.lastDomain.scenario).not.toBe("");
  });

  test("quick メニューも titleKey/topicTitle を返す", () => {
    const dirs = makeContentDirs();
    const deps: MenuDeps = { ...dirs, today: JULY5 };
    expect(buildQuickMenu("warmup", deps).blocks[0].titleKey).toBe("warmup");
    expect(buildQuickMenu("ftt-mini", deps).blocks[0].titleKey).toBe("ftt-mini");
    // warmup(t1) → ftt-mini 1回目(t2) の順で消費済みのため、2回目は LRU で t3(Topic Three) が選ばれる
    expect(buildQuickMenu("ftt-mini", deps).blocks[0].topicTitle).toBe("Topic Three");
    expect(buildQuickMenu("shadowing", deps).blocks[0].titleKey).toBe("shadowing");
    // s1 は domain 省略＝既定 "it" のため roleplay-it（domain 明示時のロールプレイは既存テスト 319/334 行が担保）
    expect(buildQuickMenu("roleplay", deps).blocks[0].titleKey).toBe("roleplay-it");
  });
});

describe("pickNextByDomainWithFallback（v0.26 wave5: rotation の情報的注記）", () => {
  const mk = (id: string, domain: "daily" | "business" | "it", level: [number, number]): ContentItem =>
    ({ id, kind: "topic", title: id, titleJa: "", hints: [], starters: [], domain, level });
  const items = [
    mk("d1", "daily", [1, 6]), mk("d2", "daily", [1, 6]),
    mk("b1", "business", [1, 6]),
    mk("i1", "it", [1, 6]), mk("i2", "it", [4, 6]),
  ];

  test("通常時（本来の次ドメインに在庫あり・帯適合あり）は fallback が null", () => {
    const state: RotationState = { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
    const { item, fallback } = pickNextByDomainWithFallback(items, state, "2026-07-06", 2, "topic");
    expect(item.domain).toBe("daily"); // 選定結果は既存の pickNextByDomain と同一
    expect(fallback).toBeNull();
  });

  test("本来の次ドメインの在庫がゼロで振り替わったら domain-substituted（選定結果自体は変えない）", () => {
    const noBusiness = items.filter((it) => it.domain !== "business");
    const state: RotationState = { version: 2, usage: {}, lastDomain: { topic: "daily", scenario: "" } };
    const { item, fallback } = pickNextByDomainWithFallback(noBusiness, state, "2026-07-06", 2, "topic");
    expect(item.domain).toBe("it"); // 既存の pickNextByDomain と同じ選定結果
    expect(fallback).toBe("domain-substituted");
  });

  test("全アイテムが stage 不適合で帯域を無視したら band-relaxed", () => {
    const hard = [mk("x1", "it", [5, 6]), mk("x2", "daily", [4, 6])];
    const state: RotationState = { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
    const { fallback } = pickNextByDomainWithFallback(hard, state, "2026-07-06", 1, "topic");
    expect(fallback).toBe("band-relaxed");
  });

  test("band-relaxed と domain-substituted が同時発生時は band-relaxed を優先する", () => {
    // it ドメインしか存在せず、かつ stage に帯適合しない → 帯域緩和とドメイン振替が同時に起きる
    const onlyIt = [mk("z1", "it", [5, 6])];
    const state: RotationState = { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
    const { item, fallback } = pickNextByDomainWithFallback(onlyIt, state, "2026-07-06", 1, "topic");
    expect(item.id).toBe("z1");
    expect(fallback).toBe("band-relaxed");
  });

  test("pickNextByDomain（従来API）は fallback 情報を持たず選定結果のみ返す（後方互換）", () => {
    const state: RotationState = { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
    const picked = pickNextByDomain(items, state, "2026-07-06", 2, "topic");
    expect(picked.domain).toBe("daily");
  });
});

describe("pickInDomainWithFallback（v0.26 wave5: rotation の情報的注記）", () => {
  const mk = (id: string, domain: "daily" | "business" | "it", level: [number, number]): ContentItem =>
    ({ id, kind: "topic", title: id, titleJa: "", hints: [], starters: [], domain, level });

  test("帯適合ありなら fallback は null", () => {
    const items = [mk("a", "business", [1, 6]), mk("b", "business", [1, 6])];
    const state: RotationState = { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
    const { item, fallback } = pickInDomainWithFallback(items, state, "2026-07-06", 2, "business");
    expect(item.domain).toBe("business");
    expect(fallback).toBeNull();
  });

  test("指定ドメイン内に帯適合が無ければ band-relaxed（ドメイン全体から選ぶ・選定結果は変えない）", () => {
    const items = [mk("hard", "business", [5, 6])];
    const state: RotationState = { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
    const { item, fallback } = pickInDomainWithFallback(items, state, "2026-07-06", 1, "business");
    expect(item.id).toBe("hard"); // pickInDomain と同じ選定結果
    expect(fallback).toBe("band-relaxed");
  });

  test("pickInDomain（従来API）は fallback 情報を持たず選定結果のみ返す（後方互換）", () => {
    const items = [mk("a", "business", [1, 6])];
    const state: RotationState = { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
    expect(pickInDomain(items, state, "2026-07-06", 2, "business").id).toBe("a");
  });
});

describe("menu: rotation fallback の情報的注記（block.fallback）", () => {
  function makeDomainDirs(
    topics: Array<{ id: string; domain: string; level: [number, number] }>,
    scenarios: Array<{ id: string; domain: string; level: [number, number] }>,
  ): { topicsDir: string; scenariosDir: string; usageFile: string; menuCacheDir: string } {
    const dir = mkdtempSync(path.join(tmpdir(), "menu-fallback-"));
    const topicsDir = path.join(dir, "topics");
    const scenariosDir = path.join(dir, "scenarios");
    const menuCacheDir = path.join(dir, "cache");
    mkdirSync(topicsDir, { recursive: true });
    mkdirSync(scenariosDir, { recursive: true });
    mkdirSync(menuCacheDir, { recursive: true });
    for (const t of topics) {
      writeFileSync(
        path.join(topicsDir, `${t.id}.md`),
        `---\nid: ${t.id}\nkind: topic\ntitle: "${t.id}"\ntitle_ja: "ja-${t.id}"\ndomain: ${t.domain}\nlevel: [${t.level[0]}, ${t.level[1]}]\n---\n- hint one\n- hint two\n`,
      );
    }
    for (const s of scenarios) {
      writeFileSync(
        path.join(scenariosDir, `${s.id}.md`),
        `---\nid: ${s.id}\nkind: scenario\ntitle: "${s.id}"\ntitle_ja: "ja-${s.id}"\ndomain: ${s.domain}\nlevel: [${s.level[0]}, ${s.level[1]}]\n---\n- setup one\n`,
      );
    }
    return { topicsDir, scenariosDir, usageFile: path.join(dir, "usage.json"), menuCacheDir };
  }

  test("3ドメインとも在庫があり帯適合もあれば block.fallback は付かない", () => {
    const dirs = makeDomainDirs(
      [
        { id: "dt", domain: "daily", level: [1, 6] },
        { id: "bt", domain: "business", level: [1, 6] },
        { id: "tt", domain: "it", level: [1, 6] },
      ],
      [
        { id: "ds", domain: "daily", level: [1, 6] },
        { id: "bs", domain: "business", level: [1, 6] },
        { id: "ts", domain: "it", level: [1, 6] },
      ],
    );
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 }); // DEFAULT_LEVEL(5) → stage1
    const warmup = menu.blocks.find((b) => b.kind === "warmup-reading")!;
    const roleplay = menu.blocks.find((b) => b.kind === "roleplay")!;
    expect(warmup.fallback).toBeUndefined();
    expect(roleplay.fallback).toBeUndefined();
  });

  test("トピックが1ドメインにしか無いと、ラウンドロビンの振替がblock.fallbackにdomain-substitutedとして載る", () => {
    const dirs = makeDomainDirs(
      [{ id: "tt", domain: "it", level: [1, 6] }],
      [{ id: "ts", domain: "it", level: [1, 6] }],
    );
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const warmup = menu.blocks.find((b) => b.kind === "warmup-reading")!;
    const ftt = menu.blocks.find((b) => b.kind === "four-three-two")!;
    const roleplay = menu.blocks.find((b) => b.kind === "roleplay")!;
    expect(warmup.fallback).toBe("domain-substituted");
    expect(ftt.fallback).toBe("domain-substituted"); // mainTopic と同じ選定を共有
    expect(roleplay.fallback).toBe("domain-substituted");
  });

  test("全教材が現在の帯に不適合だと、block.fallbackにband-relaxedとして載る", () => {
    // DEFAULT_LEVEL(5) → stage1。教材は全て level [4,6] で stage1 に不適合
    const dirs = makeDomainDirs(
      [
        { id: "dt", domain: "daily", level: [4, 6] },
        { id: "bt", domain: "business", level: [4, 6] },
        { id: "tt", domain: "it", level: [4, 6] },
      ],
      [
        { id: "ds", domain: "daily", level: [4, 6] },
        { id: "bs", domain: "business", level: [4, 6] },
        { id: "ts", domain: "it", level: [4, 6] },
      ],
    );
    const menu = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const warmup = menu.blocks.find((b) => b.kind === "warmup-reading")!;
    const roleplay = menu.blocks.find((b) => b.kind === "roleplay")!;
    expect(warmup.fallback).toBe("band-relaxed");
    expect(roleplay.fallback).toBe("band-relaxed");
  });

  test("buildQuickMenu の roleplay（domain明示）でも帯域緩和はband-relaxedとしてblock.fallbackに載る", () => {
    const dirs = makeDomainDirs(
      [],
      [{ id: "hard", domain: "business", level: [5, 6] }],
    );
    const deps: MenuDeps = { ...dirs, today: JULY5, domain: "business" };
    const m = buildQuickMenu("roleplay", deps);
    expect(m.blocks[0].fallback).toBe("band-relaxed");
  });
});

function freshState(): RotationState {
  return { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
}

describe("pickNextByDomain", () => {
  const mk = (id: string, domain: "daily" | "business" | "it", level: [number, number]): ContentItem =>
    ({ id, kind: "topic", title: id, titleJa: "", hints: [], starters: [], domain, level });
  const items = [
    mk("d1", "daily", [1, 6]), mk("d2", "daily", [1, 6]),
    mk("b1", "business", [1, 6]),
    mk("i1", "it", [1, 6]), mk("i2", "it", [4, 6]),
  ];

  test("ドメインを daily→business→it→daily の順に巡回する", () => {
    const state = freshState();
    expect(pickNextByDomain(items, state, "2026-07-06", 2, "topic").domain).toBe("daily");
    expect(pickNextByDomain(items, state, "2026-07-06", 2, "topic").domain).toBe("business");
    expect(pickNextByDomain(items, state, "2026-07-06", 2, "topic").domain).toBe("it");
    expect(pickNextByDomain(items, state, "2026-07-06", 2, "topic").domain).toBe("daily");
  });

  test("stage 適合プールでフィルタする（stage2 は level [4,6] を除外）", () => {
    const state = freshState();
    state.lastDomain.topic = "business"; // 次は it
    const picked = pickNextByDomain(items, state, "2026-07-06", 2, "topic");
    expect(picked.id).toBe("i1"); // i2 は [4,6] で stage2 に不適合
  });

  test("プールが空になるドメインはスキップする", () => {
    const noBusiness = items.filter((it) => it.domain !== "business");
    const state = freshState();
    // TS の control-flow narrowing がリテラル代入を関数呼び出し越しに保持してしまうため、
    // 後続の `expect(state.lastDomain.topic).toBe("it")` と型不整合にならないよう Domain へ widen する
    state.lastDomain.topic = "daily" as Domain; // 次は business → 無いので it へ
    expect(pickNextByDomain(noBusiness, state, "2026-07-06", 2, "topic").domain).toBe("it");
    expect(state.lastDomain.topic).toBe("it");
  });

  test("全アイテムが stage 不適合なら全体にフォールバックする", () => {
    const hard = [mk("x1", "it", [5, 6]), mk("x2", "daily", [4, 6])];
    const state = freshState();
    const picked = pickNextByDomain(hard, state, "2026-07-06", 1, "topic");
    expect(["x1", "x2"]).toContain(picked.id);
  });

  test("topic と scenario は別々のドメインカーソルを持つ", () => {
    const state = freshState();
    pickNextByDomain(items, state, "2026-07-06", 2, "topic");
    expect(state.lastDomain.topic).toBe("daily");
    expect(state.lastDomain.scenario).toBe("");
  });
});

describe("rotation 永続化の後方互換", () => {
  test("旧形式（UsageMap 直置き）を読んだら v2 に移行し LRU を引き継ぐ", () => {
    const dirs = makeContentDirs();
    // 旧形式: id → 日付配列 の直置き
    writeFileSync(dirs.usageFile, JSON.stringify({ t1: ["2026-07-04"] }));
    const m = buildQuickMenu("warmup", { ...dirs, today: JULY5 });
    // t1 は使用済みなので LRU により t2 が選ばれる（旧 usage が引き継がれている証拠）
    expect((m.blocks[0].params.topic as { id: string }).id).toBe("t2");
    const saved = JSON.parse(readFileSync(dirs.usageFile, "utf8")) as RotationState;
    expect(saved.version).toBe(2);
    expect(saved.usage.t1).toEqual(["2026-07-04"]);
    expect(saved.lastDomain.topic).toBe("it"); // フィクスチャは全て domain 省略 = it
  });
});

describe("menu: レベル駆動", () => {
  test("roundsSec はレベルから計算される（level 21 → [125,95,65]）", () => {
    const dirs = makeContentDirs();
    const m = buildTodayMenu(60, { ...dirs, level: 21, today: () => new Date("2026-07-06T09:00:00") });
    const ftt = m.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt.params.roundsSec).toEqual([125, 95, 65]);
  });
  test("modelTalkMode が stage に応じて params に載る（level 45 → button, 55 → button, 13 → auto）", () => {
    // キャッシュは level を問わず同日1本なので、level ごとに別ディレクトリ（別キャッシュ）を使う
    for (const [level, mode] of [[45, "button"], [55, "button"], [13, "auto"]] as const) {
      const dirs = makeContentDirs();
      const m = buildTodayMenu(60, { ...dirs, level, today: () => new Date("2026-07-06T09:00:00") });
      const ftt = m.blocks.find((b) => b.kind === "four-three-two")!;
      expect(ftt.params.modelTalkMode).toBe(mode);
    }
  });
  test("日本語ヒントの利用可否既定を全トピックブロックへ渡す", () => {
    for (const [level, hintMode] of [[13, "ja"], [45, "en"]] as const) {
      const dirs = makeContentDirs();
      const daily = buildTodayMenu(60, { ...dirs, level, today: () => new Date("2026-07-06T09:00:00") });
      const topicBlocks = daily.blocks.filter((block) => block.kind === "warmup-reading" || block.kind === "four-three-two");
      expect(topicBlocks.map((block) => block.params.hintMode)).toEqual([hintMode, hintMode]);

      const quickWarmup = buildQuickMenu("warmup", { ...makeContentDirs(), level, today: () => new Date("2026-07-06T09:00:00") });
      const quickFtt = buildQuickMenu("ftt-mini", { ...makeContentDirs(), level, today: () => new Date("2026-07-06T09:00:00") });
      expect(quickWarmup.blocks[0].params.hintMode).toBe(hintMode);
      expect(quickFtt.blocks[0].params.hintMode).toBe(hintMode);
    }
  });
  test("同日はレベルが変わってもキャッシュヒットし、当日のメニューは固定される（自動昇格の反映は翌日以降）", () => {
    const dirs = makeContentDirs();
    const today = () => new Date("2026-07-06T09:00:00");
    const m13 = buildTodayMenu(60, { ...dirs, level: 13, today });
    const stateAfterFirst = readFileSync(dirs.usageFile, "utf8");
    const m21 = buildTodayMenu(60, { ...dirs, level: 21, today });
    expect(m21).toEqual(m13); // レベルが変わっても同日はキャッシュヒットで同一メニュー
    const f21 = m21.blocks.find((b) => b.kind === "four-three-two")!;
    expect(f21.params.roundsSec).toEqual([110, 85, 55]); // 構築時（level 13）の値のまま
    // ローテーション状態が二重前進していないこと（キャッシュヒット時は pickNextByDomain/markUsed を再実行しない）
    expect(readFileSync(dirs.usageFile, "utf8")).toBe(stateAfterFirst);
  });
});

describe("menu: rotation state の防御（Phase A 持ち越し）", () => {
  test("v2 の usage に配列でない値が混ざっていたら該当エントリだけ捨てる", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "menu-"));
    const usageFile = path.join(dir, "u.json");
    writeFileSync(usageFile, JSON.stringify({
      version: 2,
      usage: { good: ["2026-07-01"], broken: 42, alsoBad: "x" },
      lastDomain: { topic: "", scenario: "" },
    }));
    const dirs = makeContentDirs();
    // クラッシュせずメニューが組めること（markUsed が dates.push で落ちない）
    const m = buildTodayMenu(60, { ...dirs, usageFile, level: 13, today: () => new Date("2026-07-06T09:00:00") });
    expect(m.blocks.length).toBeGreaterThan(0);
  });
  test("部分的な v2 形状（usage欠落）は初期状態から開始する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "menu-"));
    const usageFile = path.join(dir, "u.json");
    writeFileSync(usageFile, JSON.stringify({ version: 2 }));
    const dirs = makeContentDirs();
    const m = buildTodayMenu(60, { ...dirs, usageFile, level: 13, today: () => new Date("2026-07-06T09:00:00") });
    expect(m.blocks.length).toBeGreaterThan(0);
  });
});

describe("invalidateTodayMenuCache", () => {
  test("当日分の menu-<ymd>-*.json だけ削除し、他日・無関係ファイルは残す", () => {
    const dirs = makeContentDirs();
    buildTodayMenu(60, { ...dirs, today: JULY5 });
    buildTodayMenu(30, { ...dirs, today: JULY5 });
    const otherDayFile = path.join(dirs.menuCacheDir, "menu-2026-07-04-60.json");
    writeFileSync(otherDayFile, JSON.stringify({ minutes: 60, date: "2026-07-04", level: 13, blocks: [] }));
    const unrelatedFile = path.join(dirs.menuCacheDir, "topic-usage.json");
    writeFileSync(unrelatedFile, "{}");
    expect(readdirSync(dirs.menuCacheDir).sort()).toEqual([
      "menu-2026-07-04-60.json", "menu-2026-07-05-30.json", "menu-2026-07-05-60.json", "topic-usage.json",
    ]);

    invalidateTodayMenuCache("2026-07-05", dirs.menuCacheDir);

    expect(readdirSync(dirs.menuCacheDir).sort()).toEqual(["menu-2026-07-04-60.json", "topic-usage.json"]);
  });

  test("キャッシュディレクトリが存在しなくても例外を投げない", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "menu-"));
    expect(() => invalidateTodayMenuCache("2026-07-05", path.join(dir, "does-not-exist"))).not.toThrow();
  });

  test("無効化後の再構築はローテーションを再度前進させる（明示的変更は同日反映が優先）", () => {
    const dirs = makeContentDirs();
    const today = JULY5;
    const first = buildTodayMenu(60, { ...dirs, level: 13, today });
    invalidateTodayMenuCache("2026-07-05", dirs.menuCacheDir);
    const second = buildTodayMenu(60, { ...dirs, level: 21, today });
    const f2 = second.blocks.find((b) => b.kind === "four-three-two")!;
    expect(f2.params.roundsSec).toEqual([125, 95, 65]); // 新レベルが即時反映される
    expect(second.level).toBe(21);
    expect(first.level).toBe(13);
  });
});
