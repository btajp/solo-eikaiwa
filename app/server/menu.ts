import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { localYmd } from "./dates";
import { PROGRESS_DIR, SCENARIOS_DIR, TOPICS_DIR } from "./paths";
import { DEFAULT_LEVEL, fttMiniRoundsSec, fttRoundsSec, prepParams, stageOf } from "./progression";
import { loadContent, type ContentItem, type Domain } from "./content";
import {
  filterInBand, loadRotation, markUsed, pickInDomainWithFallback, pickNext, pickNextByDomainWithFallback,
  readJsonSafe, saveRotation, type RotationFallback,
} from "./rotation";

/** BlockKind の全メンバー列挙（単一ソース）。routes のバリデーションなど値配列が必要な箇所から import する */
export const BLOCK_KINDS = [
  "warmup-reading", "four-three-two", "roleplay", "shadowing", "reflection",
] as const;
export type BlockKind = typeof BLOCK_KINDS[number];

function isBlockKind(value: unknown): value is BlockKind {
  return typeof value === "string" && (BLOCK_KINDS as readonly string[]).includes(value);
}

export type MenuTitleKey =
  | "warmup" | "ftt" | "ftt-mini"
  | "roleplay-daily" | "roleplay-business" | "roleplay-it"
  | "shadowing" | "reflection";
export type MenuBlock = {
  id: string; kind: BlockKind; title: string; titleKey: MenuTitleKey; topicTitle?: string;
  minutes: number; params: Record<string, unknown>;
  /**
   * v0.26 wave5: rotation の情報的注記（rotation.ts の RotationFallback）。この block の topic/scenario が
   * ラウンドロビン振替・帯域緩和のフォールバックで選ばれたときだけ載る（無い＝通常選定・additive）。
   * 選定挙動自体は変えず、事実の掲示のみ。UI は警告調ではなく中立な情報行として表示する。
   */
  fallback?: Exclude<RotationFallback, null>;
};
/** level: メニュー構築時点のレベル。日次キャッシュの有効性判定（isValidMenuShape）に使う */
export type Menu = { minutes: number; date: string; level: number; blocks: MenuBlock[] };

export type QuickKind = "warmup" | "ftt-mini" | "roleplay" | "shadowing";
export const QUICK_KINDS: readonly QuickKind[] = ["warmup", "ftt-mini", "roleplay", "shadowing"];

/** ロールプレイのタイトル接頭辞は選ばれたシナリオの実ドメインで付ける */
export function roleplayTitle(scenario: ContentItem): string {
  const label = scenario.domain === "daily" ? "日常" : scenario.domain === "business" ? "ビジネス" : "IT";
  return `${label}ロールプレイ: ${scenario.title}`;
}

/** ロールプレイの titleKey は選ばれたシナリオの実ドメインで決まる */
export function roleplayTitleKey(scenario: ContentItem): MenuTitleKey {
  return scenario.domain === "daily" ? "roleplay-daily" : scenario.domain === "business" ? "roleplay-business" : "roleplay-it";
}

/**
 * JSONとしては妥当でも Menu の形になっていないキャッシュ（手動編集・古いフォーマット等）を弾く。
 * level フィールドを必須にすることで、Phase B 以前のキャッシュ本体が万一残っていても
 * 自動的に無効化・再構築する。hintMode が無い直近の旧形式は当日の教材を保つため、
 * 有効形状として読んだ後に補完する。
 */
function hasCurrentBlockShape(block: unknown): boolean {
  if (!block || typeof block !== "object") return false;
  const { kind, params } = block as { kind?: unknown; params?: unknown };
  if (!isBlockKind(kind)) return false;
  return Boolean(params) && typeof params === "object" && !Array.isArray(params);
}

/** hintMode 追加前の当日メニューを、教材選定や使用記録を動かさずに現在の stage 既定で補完する。 */
function hydrateTopicHintModes(menu: Menu): boolean {
  const hintMode = prepParams(stageOf(menu.level)).hintLang;
  let changed = false;
  for (const block of menu.blocks) {
    if (block.kind !== "warmup-reading" && block.kind !== "four-three-two") continue;
    if (block.params.hintMode === "ja" || block.params.hintMode === "en") continue;
    block.params.hintMode = hintMode;
    changed = true;
  }
  return changed;
}

function isValidMenuShape(value: unknown): value is Menu {
  const v = value as Partial<Menu> | undefined;
  return Array.isArray(v?.blocks) && v.blocks.length > 0 && typeof v?.level === "number" && v.blocks.every(hasCurrentBlockShape);
}

export type MenuDeps = {
  topicsDir?: string;
  scenariosDir?: string;
  usageFile?: string;
  menuCacheDir?: string;
  today?: () => Date;
  /** 利用者レベル（1〜）。省略時 DEFAULT_LEVEL。stage・4/3/2秒数・準備支援を駆動する */
  level?: number;
  /** クイックロールプレイのドメイン明示指定。省略時はラウンドロビン */
  domain?: Domain;
};

export function buildTodayMenu(minutes: 60 | 30, deps: MenuDeps = {}): Menu {
  const topicsDir = deps.topicsDir ?? TOPICS_DIR;
  const scenariosDir = deps.scenariosDir ?? SCENARIOS_DIR;
  const usageFile = deps.usageFile ?? path.join(PROGRESS_DIR, "topic-usage.json");
  const menuCacheDir = deps.menuCacheDir ?? PROGRESS_DIR;
  const ymd = localYmd((deps.today ?? (() => new Date()))());

  const level = deps.level ?? DEFAULT_LEVEL;
  const stage = stageOf(level);
  const prepSupport = prepParams(stage);
  // キャッシュキーに level は含めない: 自動昇格が同日中に何度も起きても当日のメニューは固定する
  // （lv接尾辞ありのファイル名は誤って読まれない＝旧形式は自然に無効化される）。
  // レベル変更を同日に反映したい場合は invalidateTodayMenuCache を呼ぶ（明示的な変更のみ）。
  const cacheFile = path.join(menuCacheDir, `menu-${ymd}-${minutes}.json`);
  const cached = readJsonSafe<Menu>(cacheFile);
  if (cached) {
    if (isValidMenuShape(cached)) {
      if (hydrateTopicHintModes(cached)) writeFileSync(cacheFile, JSON.stringify(cached, null, 2));
      return cached;
    }
    console.warn(`[menu] cached menu has unexpected shape, rebuilding: ${cacheFile}`);
  }

  const state = loadRotation(usageFile);
  const topics = loadContent(topicsDir);
  const scenarios = loadContent(scenariosDir);

  const { item: mainTopic, fallback: topicFallback } = pickNextByDomainWithFallback(topics, state, ymd, stage, "topic");
  const { item: scenario, fallback: scenarioFallback } = pickNextByDomainWithFallback(scenarios, state, ymd, stage, "scenario");
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
          { id: "b1", kind: "warmup-reading", title: warmupTitle, titleKey: "warmup", minutes: 8, params: { topic: mainTopic, hintMode: prepSupport.hintLang }, fallback: topicFallback ?? undefined },
          { id: "b2", kind: "four-three-two", title: `4/3/2: ${mainTopic.title}`, titleKey: "ftt", topicTitle: mainTopic.title, minutes: 16, params: { topic: mainTopic, roundsSec: fttRoundsSec(level), hintMode: prepSupport.hintLang, modelTalkMode: prepSupport.modelTalk }, fallback: topicFallback ?? undefined },
          { id: "b3", kind: "roleplay", title: roleplayTitle(scenario), titleKey: roleplayTitleKey(scenario), topicTitle: scenario.title, minutes: 20, params: { scenario }, fallback: scenarioFallback ?? undefined },
          { id: "b4", kind: "shadowing", title: `シャドーイング: ${shadowTopic.title}`, titleKey: "shadowing", topicTitle: shadowTopic.title, minutes: 8, params: { topic: shadowTopic } },
          { id: "b5", kind: "reflection", title: "振り返り", titleKey: "reflection", minutes: 5, params: {} },
        ]
      : [
          { id: "b1", kind: "warmup-reading", title: warmupTitle, titleKey: "warmup", minutes: 6, params: { topic: mainTopic, hintMode: prepSupport.hintLang }, fallback: topicFallback ?? undefined },
          { id: "b2", kind: "four-three-two", title: `4/3/2: ${mainTopic.title}`, titleKey: "ftt", topicTitle: mainTopic.title, minutes: 12, params: { topic: mainTopic, roundsSec: fttRoundsSec(level), hintMode: prepSupport.hintLang, modelTalkMode: prepSupport.modelTalk }, fallback: topicFallback ?? undefined },
          { id: "b3", kind: "roleplay", title: roleplayTitle(scenario), titleKey: roleplayTitleKey(scenario), topicTitle: scenario.title, minutes: 10, params: { scenario }, fallback: scenarioFallback ?? undefined },
          { id: "b4", kind: "reflection", title: "振り返り", titleKey: "reflection", minutes: 2, params: {} },
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
  const ymd = todayYmd ?? localYmd();
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
  const ymd = localYmd((deps.today ?? (() => new Date()))());
  const level = deps.level ?? DEFAULT_LEVEL;
  const stage = stageOf(level);
  const prepSupport = prepParams(stage);
  const state = loadRotation(usageFile);

  let block: MenuBlock;
  if (kind === "roleplay") {
    const all = loadContent(scenariosDir);
    // ドメイン明示時はそのドメイン内から（ラウンドロビンのカーソル不変）、省略時は従来のローテーション
    const { item: scenario, fallback } = deps.domain
      ? pickInDomainWithFallback(all, state, ymd, stage, deps.domain)
      : pickNextByDomainWithFallback(all, state, ymd, stage, "scenario");
    markUsed(state.usage, scenario.id, ymd);
    block = {
      id: "q1", kind: "roleplay", title: roleplayTitle(scenario), titleKey: roleplayTitleKey(scenario),
      topicTitle: scenario.title, minutes: 10, params: { scenario }, fallback: fallback ?? undefined,
    };
  } else {
    const { item: topic, fallback } = pickNextByDomainWithFallback(loadContent(topicsDir), state, ymd, stage, "topic");
    markUsed(state.usage, topic.id, ymd);
    if (kind === "warmup") {
      block = { id: "q1", kind: "warmup-reading", title: "音読ウォームアップ", titleKey: "warmup", minutes: 6, params: { topic, hintMode: prepSupport.hintLang }, fallback: fallback ?? undefined };
    } else if (kind === "ftt-mini") {
      block = {
        id: "q1", kind: "four-three-two", title: `くり返しトーク（4/3/2）: ${topic.title}`, titleKey: "ftt-mini", topicTitle: topic.title, minutes: 8,
        params: { topic, roundsSec: fttMiniRoundsSec(level), hintMode: prepSupport.hintLang, modelTalkMode: prepSupport.modelTalk }, fallback: fallback ?? undefined,
      };
    } else {
      block = {
        id: "q1", kind: "shadowing", title: `シャドーイング: ${topic.title}`, titleKey: "shadowing",
        topicTitle: topic.title, minutes: 5, params: { topic }, fallback: fallback ?? undefined,
      };
    }
  }

  saveRotation(usageFile, state);
  return { minutes: block.minutes, date: ymd, level, blocks: [block] };
}
