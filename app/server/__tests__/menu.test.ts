import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildQuickMenu, buildTodayMenu, invalidateTodayMenuCache, QUICK_KINDS, type MenuDeps, type QuickKind,
} from "../menu";
import { loadContent, parseContentFile, type ContentItem, type Domain } from "../content";
import { pickNext, pickNextByDomain, type RotationState, type UsageMap } from "../rotation";
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
});

describe("four-three-two の roundsSec", () => {
  test("60分・30分とも roundsSec は DEFAULT_LEVEL(13) から計算される [110, 85, 55]", () => {
    const dirs = makeContentDirs();
    const m60 = buildTodayMenu(60, { ...dirs, today: JULY5 });
    const ftt60 = m60.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt60.params.roundsSec).toEqual([110, 85, 55]);
    const m30 = buildTodayMenu(30, { ...dirs, today: JULY5 });
    const ftt30 = m30.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt30.params.roundsSec).toEqual([110, 85, 55]);
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

  test("ftt-mini: four-three-two・8分・roundsSec=[110,85]（DEFAULT_LEVEL=13から計算）", () => {
    const { topicsDir, scenariosDir, usageFile, menuCacheDir } = makeContentDirs();
    const deps: MenuDeps = { topicsDir, scenariosDir, usageFile, menuCacheDir, today: JULY5 };
    const m = buildQuickMenu("ftt-mini", deps);
    expect(m.minutes).toBe(8);
    expect(m.blocks[0].kind).toBe("four-three-two");
    expect(m.blocks[0].params.roundsSec).toEqual([110, 85]);
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
    // DEFAULT_LEVEL=13 → stage2。business は帯域外の s1 のみ → フォールバックで s1 が選ばれる
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
  test("roundsSec はレベルから計算される（level 21 → [120,90,60]）", () => {
    const dirs = makeContentDirs();
    const m = buildTodayMenu(60, { ...dirs, level: 21, today: () => new Date("2026-07-06T09:00:00") });
    const ftt = m.blocks.find((b) => b.kind === "four-three-two")!;
    expect(ftt.params.roundsSec).toEqual([120, 90, 60]);
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
    expect(f2.params.roundsSec).toEqual([120, 90, 60]); // 新レベルが即時反映される
    expect(second.level).toBe(21);
    expect(first.level).toBe(13);
  });
});
