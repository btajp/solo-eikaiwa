import path from "node:path";
import { mkdirSync } from "node:fs";
import { localYmd } from "./dates";

export const REPO_ROOT = path.resolve(import.meta.dir, "../..");
export const DATA_DIR = path.join(REPO_ROOT, "data");
// Tauri Phase 1: Caddy無しでも http://127.0.0.1:3111 で完結させるための直接配信先（vite build の出力）
export const CLIENT_DIST_DIR = path.join(REPO_ROOT, "app", "client", "dist");
export const SESSIONS_DIR = path.join(DATA_DIR, "sessions");
export const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");
export const LOGS_DIR = path.join(DATA_DIR, "logs");
// Tauri Phase 1 Task 3: 録音→STT PoC（dev専用 /api/dev/poc-result）の追記先
export const POC_STT_LOG_FILE = path.join(LOGS_DIR, "poc-stt.jsonl");
export const TTS_CACHE_DIR = path.join(DATA_DIR, "tts-cache");
export const MODELS_DIR = path.join(REPO_ROOT, "models");
export const CONTENT_DIR = path.join(REPO_ROOT, "content");
export const TOPICS_DIR = path.join(CONTENT_DIR, "topics");
export const SCENARIOS_DIR = path.join(CONTENT_DIR, "scenarios");
export const LISTENING_DIR = path.join(CONTENT_DIR, "listening");
// v0.26 content-ladder wave3: topic×stage の prepPack/model talk 同梱JSON（topic-assets.ts の3層ルックアップ）
export const TOPIC_ASSETS_DIR = path.join(CONTENT_DIR, "topic-assets");
export const SENTENCES_FILE = path.join(CONTENT_DIR, "sentences", "sentences300.json");
// 暗記例文300の同梱音声（リポジトリにコミット済み・読み取り専用のバンドルキャッシュ）
export const BUNDLED_AUDIO_DIR = path.join(CONTENT_DIR, "sentences", "audio");
// 暗記例文300の同梱解説（同上。都度生成はカスタム例文用のフォールバック）
export const EXPLANATIONS_FILE = path.join(CONTENT_DIR, "sentences", "explanations.json");
export const PROGRESS_DIR = path.join(DATA_DIR, "progress");
// claude -p ランナーの固定作業ディレクトリ。--resume のセッション永続化が cwd にキーされるため、
// mkdtemp 等で毎回変えず常にこのディレクトリを使う（providers/claude-print.ts）。
export const CLAUDE_PRINT_DIR = path.join(DATA_DIR, "claude-print");

export function ensureDirs(): void {
  for (const d of [SESSIONS_DIR, RECORDINGS_DIR, TTS_CACHE_DIR, MODELS_DIR, PROGRESS_DIR, CLAUDE_PRINT_DIR]) {
    mkdirSync(d, { recursive: true });
  }
}

export function sessionLogPath(date: Date): string {
  return path.join(SESSIONS_DIR, `${localYmd(date)}.jsonl`);
}
