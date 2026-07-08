#!/usr/bin/env bun
/**
 * 教材カバレッジ validator CLI（wave0・docs/superpowers/specs/2026-07-09-content-ladder-design.md）。
 *   bun scripts/check-content-coverage.ts          # band×domain の充足レポートを表示
 *   bun scripts/check-content-coverage.ts --json   # 機械可読なJSONを標準出力に出す（表示は省略）
 * topics/scenarios/listening の現物（content/配下）を読み、帯[1,2]/[3,4]/[5,6]×domain×typeのquotaを
 * stage単位の適合数で検証する。範囲が複数帯にまたがるbridge教材（例[1,4]）はquota集計から除外し、
 * 別途「資産一覧」として報告する。1セルでも不足があれば非ゼロで終了する。
 */
import { loadContent, DOMAINS, type Domain } from "../app/server/content";
import { loadListening } from "../app/server/listening";
import { TOPICS_DIR, SCENARIOS_DIR, LISTENING_DIR } from "../app/server/paths";
import {
  computeCoverageReport,
  BANDS,
  BAND_STAGE_RANGE,
  QUOTA_PER_BAND_DOMAIN,
  type CoverageItem,
  type CoverageReport,
  type CoverageType,
} from "../app/server/content-coverage";

function toItems(list: ReadonlyArray<{ id: string; domain: Domain; level: [number, number] }>): CoverageItem[] {
  return list.map((it) => ({ id: it.id, domain: it.domain, level: it.level }));
}

function loadReal(): Record<CoverageType, CoverageItem[]> {
  return {
    topics: toItems(loadContent(TOPICS_DIR)),
    scenarios: toItems(loadContent(SCENARIOS_DIR)),
    listening: toItems(loadListening(LISTENING_DIR)),
  };
}

function formatCell(fittingCount: number, quota: number, met: boolean): string {
  const base = `${fittingCount}/${quota}`;
  return met ? base.padEnd(6) : `${base}!`.padEnd(6);
}

function printReport(report: CoverageReport): void {
  const quota = QUOTA_PER_BAND_DOMAIN[report.type];
  console.log(`\n=== ${report.type} (quota=${quota} per 帯×domain) ===`);
  console.log(`stage  band         ${DOMAINS.map((d) => d.padEnd(12)).join("")}`);
  for (const band of BANDS) {
    const [lo, hi] = BAND_STAGE_RANGE[band];
    for (let stage = lo; stage <= hi; stage++) {
      const cellsForStage = DOMAINS.map((d) => {
        const cell = report.cells.find((c) => c.domain === d && c.stage === stage)!;
        return formatCell(cell.fittingCount, cell.quota, cell.met).padEnd(12);
      });
      console.log(`${String(stage).padEnd(7)}${band.padEnd(13)}${cellsForStage.join("")}`);
    }
  }
  if (report.bridgeItems.length > 0) {
    console.log(`  bridge教材(quota外・資産として残す): ${report.bridgeItems.length}件`);
    for (const b of report.bridgeItems) {
      console.log(`    - ${b.id} [${b.domain}] level=[${b.level[0]}, ${b.level[1]}]`);
    }
  } else {
    console.log("  bridge教材: なし");
  }
  if (report.shortfalls.length > 0) {
    console.log(`  不足セル: ${report.shortfalls.length}件`);
  } else {
    console.log("  不足セル: なし（quota充足）");
  }
}

function main(): void {
  const jsonMode = process.argv.includes("--json");
  const items = loadReal();
  const reports: Record<CoverageType, CoverageReport> = {
    topics: computeCoverageReport("topics", items.topics),
    scenarios: computeCoverageReport("scenarios", items.scenarios),
    listening: computeCoverageReport("listening", items.listening),
  };
  const totalShortfalls = reports.topics.shortfalls.length + reports.scenarios.shortfalls.length + reports.listening.shortfalls.length;

  if (jsonMode) {
    console.log(JSON.stringify({ reports, totalShortfalls }, null, 2));
  } else {
    for (const type of ["topics", "scenarios", "listening"] as const) {
      printReport(reports[type]);
    }
    console.log(
      `\n合計不足セル: ${totalShortfalls}件（topics=${reports.topics.shortfalls.length} / scenarios=${reports.scenarios.shortfalls.length} / listening=${reports.listening.shortfalls.length}）`,
    );
    console.log(totalShortfalls > 0 ? "結果: 不足あり（quota未充足のband×domain×stageがあります）" : "結果: 全セルquota充足");
  }

  process.exit(totalShortfalls > 0 ? 1 : 0);
}

main();
