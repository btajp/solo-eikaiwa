#!/usr/bin/env bun
/**
 * 対話型多聴（#220）の同梱音声を生成する（冪等）。
 *   cd app && bun ../scripts/generate-dialogue-audio.ts [--limit N]
 * 処理:
 *   1. content/listening の format: dialogue 素材を列挙する
 *   2. ターン（発話）単位で話者別の OpenAI TTS voice（dialogue-audio.ts の割当）で合成する
 *   3. ffmpeg の concat フィルタでターン間ポーズ付きの1本へ結合し、帯別テンポを適用する
 *      （#194: 入門帯は atempo で約137WPMへ減速。OpenAI の speed パラメータは既定モデル
 *      gpt-4o-mini-tts では効かないため、決定的な ffmpeg 時間伸長（ピッチ保持）を使う）
 *   4. 同梱バンドル（content/sentences/audio/）へ dialogueBundledCacheKey（既定model/voice×
 *      ラベル抜き結合本文）で配置する — クライアントが /api/tts へ送る文字列と一致する契約
 * 既に同梱キーの mp3 が存在する素材はスキップする（再実行安全）。
 * 要件: OPENAI_API_KEY（app/.env）と ffmpeg。
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BUNDLED_AUDIO_DIR, LISTENING_DIR } from "../app/server/paths";
import {
  buildDialogueConcatArgs, DIALOGUE_TEMPO_BY_BAND, DIALOGUE_TURN_PAD_SEC,
  dialogueBundledCacheKey, voiceForSpeaker,
} from "../app/server/dialogue-audio";
import { loadListening } from "../app/server/listening";
import { bandForLevel } from "../app/server/spoken-register-check";
import { synthesize, DEFAULT_TTS_BASE_URL, DEFAULT_TTS_MODEL } from "../app/server/tts";

const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : Infinity;
if (limitArg >= 0 && (!Number.isInteger(limit) || limit <= 0)) {
  console.error("--limit には正の整数を指定してください");
  process.exit(1);
}

const apiKey = Bun.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error(
    "OPENAI_API_KEY が見つかりません。対話音声は話者別voiceのHTTP合成が必須です。\n" +
    "app/.env を設定し、`cd app && bun ../scripts/generate-dialogue-audio.ts` で実行してください。",
  );
  process.exit(1);
}

if (Bun.spawnSync(["ffmpeg", "-version"]).exitCode !== 0) {
  console.error("ffmpeg が見つかりません（brew install ffmpeg）。ターン結合に必要です。");
  process.exit(1);
}

const dialogues = loadListening(LISTENING_DIR).filter((it) => it.format === "dialogue");
const targets = dialogues.slice(0, limit === Infinity ? undefined : limit);
console.log(`対象: ${targets.length}件の dialogue 素材（既に同梱済みのものはスキップ）`);

let generated = 0;
let skipped = 0;
const failed: Array<{ id: string; error: string }> = [];

for (const item of targets) {
  const key = dialogueBundledCacheKey(item.turns);
  const outPath = path.join(BUNDLED_AUDIO_DIR, `${key}.mp3`);
  if (existsSync(outPath)) {
    skipped++;
    console.log(`  = ${item.id}: 同梱済み（スキップ）`);
    continue;
  }
  const work = mkdtempSync(path.join(tmpdir(), "dialogue-audio-"));
  try {
    const turnFiles: string[] = [];
    for (let i = 0; i < item.turns.length; i++) {
      const turn = item.turns[i];
      const voice = voiceForSpeaker(item.speakers, turn.speaker);
      // 個々のターンは同梱契約と無関係の一時生成なので、runtimeキャッシュも汚さない一時ディレクトリへ
      const { audio, engine } = await synthesize(turn.text, {
        provider: "openai",
        baseUrl: DEFAULT_TTS_BASE_URL,
        model: DEFAULT_TTS_MODEL,
        voice,
        apiKey,
        cacheDir: path.join(work, "cache"),
        env: {},
      });
      if (engine !== "openai") throw new Error(`turn ${i} が OpenAI 合成になりませんでした`);
      const file = path.join(work, `turn-${String(i).padStart(3, "0")}.mp3`);
      await Bun.write(file, audio);
      turnFiles.push(file);
    }
    const band = bandForLevel(item.level);
    const tempo = DIALOGUE_TEMPO_BY_BAND[band];
    const concatOut = path.join(work, "out.mp3");
    const args = buildDialogueConcatArgs(turnFiles, concatOut, { tempo, padSec: DIALOGUE_TURN_PAD_SEC });
    const proc = Bun.spawnSync(args, { stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(`ffmpeg failed: ${new TextDecoder().decode(proc.stderr).slice(0, 500)}`);
    }
    if (!existsSync(concatOut) || statSync(concatOut).size === 0) {
      throw new Error("ffmpeg の出力が空です");
    }
    mkdirSync(BUNDLED_AUDIO_DIR, { recursive: true });
    renameSync(concatOut, outPath);
    generated++;
    console.log(`  + ${item.id}: ${item.turns.length}ターン → ${key}.mp3（band=${band}・tempo=${tempo}）`);
  } catch (err) {
    failed.push({ id: item.id, error: err instanceof Error ? err.message : String(err) });
    console.error(`  ! ${item.id}: 失敗 — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (failed.length > 0) {
  console.error(`失敗 ${failed.length}件（生成${generated}・スキップ${skipped}）。再実行すると失敗分だけやり直せます。`);
  process.exit(1);
}
console.log(`完了: 生成${generated}件・スキップ${skipped}件（${BUNDLED_AUDIO_DIR} — git add してコミットできます）`);
