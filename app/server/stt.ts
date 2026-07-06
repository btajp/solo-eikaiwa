import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { MODELS_DIR } from "./paths";
import { realSpawn, type SpawnFn } from "./spawn";
export type { SpawnFn } from "./spawn";

export const WHISPER_MODEL_PATH = path.join(MODELS_DIR, "ggml-large-v3-turbo.bin");

export function buildWhisperArgs(modelPath: string, wavPath: string, outBase: string): string[] {
  return ["-m", modelPath, "-f", wavPath, "-l", "en", "-oj", "-of", outBase, "-np"];
}

export type SttSegment = { fromMs: number; toMs: number; text: string };
export type Transcription = { text: string; segments: SttSegment[] };

export function parseWhisperJson(jsonText: string): Transcription {
  const data = JSON.parse(jsonText) as {
    transcription?: Array<{ text: string; offsets?: { from?: number; to?: number } }>;
  };
  if (!data.transcription) return { text: "", segments: [] };
  const segments: SttSegment[] = data.transcription.map((s) => ({
    fromMs: typeof s.offsets?.from === "number" ? s.offsets.from : 0,
    toMs: typeof s.offsets?.to === "number" ? s.offsets.to : 0,
    text: s.text,
  }));
  return { text: segments.map((s) => s.text).join("").trim(), segments };
}

function whisperBin(): string {
  return Bun.which("whisper-cli") ?? Bun.which("whisper-cpp") ?? "whisper-cli";
}

/** 入力音声（webm/wav等）を 16kHz mono WAV に変換して whisper で文字起こしする */
export async function transcribeAudio(
  inputPath: string,
  opts: { spawnFn?: SpawnFn } = {},
): Promise<Transcription> {
  const spawn = opts.spawnFn ?? realSpawn;
  const work = mkdtempSync(path.join(tmpdir(), "stt-"));
  try {
    const wavPath = path.join(work, "in.wav");
    const ff = await spawn([
      "ffmpeg", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath, "-y",
    ]);
    if (ff.exitCode !== 0) throw new Error(`ffmpeg failed: ${ff.stderr.slice(-500)}`);

    const outBase = path.join(work, "out");
    const wh = await spawn([whisperBin(), ...buildWhisperArgs(WHISPER_MODEL_PATH, wavPath, outBase)]);
    if (wh.exitCode !== 0) throw new Error(`whisper failed: ${wh.stderr.slice(-500)}`);

    return parseWhisperJson(readFileSync(`${outBase}.json`, "utf8"));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
