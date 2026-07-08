#!/usr/bin/env bun
/**
 * 口語レジスター検証CLI（多聴 md 等の英文が「話し言葉」らしいかを機械的にチェックする）。
 *   bun scripts/check-spoken-register.ts                # content/listening/*.md 全件（既定）
 *   bun scripts/check-spoken-register.ts path/a.md path/b.md  # 指定ファイルのみ
 * 判定は帯（beginner/intermediate/advanced）別閾値（app/server/spoken-register-check.ts）。
 * frontmatter の level（例: [1, 3] / [4, 6]）から帯を推定する。frontmatter が無いファイルは
 * intermediate 帯として扱い、本文全体（frontmatter除去なし）をそのまま検証する。
 * 1件でもFAILがあれば非ゼロで終了する（AI生成教材の手修正は禁止のため、再生成の要否をここで機械判定する）。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, parseLevelRange } from "../app/server/content";
import { checkSpokenRegister, bandForLevel, type SpokenRegisterResult } from "../app/server/spoken-register-check";
import type { SpokenBand } from "../app/server/spoken-style";
import { LISTENING_DIR } from "../app/server/paths";

/** frontmatter があれば除去して本文のみ返す。無ければファイル全体をそのまま返す */
function extractBody(text: string): { body: string; band: SpokenBand } {
  const fm = parseFrontmatter(text);
  if (!fm) return { body: text, band: "intermediate" };
  return { body: fm.body, band: bandForLevel(parseLevelRange(fm.fields.level)) };
}

function defaultTargets(): string[] {
  return readdirSync(LISTENING_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(LISTENING_DIR, f));
}

function formatResult(file: string, result: SpokenRegisterResult): string {
  const m = result.metrics;
  const status = result.pass ? "PASS" : "FAIL";
  const lines = [
    `[${status}] ${path.relative(process.cwd(), file)} (band=${result.band})`,
    `  文数=${m.sentenceCount} 語数=${m.wordCount} 平均文長=${m.avgWordsPerSentence.toFixed(2)}語/文 短縮形率=${m.contractionsPerSentence.toFixed(2)}(短縮形/文)`,
  ];
  for (const reason of result.reasons) lines.push(`  - ${reason}`);
  return lines.join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const targets = args.length > 0 ? args : defaultTargets();
  if (targets.length === 0) {
    console.error(`対象ファイルがありません: ${LISTENING_DIR}`);
    process.exit(1);
  }

  let anyFail = false;
  for (const file of targets) {
    const text = readFileSync(file, "utf8");
    const { body, band } = extractBody(text);
    const result = checkSpokenRegister(body, band);
    console.log(formatResult(file, result));
    if (!result.pass) anyFail = true;
  }

  console.log(anyFail ? "\n結果: FAILあり（再生成が必要です。AI生成教材の手修正は禁止 — AGENTS.md）" : "\n結果: 全件PASS");
  process.exit(anyFail ? 1 : 0);
}

main();
