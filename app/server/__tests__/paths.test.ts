import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  ensureDirs, REPO_ROOT, DATA_DIR, SESSIONS_DIR, RECORDINGS_DIR, TTS_CACHE_DIR, MODELS_DIR,
  CONTENT_DIR, TOPICS_DIR, SCENARIOS_DIR, PROGRESS_DIR, sessionLogPath,
} from "../paths";

describe("paths", () => {
  test("sessionLogPath は SESSIONS_DIR 配下の YYYY-MM-DD.jsonl を返す", () => {
    const p = sessionLogPath(new Date("2026-07-05T12:34:56Z"));
    expect(p).toBe(path.join(SESSIONS_DIR, "2026-07-05.jsonl"));
  });

  test("ensureDirs 後は全データディレクトリが存在する", () => {
    ensureDirs();
    for (const d of [SESSIONS_DIR, RECORDINGS_DIR, TTS_CACHE_DIR, MODELS_DIR, PROGRESS_DIR]) {
      expect(existsSync(d)).toBe(true);
    }
  });

  test("CONTENT_DIR は REPO_ROOT/content", () => {
    expect(CONTENT_DIR).toBe(path.join(REPO_ROOT, "content"));
  });

  test("TOPICS_DIR は CONTENT_DIR/topics", () => {
    expect(TOPICS_DIR).toBe(path.join(CONTENT_DIR, "topics"));
  });

  test("SCENARIOS_DIR は CONTENT_DIR/scenarios", () => {
    expect(SCENARIOS_DIR).toBe(path.join(CONTENT_DIR, "scenarios"));
  });

  test("PROGRESS_DIR は DATA_DIR/progress", () => {
    expect(PROGRESS_DIR).toBe(path.join(DATA_DIR, "progress"));
  });
});
