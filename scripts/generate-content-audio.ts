#!/usr/bin/env bun
/**
 * v0.26 content-ladder wave5: 多聴素材（全42本・段落単位）と model talk（topic-assets 全36topic・72 stage分）の
 * 音声を一括生成し、リポジトリ同梱の音声バンドル（content/sentences/audio/ — tts.ts の BUNDLED_AUDIO_DIR。
 * 名前は sentences だが sha256(model|voice|text) キーで全カテゴリ共有の唯一の同梱先）へ載せる（冪等）。
 * 暗記例文の音声は従来どおり scripts/generate-sentence-audio.ts が担当する（このスクリプトの対象外）。
 * 対象テキストの収集（どの単位で合成するか）は app/server/content-audio.ts のロジックを使う。
 * 実行方法（app/.env の OPENAI_API_KEY を読み込むため app/ をCWDにする）:
 *   cd app && bun ../scripts/generate-content-audio.ts [listening|model-talk|all] [--limit N]
 * サブコマンド省略時は all（listening + model-talk 両方）。
 */
import { BUNDLED_AUDIO_DIR, LISTENING_DIR, TOPIC_ASSETS_DIR } from "../app/server/paths";
import { collectListeningAudioTargets, collectModelTalkAudioTargets, type AudioTarget } from "../app/server/content-audio";
import { synthesize, DEFAULT_TTS_BASE_URL, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from "../app/server/tts";

const SUBCOMMANDS = ["listening", "model-talk", "all"] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

const rawSub = process.argv[2];
const subcommand: Subcommand = (SUBCOMMANDS as readonly string[]).includes(rawSub) ? (rawSub as Subcommand) : "all";
if (rawSub !== undefined && !rawSub.startsWith("--") && !(SUBCOMMANDS as readonly string[]).includes(rawSub)) {
  console.error(`未知のサブコマンド: ${rawSub}（許容値: ${SUBCOMMANDS.join(", ")}）`);
  process.exit(1);
}

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;
if (limitArg >= 0 && (!Number.isInteger(limit) || limit <= 0)) {
  console.error("--limit には正の整数を指定してください");
  process.exit(1);
}

if (!Bun.env.OPENAI_API_KEY) {
  console.error(
    "OPENAI_API_KEY が見つかりません。say フォールバックはキャッシュされないため一括生成できません。\n" +
    "app/.env を設定し、`cd app && bun ../scripts/generate-content-audio.ts` で実行してください。",
  );
  process.exit(1);
}

function collectTargets(sub: Subcommand): AudioTarget[] {
  const listening = collectListeningAudioTargets(LISTENING_DIR);
  const modelTalk = collectModelTalkAudioTargets(TOPIC_ASSETS_DIR);
  if (sub === "listening") return listening;
  if (sub === "model-talk") return modelTalk;
  return [...listening, ...modelTalk];
}

const targets = collectTargets(subcommand).slice(0, limit === Infinity ? undefined : limit);
console.log(`対象: ${targets.length}件（${subcommand}・並列3・キャッシュ済みはスキップ相当で高速）`);

const failed: Array<{ source: string; error: string }> = [];
let doneCount = 0;

async function generateOne(target: AudioTarget): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      // 同梱バンドルは常に既定（OpenAI）で生成する。TTS_* env に引きずられるとキーがずれて
      // アプリ既定のバンドルルックアップがミスするため、baseUrl/model/voice を既定に固定し env を無視する。
      const result = await synthesize(target.text, {
        cacheDir: BUNDLED_AUDIO_DIR,
        baseUrl: DEFAULT_TTS_BASE_URL,
        model: DEFAULT_TTS_MODEL,
        voice: DEFAULT_TTS_VOICE,
        apiKey: Bun.env.OPENAI_API_KEY,
        cacheTarget: "bundled",
        env: {},
      });
      if (result.engine === "openai") return;
      // say フォールバックはキャッシュされないので失敗扱いにして再試行する
      if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
    } catch {
      if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
    }
    if (attempt === 2) failed.push({ source: target.source, error: "No OpenAI cache (fallback to say)" });
  }
}

const queue = [...targets];
async function worker(): Promise<void> {
  for (;;) {
    const t = queue.shift();
    if (!t) return;
    await generateOne(t);
    doneCount++;
    if (doneCount % 10 === 0 || doneCount === targets.length) console.log(`${doneCount}/${targets.length}`);
  }
}

await Promise.all([worker(), worker(), worker()]);

if (failed.length) {
  console.error(`失敗 ${failed.length}件:`);
  for (const f of failed) console.error(`  ${f.source}: ${f.error}`);
  process.exit(1);
}
console.log(`完了: ${subcommand} の音声が ${BUNDLED_AUDIO_DIR} に揃いました（git add してコミットできます）`);
