import path from "node:path";
import { mkdirSync } from "node:fs";
import { localYmd } from "./dates";

export const REPO_ROOT = path.resolve(import.meta.dir, "../..");
export const DATA_DIR = path.join(REPO_ROOT, "data");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
export const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");
export const TTS_CACHE_DIR = path.join(DATA_DIR, "tts-cache");
export const MODELS_DIR = path.join(REPO_ROOT, "models");
export const CONTENT_DIR = path.join(REPO_ROOT, "content");
export const TOPICS_DIR = path.join(CONTENT_DIR, "topics");
export const SCENARIOS_DIR = path.join(CONTENT_DIR, "scenarios");
export const LISTENING_DIR = path.join(CONTENT_DIR, "listening");
export const SENTENCES_FILE = path.join(CONTENT_DIR, "sentences", "sentences300.json");
// 暗記例文300の同梱音声（リポジトリにコミット済み・読み取り専用のバンドルキャッシュ）
export const BUNDLED_AUDIO_DIR = path.join(CONTENT_DIR, "sentences", "audio");
// 暗記例文300の同梱解説（同上。都度生成はカスタム例文用のフォールバック）
export const EXPLANATIONS_FILE = path.join(CONTENT_DIR, "sentences", "explanations.json");
export const PROGRESS_DIR = path.join(DATA_DIR, "progress");

export function ensureDirs(): void {
  for (const d of [SESSIONS_DIR, RECORDINGS_DIR, TTS_CACHE_DIR, MODELS_DIR, PROGRESS_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

export function sessionLogPath(date: Date): string {
  return path.join(SESSIONS_DIR, `${localYmd(date)}.jsonl`);
}
