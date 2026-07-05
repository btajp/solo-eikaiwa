import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROGRESS_DIR, SCENARIOS_DIR, TOPICS_DIR } from "./paths";

export type BlockKind = "chunk-placeholder" | "four-three-two" | "roleplay" | "shadowing" | "reflection";
export type ContentItem = { id: string; kind: "topic" | "scenario"; title: string; titleJa: string; hints: string[] };
export type MenuBlock = { id: string; kind: BlockKind; title: string; minutes: number; params: Record<string, unknown> };
export type Menu = { minutes: 60 | 30; date: string; blocks: MenuBlock[] };
/** id → 使用日(YYYY-MM-DD)の配列。新しい日付が末尾、最大7件保持 */
export type UsageMap = Record<string, string[]>;

/** 4/3/2 ブロックのラウンド秒数。スキャフォールド較正値（流暢性が伸びたら [180,120,90] → [240,180,120] へ戻す） */
export const FTT_ROUNDS_SEC: readonly number[] = [120, 90, 60];

export function parseContentFile(text: string): ContentItem | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  if (!fields.id || !fields.title || (fields.kind !== "topic" && fields.kind !== "scenario")) return null;
  const hints = text.slice(m[0].length).split("\n")
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => l.trim().slice(2));
  return { id: fields.id, kind: fields.kind, title: fields.title, titleJa: fields.title_ja ?? "", hints };
}

export function loadContent(dir: string): ContentItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseContentFile(readFileSync(path.join(dir, f), "utf8")))
    .filter((c): c is ContentItem => c !== null);
}

function ymdOffset(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * least-recently-used ローテーション。未使用が最優先、次に最終使用が古い順（同着はid順）。
 * 前日・前々日の両方に使ったアイテムは除外する（3日連続の同一素材を避ける。
 * ただし全アイテムが除外される場合は全体から選ぶ）。
 */
export function pickNext(items: ContentItem[], usage: UsageMap, todayYmd: string): ContentItem {
  if (items.length === 0) throw new Error("no content items available");
  const y1 = ymdOffset(todayYmd, -1);
  const y2 = ymdOffset(todayYmd, -2);
  const eligible = items.filter((it) => {
    const dates = usage[it.id] ?? [];
    return !(dates.includes(y1) && dates.includes(y2));
  });
  const pool = eligible.length > 0 ? eligible : items;
  const lastUsed = (it: ContentItem) => {
    const d = usage[it.id] ?? [];
    return d.length ? d[d.length - 1] : "";
  };
  return [...pool].sort((a, b) => {
    const la = lastUsed(a);
    const lb = lastUsed(b);
    if (la !== lb) return la < lb ? -1 : 1;
    return a.id.localeCompare(b.id);
  })[0];
}

function markUsed(usage: UsageMap, id: string, ymd: string): void {
  const dates = usage[id] ?? [];
  if (!dates.includes(ymd)) dates.push(ymd);
  usage[id] = dates.slice(-7);
}

/** JSON ファイルを読み込む。存在しない・パース失敗時は警告のみで undefined を返す（呼び出し側でフォールバック） */
function readJsonSafe<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    console.warn(`[menu] failed to parse JSON, ignoring: ${file}`);
    return undefined;
  }
}

/** JSONとしては妥当でも Menu の形になっていないキャッシュ（手動編集・古いフォーマット等）を弾く */
function isValidMenuShape(value: unknown): value is Menu {
  const blocks = (value as Partial<Menu> | undefined)?.blocks;
  return Array.isArray(blocks) && blocks.length > 0;
}

export type MenuDeps = {
  topicsDir?: string;
  scenariosDir?: string;
  usageFile?: string;
  menuCacheDir?: string;
  today?: () => Date;
};

export function buildTodayMenu(minutes: 60 | 30, deps: MenuDeps = {}): Menu {
  const topicsDir = deps.topicsDir ?? TOPICS_DIR;
  const scenariosDir = deps.scenariosDir ?? SCENARIOS_DIR;
  const usageFile = deps.usageFile ?? path.join(PROGRESS_DIR, "topic-usage.json");
  const menuCacheDir = deps.menuCacheDir ?? PROGRESS_DIR;
  const ymd = (deps.today ?? (() => new Date()))().toISOString().slice(0, 10);

  // 同日・同構成なら同一メニューを返す（リロードでトピックが変わらない・使用記録が重ならない）
  const cacheFile = path.join(menuCacheDir, `menu-${ymd}-${minutes}.json`);
  const cached = readJsonSafe<Menu>(cacheFile);
  if (cached) {
    if (isValidMenuShape(cached)) return cached;
    console.warn(`[menu] cached menu has unexpected shape, rebuilding: ${cacheFile}`);
  }

  const usage: UsageMap = readJsonSafe<UsageMap>(usageFile) ?? {};
  const topics = loadContent(topicsDir);
  const scenarios = loadContent(scenariosDir);

  const mainTopic = pickNext(topics, usage, ymd);
  const scenario = pickNext(scenarios, usage, ymd);
  // シャドーイング素材は「次にローテーションが選ぶトピック」のプレビュー。
  // 使用済みマークはしない（近日中に 4/3/2 で回ってくる＝spec §5.2 の「翌日の下敷き」の近似）
  const others = topics.filter((t) => t.id !== mainTopic.id);
  const shadowTopic = others.length > 0 ? pickNext(others, usage, ymd) : mainTopic;

  markUsed(usage, mainTopic.id, ymd);
  markUsed(usage, scenario.id, ymd);
  mkdirSync(path.dirname(usageFile), { recursive: true });
  writeFileSync(usageFile, JSON.stringify(usage, null, 2));

  const chunkTitle = "チャンク産出リトリーバル（M3で実装予定。今日は最近覚えた表現を思い出して口に出す時間）";
  const blocks: MenuBlock[] =
    minutes === 60
      ? [
          { id: "b1", kind: "chunk-placeholder", title: chunkTitle, minutes: 8, params: {} },
          { id: "b2", kind: "four-three-two", title: `4/3/2: ${mainTopic.title}`, minutes: 16, params: { topic: mainTopic, roundsSec: [...FTT_ROUNDS_SEC] } },
          { id: "b3", kind: "roleplay", title: `実務ロールプレイ: ${scenario.title}`, minutes: 20, params: { scenario } },
          { id: "b4", kind: "shadowing", title: `シャドーイング: ${shadowTopic.title}`, minutes: 8, params: { topic: shadowTopic } },
          { id: "b5", kind: "reflection", title: "振り返り", minutes: 5, params: {} },
        ]
      : [
          { id: "b1", kind: "chunk-placeholder", title: chunkTitle, minutes: 6, params: {} },
          { id: "b2", kind: "four-three-two", title: `4/3/2: ${mainTopic.title}`, minutes: 12, params: { topic: mainTopic, roundsSec: [...FTT_ROUNDS_SEC] } },
          { id: "b3", kind: "roleplay", title: `実務ロールプレイ: ${scenario.title}`, minutes: 10, params: { scenario } },
          { id: "b4", kind: "reflection", title: "振り返り", minutes: 2, params: {} },
        ];

  const menu: Menu = { minutes, date: ymd, blocks };
  mkdirSync(menuCacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(menu, null, 2));
  return menu;
}
