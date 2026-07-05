import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { ensureDirs, SESSIONS_DIR, RECORDINGS_DIR, TTS_CACHE_DIR, MODELS_DIR, sessionLogPath } from "../paths";

describe("paths", () => {
  test("sessionLogPath は SESSIONS_DIR 配下の YYYY-MM-DD.jsonl を返す", () => {
    const p = sessionLogPath(new Date("2026-07-05T12:34:56Z"));
    expect(p).toBe(path.join(SESSIONS_DIR, "2026-07-05.jsonl"));
  });

  test("ensureDirs 後は全データディレクトリが存在する", () => {
    ensureDirs();
    for (const d of [SESSIONS_DIR, RECORDINGS_DIR, TTS_CACHE_DIR, MODELS_DIR]) {
      expect(existsSync(d)).toBe(true);
    }
  });
});
