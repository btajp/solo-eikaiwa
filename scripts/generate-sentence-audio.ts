#!/usr/bin/env bun
/**
 * 暗記例文300の音声を一括生成して content/sentences/audio/（リポジトリ同梱）に載せる（冪等）。
 * 例文を編集・追加した後に再実行すると、音声が無い文だけ生成される。
 * 実行方法（app/.env の OPENAI_API_KEY を読み込むため app/ をCWDにする）:
 *   cd app && bun ../scripts/generate-sentence-audio.ts [--limit N]
 */
import { BUNDLED_AUDIO_DIR } from "../app/server/paths";
import { loadSentences } from "../app/server/sentences";
import { synthesize, DEFAULT_TTS_BASE_URL, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from "../app/server/tts";

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
      // 同梱バンドルは常に既定（OpenAI）で生成する。TTS_* env に引きずられるとキーがずれて
      // アプリ既定のバンドルルックアップがミスするため、baseUrl/model/voice を既定に固定し env を無視する。
      const result = await synthesize(s.en, {
        cacheDir: BUNDLED_AUDIO_DIR,
        baseUrl: DEFAULT_TTS_BASE_URL,
        model: DEFAULT_TTS_MODEL,
        voice: DEFAULT_TTS_VOICE,
        apiKey: Bun.env.OPENAI_API_KEY,
        cacheTarget: "bundled",
        env: {},
      });
      // Check if actually using OpenAI (not the say fallback which is not cached)
      if (result.engine === "openai") {
        return;
      }
      // say fallback is not cached, treat as failure for retry
      if (attempt === 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (err) {
      if (attempt === 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    if (attempt === 2) {
      failed.push({ no: s.no, error: "No OpenAI cache (fallback to say)" });
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
console.log(`完了: 全文の音声が ${BUNDLED_AUDIO_DIR} に揃いました（git add してコミットできます）`);
