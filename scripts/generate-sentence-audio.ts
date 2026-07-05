#!/usr/bin/env bun
/**
 * 暗記例文300の音声を一括生成して data/tts-cache/ に載せる（冪等）。
 * 実行方法（app/.env の OPENAI_API_KEY を読み込むため app/ をCWDにする）:
 *   cd app && bun ../scripts/generate-sentence-audio.ts [--limit N]
 */
import { loadSentences } from "../app/server/sentences";
import { synthesize } from "../app/server/tts";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;
if (limitArg >= 0 && (!Number.isInteger(limit) || limit <= 0)) {
  console.error("--limit には正の整数を指定してください");
  process.exit(1);
}

if (!Bun.env.OPENAI_API_KEY) {
  console.error(
    "OPENAI_API_KEY が見つかりません。say フォールバックはキャッシュされないため一括生成できません。\n" +
    "app/.env を設定し、`cd app && bun ../scripts/generate-sentence-audio.ts` で実行してください。",
  );
  process.exit(1);
}

const sentences = loadSentences().slice(0, limit === Infinity ? undefined : limit);
console.log(`対象: ${sentences.length}文（並列3・キャッシュ済みはスキップ相当で高速）`);

const failed: Array<{ no: number; error: string }> = [];
let doneCount = 0;

async function generateOne(s: { no: number; en: string }): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await synthesize(s.en, {});
      return;
    } catch (err) {
      if (attempt === 2) failed.push({ no: s.no, error: String(err) });
    }
  }
}

const queue = [...sentences];
async function worker(): Promise<void> {
  for (;;) {
    const s = queue.shift();
    if (!s) return;
    await generateOne(s);
    doneCount++;
    if (doneCount % 10 === 0 || doneCount === sentences.length) {
      console.log(`${doneCount}/${sentences.length}`);
    }
  }
}

await Promise.all([worker(), worker(), worker()]);

if (failed.length) {
  console.error(`失敗 ${failed.length}件:`);
  for (const f of failed) console.error(`  No.${f.no}: ${f.error}`);
  process.exit(1);
}
console.log("完了: 全文の音声がキャッシュされました");
