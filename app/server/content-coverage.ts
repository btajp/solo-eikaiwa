/**
 * 教材カバレッジ validator の純ロジック（wave0・docs/superpowers/specs/2026-07-09-content-ladder-design.md §2/§3/§5）。
 * 3帯 [1,2]/[3,4]/[5,6] × 3domain × type別quota の均等充足を、stage単位の適合数で検証する。
 * frontmatter の level: [min,max] は従来どおり stage 範囲が正で、3帯は quota 集計専用のレイヤー（責務分離）。
 * 範囲が複数帯にまたがる既存の広範囲教材（bridge、例 [1,4]）は quota 集計から除外する（資産としては残す）。
 */
import { DOMAINS, type Domain } from "./content";

export type Band = "foundation" | "development" | "fluency";
export const BANDS: readonly Band[] = ["foundation", "development", "fluency"];

/** 帯ごとの stage 範囲（stage-curriculum-ia 計画と同一語彙: foundation/development/fluency） */
export const BAND_STAGE_RANGE: Record<Band, [number, number]> = {
  foundation: [1, 2],
  development: [3, 4],
  fluency: [5, 6],
};

export const STAGES: readonly number[] = [1, 2, 3, 4, 5, 6];

export function bandForStage(stage: number): Band {
  if (stage <= 2) return "foundation";
  if (stage <= 4) return "development";
  return "fluency";
}

export type CoverageType = "topics" | "scenarios" | "listening";

/** 確定数量表（設計doc §3）: 帯×domain あたりの均等quota */
export const QUOTA_PER_BAND_DOMAIN: Record<CoverageType, number> = {
  topics: 4,
  scenarios: 3,
  listening: 4,
};

export type CoverageItem = { id: string; domain: Domain; level: [number, number] };

/**
 * bridge判定: [min,max] の両端が異なる帯に属する教材（範囲が複数帯にまたがる）。
 * 既存教材はほぼ全て level 幅3（例 [1,3]/[4,6]）で、新設計の2stage幅帯を必ずまたぐため bridge に該当する
 * （想定どおり — quota は今後生成する帯内スコープの新規教材で満たす前提。設計doc §3の「既存は資産・quota外」）。
 */
export function isBridgeItem(level: [number, number]): boolean {
  return bandForStage(level[0]) !== bandForStage(level[1]);
}

export type StageCell = {
  type: CoverageType;
  domain: Domain;
  stage: number;
  band: Band;
  quota: number;
  fittingCount: number;
  fittingIds: string[];
  shortfall: number;
  met: boolean;
};

/**
 * stage×domain単位で quota 適合数を数える。bridge教材（isBridgeItem）は対象外とし、
 * 非bridge教材のうち level 範囲が当該 stage を含むものだけを数える。
 */
export function computeStageCells(
  type: CoverageType,
  items: readonly CoverageItem[],
  domains: readonly Domain[] = DOMAINS,
): StageCell[] {
  const quota = QUOTA_PER_BAND_DOMAIN[type];
  const cells: StageCell[] = [];
  for (const domain of domains) {
    for (const stage of STAGES) {
      const fitting = items.filter(
        (it) => it.domain === domain && !isBridgeItem(it.level) && it.level[0] <= stage && stage <= it.level[1],
      );
      const fittingCount = fitting.length;
      const shortfall = Math.max(0, quota - fittingCount);
      cells.push({
        type,
        domain,
        stage,
        band: bandForStage(stage),
        quota,
        fittingCount,
        fittingIds: fitting.map((it) => it.id),
        shortfall,
        met: shortfall === 0,
      });
    }
  }
  return cells;
}

export type BridgeInfo = { id: string; domain: Domain; level: [number, number] };

/** bridge教材の一覧（quota集計外だが資産として存在することを報告するための情報用リスト） */
export function findBridgeItems(items: readonly CoverageItem[]): BridgeInfo[] {
  return items
    .filter((it) => isBridgeItem(it.level))
    .map(({ id, domain, level }) => ({ id, domain, level }));
}

export type CoverageReport = {
  type: CoverageType;
  cells: StageCell[];
  bridgeItems: BridgeInfo[];
  /** cells のうち quota 未充足のセルのみ（band×domain×stage 単位の不足詳細） */
  shortfalls: StageCell[];
};

export function computeCoverageReport(type: CoverageType, items: readonly CoverageItem[]): CoverageReport {
  const cells = computeStageCells(type, items);
  return { type, cells, bridgeItems: findBridgeItems(items), shortfalls: cells.filter((c) => !c.met) };
}
