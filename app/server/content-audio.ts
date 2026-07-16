/**
 * v0.26 content-ladder wave5: 音声同梱の対象テキスト収集（listening 段落 + model talk）。
 * ランタイムが実際にTTSへ渡すテキスト単位と完全一致させる必要がある。tts.ts のバンドル層
 * （cacheKeyFor(model, voice, text)）はテキストのバイト単位一致でしかヒットしないため、単位を
 * 誤ると同梱音声が一切参照されず、押下のたびに実行時TTSが走ってしまう（コスト・遅延の両方で損）。
 *   - listening: ListeningScreen が playTtsCached(item.paragraphs[i]) で段落単位に渡す
 *     （app/client/src/screens/ListeningScreen.tsx）
 *   - model talk: ShadowingScreen が prefetchModelTalkAudio 経由で topic-assets の modelTalk.text を
 *     丸ごと1本のテキストとして渡す（app/client/src/api/tts.ts prefetchModelTalkAudio → ttsFetch）
 * このモジュールは「どのテキストを事前生成すべきか」の一覧を作るだけの純ロジック。生成そのもの
 * （synthesize 呼び出し・並列・リトライ）は scripts/generate-content-audio.ts が担う。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadListening } from "./listening";
import { parseTopicAssetFile } from "./topic-assets";

export type AudioTarget = { text: string; source: string };

/**
 * listening 全素材の段落テキストを収集する（ListeningScreen が逐次TTS再生する単位そのもの）。
 * dialogue 素材（#220）はスキップする: 話者別 voice のターン結合音声を scripts/generate-dialogue-audio.ts が
 * 同梱キーへ書くため、単一 voice の一括生成がここで同じキーを先取り（=単一声質の対話音声で確定）してはいけない。
 */
export function collectListeningAudioTargets(listeningDir: string): AudioTarget[] {
  const out: AudioTarget[] = [];
  for (const item of loadListening(listeningDir)) {
    if (item.format === "dialogue") continue;
    item.paragraphs.forEach((text, i) => out.push({ text, source: `listening:${item.id}#${i}` }));
  }
  return out;
}

/** 同梱 topic-assets JSON 全件の model talk テキストを収集する（ShadowingScreen が丸ごとTTSへ渡す単位そのもの）。 */
export function collectModelTalkAudioTargets(assetsDir: string): AudioTarget[] {
  if (!existsSync(assetsDir)) return [];
  const out: AudioTarget[] = [];
  for (const file of readdirSync(assetsDir).filter((f) => f.endsWith(".json")).sort()) {
    const asset = parseTopicAssetFile(readFileSync(path.join(assetsDir, file), "utf8"));
    if (!asset) continue; // 検証NGのファイルは無視して続行（手修正禁止の前提どおり、破損は生成し直す対象であってここで救済しない）
    for (const [stage, bundle] of Object.entries(asset.byStage)) {
      if (bundle.modelTalk) out.push({ text: bundle.modelTalk.text, source: `model-talk:${asset.topicId}#stage${stage}` });
    }
  }
  return out;
}
