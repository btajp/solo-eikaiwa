import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROGRESS_DIR, SCENARIOS_DIR, TOPICS_DIR } from "./paths";
import { DEFAULT_LEVEL, fttMiniRoundsSec, fttRoundsSec, prepParams, stageOf } from "./progression";

export type BlockKind = "chunk-placeholder" | "warmup-reading" | "four-three-two" | "roleplay" | "shadowing" | "reflection";
/** BlockKind の全メンバー列挙（単一ソース）。routes.ts のバリデーションなど値配列が必要な箇所から import する */
export const BLOCK_KINDS = [
  "chunk-placeholder", "warmup-reading", "four-three-two", "roleplay", "shadowing", "reflection",
] as const satisfies readonly BlockKind[];
export type Domain = "daily" | "business" | "it";
/** ドメインの巡回順（ラウンドロビンはこの順で次を探す） */
export const DOMAINS: readonly Domain[] = ["daily", "business", "it"];
export type ContentItem = {
  id: string; kind: "topic" | "scenario"; title: string; titleJa: string; hints: string[];
  domain: Domain; level: [number, number];
};
export type MenuBlock = { id: string; kind: BlockKind; title: string; minutes: number; params: Record<string, unknown> };
/** level: メニュー構築時点のレベル。日次キャッシュの有効性判定（isValidMenuShape）に使う */
export type Menu = { minutes: number; date: string; level: number; blocks: MenuBlock[] };
/** id → 使用日(YYYY-MM-DD)の配列。新しい日付が末尾、最大7件保持 */
export type UsageMap = Record<string, string[]>;

export type QuickKind = "warmup" | "ftt-mini" | "roleplay" | "shadowing";
export const QUICK_KINDS: readonly QuickKind[] = ["warmup", "ftt-mini", "roleplay", "shadowing"];

/** rotation 永続化 v2。旧形式（UsageMap 直置き）は読み込み時に移行する */
export type RotationState = {
  version: 2;
  usage: UsageMap;
  lastDomain: { topic: Domain | ""; scenario: Domain | "" };
};

function parseDomain(raw: string | undefined): Domain {
  if (raw === undefined) return "it";
  if ((DOMAINS as readonly string[]).includes(raw)) return raw as Domain;
  console.warn(`[menu] invalid domain "${raw}", falling back to "it"`);
  return "it";
}

/** level: [min, max]（1..6, min<=max）。省略はデフォルト、不正は警告してデフォルト */
function parseLevelRange(raw: string | undefined): [number, number] {
  if (raw === undefined) return [1, 6];
  const m = raw.match(/^\[\s*(\d+)\s*,\s*(\d+)\s*\]$/);
  if (m) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    if (min >= 1 && max <= 6 && min <= max) return [min, max];
  }
  console.warn(`[menu] invalid level "${raw}", falling back to [1, 6]`);
  return [1, 6];
}

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
  return {
    id: fields.id, kind: fields.kind, title: fields.title, titleJa: fields.title_ja ?? "", hints,
    domain: parseDomain(fields.domain), level: parseLevelRange(fields.level),
  };
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

/** stage 適合プール（空なら全体にフォールバック） */
export function filterInBand(items: ContentItem[], stage: number): ContentItem[] {
  const inBand = items.filter((it) => it.level[0] <= stage && stage <= it.level[1]);
  return inBand.length > 0 ? inBand : items;
}

/**
 * 帯域フィルタ → ドメインラウンドロビン → LRU の選択（スペック §7.3）。
 * stage 適合プール（空なら全体にフォールバック）から、前回ドメインの次を優先して
 * 存在する最初のドメインを選び、ドメイン内は pickNext（LRU + 3日連続回避）。
 */
export function pickNextByDomain(
  items: ContentItem[], state: RotationState, todayYmd: string, stage: number, kind: "topic" | "scenario",
): ContentItem {
  if (items.length === 0) throw new Error("no content items available");
  const pool = filterInBand(items, stage);
  const last = state.lastDomain[kind];
  const start = last === "" ? 0 : (DOMAINS.indexOf(last) + 1) % DOMAINS.length;
  for (let i = 0; i < DOMAINS.length; i++) {
    const domain = DOMAINS[(start + i) % DOMAINS.length];
    const sub = pool.filter((it) => it.domain === domain);
    if (sub.length === 0) continue;
    const picked = pickNext(sub, state.usage, todayYmd);
    state.lastDomain[kind] = domain;
    return picked;
  }
  return pickNext(pool, state.usage, todayYmd); // 論理上到達しない安全網
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

function freshRotation(): RotationState {
  return { version: 2, usage: {}, lastDomain: { topic: "", scenario: "" } };
}

/** 値が string[] のエントリだけ残す（手動編集で混入した不正値で markUsed が落ちないように） */
function sanitizeUsage(raw: unknown): UsageMap {
  if (typeof raw !== "object" || raw === null) return {};
  const out: UsageMap = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Array.isArray(v) && v.every((d) => typeof d === "string")) out[k] = v as string[];
  }
  return out;
}

/** v2 を読む。旧形式（id→日付配列の直置き）は usage として移行。不明形状は初期状態 */
function loadRotation(usageFile: string): RotationState {
  const raw = readJsonSafe<Record<string, unknown>>(usageFile);
  if (raw === undefined) return freshRotation();
  if (raw.version === 2 && typeof raw.usage === "object" && raw.usage !== null) {
    const last = (raw.lastDomain ?? {}) as Partial<RotationState["lastDomain"]>;
    const valid = (v: unknown): v is Domain | "" => v === "" || (DOMAINS as readonly string[]).includes(v as string);
    return {
      version: 2,
      usage: sanitizeUsage(raw.usage),
      lastDomain: { topic: valid(last.topic) ? last.topic : "", scenario: valid(last.scenario) ? last.scenario : "" },
    };
  }
  // 旧形式: すべての値が配列なら UsageMap とみなして移行
  if (Object.values(raw).every((v) => Array.isArray(v))) {
    return { ...freshRotation(), usage: sanitizeUsage(raw) };
  }
  console.warn(`[menu] unknown rotation state shape, starting fresh: ${usageFile}`);
  return freshRotation();
}

function saveRotation(usageFile: string, state: RotationState): void {
  mkdirSync(path.dirname(usageFile), { recursive: true });
  writeFileSync(usageFile, JSON.stringify(state, null, 2));
}

/**
 * JSONとしては妥当でも Menu の形になっていないキャッシュ（手動編集・古いフォーマット等）を弾く。
 * level フィールドを必須にすることで、Phase B 以前（レベル付きファイル名時代）の
 * キャッシュ本体が万一残っていても自動的に無効化され再構築される。
 */
function isValidMenuShape(value: unknown): value is Menu {
  const v = value as Partial<Menu> | undefined;
  return Array.isArray(v?.blocks) && v.blocks.length > 0 && typeof v?.level === "number";
}

export type MenuDeps = {
  topicsDir?: string;
  scenariosDir?: string;
  usageFile?: string;
  menuCacheDir?: string;
  today?: () => Date;
  /** 利用者レベル（1〜）。省略時 DEFAULT_LEVEL。stage・4/3/2秒数・準備支援を駆動する */
  level?: number;
};

export function buildTodayMenu(minutes: 60 | 30, deps: MenuDeps = {}): Menu {
  const topicsDir = deps.topicsDir ?? TOPICS_DIR;
  const scenariosDir = deps.scenariosDir ?? SCENARIOS_DIR;
  const usageFile = deps.usageFile ?? path.join(PROGRESS_DIR, "topic-usage.json");
  const menuCacheDir = deps.menuCacheDir ?? PROGRESS_DIR;
  const ymd = (deps.today ?? (() => new Date()))().toISOString().slice(0, 10);

  const level = deps.level ?? DEFAULT_LEVEL;
  const stage = stageOf(level);
  // キャッシュキーに level は含めない: 自動昇格が同日中に何度も起きても当日のメニューは固定する
  // （lv接尾辞ありのファイル名は誤って読まれない＝旧形式は自然に無効化される）。
  // レベル変更を同日に反映したい場合は invalidateTodayMenuCache を呼ぶ（明示的な変更のみ）。
  const cacheFile = path.join(menuCacheDir, `menu-${ymd}-${minutes}.json`);
  const cached = readJsonSafe<Menu>(cacheFile);
  if (cached) {
    if (isValidMenuShape(cached)) return cached;
    console.warn(`[menu] cached menu has unexpected shape, rebuilding: ${cacheFile}`);
  }

  const state = loadRotation(usageFile);
  const topics = loadContent(topicsDir);
  const scenarios = loadContent(scenariosDir);

  const mainTopic = pickNextByDomain(topics, state, ymd, stage, "topic");
  const scenario = pickNextByDomain(scenarios, state, ymd, stage, "scenario");
  // シャドーイング素材は「次にローテーションが選ぶトピック」のプレビュー。
  // 使用済みマーク・ドメインカーソルの前進はしない（帯域フィルタだけ適用）
  const others = topics.filter((t) => t.id !== mainTopic.id);
  const shadowPool = others.length > 0 ? filterInBand(others, stage) : others;
  const shadowTopic = shadowPool.length > 0 ? pickNext(shadowPool, state.usage, ymd) : mainTopic;

  markUsed(state.usage, mainTopic.id, ymd);
  markUsed(state.usage, scenario.id, ymd);
  saveRotation(usageFile, state);

  const warmupTitle = "音読ウォームアップ";
  const blocks: MenuBlock[] =
    minutes === 60
      ? [
          { id: "b1", kind: "warmup-reading", title: warmupTitle, minutes: 8, params: { topic: mainTopic } },
          { id: "b2", kind: "four-three-two", title: `4/3/2: ${mainTopic.title}`, minutes: 16, params: { topic: mainTopic, roundsSec: fttRoundsSec(level), modelTalkMode: prepParams(stage).modelTalk } },
          { id: "b3", kind: "roleplay", title: `実務ロールプレイ: ${scenario.title}`, minutes: 20, params: { scenario } },
          { id: "b4", kind: "shadowing", title: `シャドーイング: ${shadowTopic.title}`, minutes: 8, params: { topic: shadowTopic } },
          { id: "b5", kind: "reflection", title: "振り返り", minutes: 5, params: {} },
        ]
      : [
          { id: "b1", kind: "warmup-reading", title: warmupTitle, minutes: 6, params: { topic: mainTopic } },
          { id: "b2", kind: "four-three-two", title: `4/3/2: ${mainTopic.title}`, minutes: 12, params: { topic: mainTopic, roundsSec: fttRoundsSec(level), modelTalkMode: prepParams(stage).modelTalk } },
          { id: "b3", kind: "roleplay", title: `実務ロールプレイ: ${scenario.title}`, minutes: 10, params: { scenario } },
          { id: "b4", kind: "reflection", title: "振り返り", minutes: 2, params: {} },
        ];

  const menu: Menu = { minutes, date: ymd, level, blocks };
  mkdirSync(menuCacheDir, { recursive: true });
  writeFileSync(cacheFile, JSON.stringify(menu, null, 2));
  return menu;
}

/**
 * 当日分の通しメニューキャッシュ（menu-<ymd>-*.json）を削除する。
 * 自動昇格では呼ばない（次回ビルドまで反映を持ち越すのが仕様）。
 * 明示的なレベル変更（accept/set）の直後にだけ呼び、その日のうちに新レベルを反映させる。
 */
export function invalidateTodayMenuCache(todayYmd?: string, cacheDir?: string): void {
  const menuCacheDir = cacheDir ?? PROGRESS_DIR;
  const ymd = todayYmd ?? new Date().toISOString().slice(0, 10);
  if (!existsSync(menuCacheDir)) return;
  const prefix = `menu-${ymd}-`;
  for (const f of readdirSync(menuCacheDir)) {
    if (f.startsWith(prefix) && f.endsWith(".json")) unlinkSync(path.join(menuCacheDir, f));
  }
}

/**
 * 5〜10分の単品ドリルメニュー。日次のデフォルト導線（第3弾リサーチ: 総時間より頻度・完了数が効く）。
 * トピック/シナリオのローテーションと使用記録は buildTodayMenu と共有する。
 * 通しメニューと違いキャッシュしない（同日の再実行は次のアイテムが出る＝意図どおり）。
 */
export function buildQuickMenu(kind: QuickKind, deps: MenuDeps = {}): Menu {
  const topicsDir = deps.topicsDir ?? TOPICS_DIR;
  const scenariosDir = deps.scenariosDir ?? SCENARIOS_DIR;
  const usageFile = deps.usageFile ?? path.join(PROGRESS_DIR, "topic-usage.json");
  const ymd = (deps.today ?? (() => new Date()))().toISOString().slice(0, 10);
  const level = deps.level ?? DEFAULT_LEVEL;
  const stage = stageOf(level);
  const state = loadRotation(usageFile);

  let block: MenuBlock;
  if (kind === "roleplay") {
    const scenario = pickNextByDomain(loadContent(scenariosDir), state, ymd, stage, "scenario");
    markUsed(state.usage, scenario.id, ymd);
    block = { id: "q1", kind: "roleplay", title: `実務ロールプレイ: ${scenario.title}`, minutes: 10, params: { scenario } };
  } else {
    const topic = pickNextByDomain(loadContent(topicsDir), state, ymd, stage, "topic");
    markUsed(state.usage, topic.id, ymd);
    if (kind === "warmup") {
      block = { id: "q1", kind: "warmup-reading", title: "音読ウォームアップ", minutes: 6, params: { topic } };
    } else if (kind === "ftt-mini") {
      block = {
        id: "q1", kind: "four-three-two", title: `4/3/2ミニ: ${topic.title}`, minutes: 8,
        params: { topic, roundsSec: fttMiniRoundsSec(level), modelTalkMode: prepParams(stage).modelTalk },
      };
    } else {
      block = { id: "q1", kind: "shadowing", title: `シャドーイング: ${topic.title}`, minutes: 5, params: { topic } };
    }
  }

  saveRotation(usageFile, state);
  return { minutes: block.minutes, date: ymd, level, blocks: [block] };
}
