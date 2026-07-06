import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { addDaysYmd } from "./dates";
import { DOMAINS, type ContentItem, type Domain } from "./content";

/** id → 使用日(YYYY-MM-DD)の配列。新しい日付が末尾、最大7件保持 */
export type UsageMap = Record<string, string[]>;

/** rotation 永続化 v2。旧形式（UsageMap 直置き）は読み込み時に移行する */
export type RotationState = {
  version: 2;
  usage: UsageMap;
  lastDomain: { topic: Domain | ""; scenario: Domain | "" };
};

/** JSON ファイルを読み込む。存在しない・パース失敗時は警告のみで undefined を返す（呼び出し側でフォールバック） */
export function readJsonSafe<T>(file: string): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    console.warn(`[rotation] failed to parse JSON, ignoring: ${file}`);
    return undefined;
  }
}

/**
 * least-recently-used ローテーション。未使用が最優先、次に最終使用が古い順（同着はid順）。
 * 前日・前々日の両方に使ったアイテムは除外する（3日連続の同一素材を避ける。
 * ただし全アイテムが除外される場合は全体から選ぶ）。
 */
export function pickNext(items: ContentItem[], usage: UsageMap, todayYmd: string): ContentItem {
  if (items.length === 0) throw new Error("no content items available");
  const y1 = addDaysYmd(todayYmd, -1);
  const y2 = addDaysYmd(todayYmd, -2);
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

/** ドメイン明示指定の選択。帯域内→ドメイン全体の順で選び、ラウンドロビンのカーソルは動かさない */
export function pickInDomain(
  items: ContentItem[], state: RotationState, todayYmd: string, stage: number, domain: Domain,
): ContentItem {
  const inDomain = items.filter((it) => it.domain === domain);
  if (inDomain.length === 0) throw new Error(`no content items for domain: ${domain}`);
  return pickNext(filterInBand(inDomain, stage), state.usage, todayYmd);
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

export function markUsed(usage: UsageMap, id: string, ymd: string): void {
  const dates = usage[id] ?? [];
  if (!dates.includes(ymd)) dates.push(ymd);
  usage[id] = dates.slice(-7);
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
export function loadRotation(usageFile: string): RotationState {
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
  console.warn(`[rotation] unknown rotation state shape, starting fresh: ${usageFile}`);
  return freshRotation();
}

export function saveRotation(usageFile: string, state: RotationState): void {
  mkdirSync(path.dirname(usageFile), { recursive: true });
  writeFileSync(usageFile, JSON.stringify(state, null, 2));
}
