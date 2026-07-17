#!/usr/bin/env bun
/**
 * 口語レジスター検証CLI（多聴 md 等の英文が「話し言葉」らしいかを機械的にチェックする）。
 *   bun scripts/check-spoken-register.ts                # content/listening/*.md 全件（既定）
 *   bun scripts/check-spoken-register.ts path/a.md path/b.md  # 指定ファイルのみ
 *   bun scripts/check-spoken-register.ts --enforce-word-range # 総語数レンジ(250-450語・#218)も合否に含める
 * 判定は帯（beginner/intermediate/advanced）別閾値（app/server/spoken-register-check.ts）。
 * frontmatter の level（例: [1, 3] / [4, 6]）から帯を推定する。frontmatter が無いファイルは
 * intermediate 帯として扱い、本文全体（frontmatter除去なし）をそのまま検証する。
 * 総語数レンジ（LISTENING_WORD_RANGE）は常に計測して未達本数を報告するが、既存同梱42本が下限未達のため
 * 既定では合否に含めない（--enforce-word-range 指定時のみhard fail。#218/#220 の再生成完了後に既定化する。
 * なお新規生成は content-gen.genListeningForTarget が常時ゲートするため未達素材は追加されない）。
 * 1件でもFAILがあれば非ゼロで終了する（AI生成教材の手修正は禁止のため、再生成の要否をここで機械判定する）。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseFrontmatter, parseLevelRange } from "../app/server/content";
import { dialogueScriptText, parseListeningFile } from "../app/server/listening";
import {
  bandForLevel, checkListeningWordCount, checkSpokenRegister, LISTENING_WORD_RANGE,
  type ListeningWordCountResult, type SpokenRegisterResult,
} from "../app/server/spoken-register-check";
import type { SpokenBand } from "../app/server/spoken-style";
import { LISTENING_DIR } from "../app/server/paths";

/**
 * frontmatter があれば除去して本文のみ返す。無ければファイル全体をそのまま返す。
 * dialogue 素材（#220）は「話者名:」ラベルが語数・文長の雑音になるため、ラベル抜きの発話本文
 * （dialogueScriptText — 生成ゲート genDialogueListeningForTarget と同じ計測単位）で検証する。
 */
function extractBody(text: string): { body: string; band: SpokenBand } {
  const item = parseListeningFile(text);
  if (item?.format === "dialogue") {
    return { body: dialogueScriptText(item.turns), band: bandForLevel(item.level) };
  }
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

function formatResult(
  file: string, result: SpokenRegisterResult, words: ListeningWordCountResult, enforceWordRange: boolean,
): string {
  const m = result.metrics;
  const pass = result.pass && (!enforceWordRange || words.pass);
  const status = pass ? "PASS" : "FAIL";
  const wordRangeNote = words.pass ? "" : enforceWordRange ? "" : "（語数レンジ外・参考: --enforce-word-rangeで合否化）";
  const lines = [
    `[${status}] ${path.relative(process.cwd(), file)} (band=${result.band})${wordRangeNote}`,
    `  文数=${m.sentenceCount} 語数=${m.wordCount} 平均文長=${m.avgWordsPerSentence.toFixed(2)}語/文 短縮形率=${m.contractionsPerSentence.toFixed(2)}(短縮形/文)`,
  ];
  for (const reason of result.reasons) lines.push(`  - ${reason}`);
  if (enforceWordRange) for (const reason of words.reasons) lines.push(`  - ${reason}`);
  return lines.join("\n");
}

function main(): void {
  const args = process.argv.slice(2);
  const enforceWordRange = args.includes("--enforce-word-range");
  const targets = args.filter((a) => a !== "--enforce-word-range");
  const files = targets.length > 0 ? targets : defaultTargets();
  if (files.length === 0) {
    console.error(`対象ファイルがありません: ${LISTENING_DIR}`);
    process.exit(1);
  }

  let anyFail = false;
  let outOfRangeCount = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const { body, band } = extractBody(text);
    const result = checkSpokenRegister(body, band);
    const words = checkListeningWordCount(body);
    if (!words.pass) outOfRangeCount++;
    console.log(formatResult(file, result, words, enforceWordRange));
    if (!result.pass || (enforceWordRange && !words.pass)) anyFail = true;
  }

  if (outOfRangeCount > 0) {
    console.log(
      `\n語数レンジ(${LISTENING_WORD_RANGE.min}-${LISTENING_WORD_RANGE.max}語)外: ${outOfRangeCount}/${files.length}本` +
      (enforceWordRange ? "" : "（#218の実測乖離・#220の再生成対象。既定では合否に含めない）"),
    );
  }
  console.log(anyFail ? "\n結果: FAILあり（再生成が必要です。AI生成教材の手修正は禁止 — AGENTS.md）" : "\n結果: 全件PASS");
  process.exit(anyFail ? 1 : 0);
}

main();
