import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { TTS_CACHE_DIR } from "./paths";
import { realSpawn, type SpawnFn } from "./spawn";

const TTS_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "alloy";

export type SynthesizeOpts = {
  voice?: string;
  apiKey?: string;
  cacheDir?: string;
  fetchFn?: typeof fetch;
  spawnFn?: SpawnFn;
};

export function cacheKeyFor(model: string, voice: string, text: string): string {
  return createHash("sha256").update(`${model}|${voice}|${text}`).digest("hex");
}

async function synthesizeOpenAI(
  text: string, voice: string, apiKey: string, fetchFn: typeof fetch,
): Promise<Uint8Array> {
  const res = await fetchFn("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: TTS_MODEL, voice, input: text, response_format: "mp3" }),
  });
  if (!res.ok) throw new Error(`OpenAI TTS failed: ${res.status} ${await res.text()}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function synthesizeSay(text: string, spawn: SpawnFn): Promise<Uint8Array> {
  const work = mkdtempSync(path.join(tmpdir(), "say-"));
  try {
    const aiff = path.join(work, "out.aiff");
    const mp3 = path.join(work, "out.mp3");
    const textFile = path.join(work, "text.txt");
    // text は argv に直接渡さない（"-" 始まりの文字列が say のフラグとして
    // 解釈される argv injection を防ぐため、ファイル経由で渡す）
    await Bun.write(textFile, text);
    const s = await spawn(["say", "-v", "Samantha", "-o", aiff, "-f", textFile]);
    if (s.exitCode !== 0) throw new Error(`say failed: ${s.stderr}`);
    const f = await spawn(["ffmpeg", "-i", aiff, mp3, "-y"]);
    if (f.exitCode !== 0) throw new Error(`ffmpeg failed: ${f.stderr}`);
    return new Uint8Array(await Bun.file(mp3).arrayBuffer());
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export async function synthesize(
  text: string, opts: SynthesizeOpts = {},
): Promise<{ audio: Uint8Array; mime: string; engine: "openai" | "say" }> {
  const voice = opts.voice ?? DEFAULT_VOICE;
  const apiKey = opts.apiKey ?? Bun.env.OPENAI_API_KEY;
  const cacheDir = opts.cacheDir ?? TTS_CACHE_DIR;

  if (apiKey) {
    const cachePath = path.join(cacheDir, `${cacheKeyFor(TTS_MODEL, voice, text)}.mp3`);
    try {
      mkdirSync(cacheDir, { recursive: true });
      if (existsSync(cachePath)) {
        return { audio: new Uint8Array(await Bun.file(cachePath).arrayBuffer()), mime: "audio/mpeg", engine: "openai" };
      }
    } catch (err) {
      // キャッシュ用ディレクトリの準備失敗もベストエフォート扱い（合成自体は継続）
      console.warn(`tts: cache dir prep failed for ${cacheDir}: ${String(err)}`);
    }
    try {
      const audio = await synthesizeOpenAI(text, voice, apiKey, opts.fetchFn ?? fetch);
      try {
        await Bun.write(cachePath, audio);
      } catch (err) {
        // キャッシュ書き込みの失敗はセッションを落とさない（ベストエフォート）
        console.warn(`tts: cache write failed for ${cachePath}: ${String(err)}`);
      }
      return { audio, mime: "audio/mpeg", engine: "openai" };
    } catch (err) {
      // spec §4.5: TTS API 障害 → macOS say にフォールバックしてセッション継続
      console.warn(`tts: OpenAI synthesis failed, falling back to say: ${String(err)}`);
    }
  }

  const audio = await synthesizeSay(text, opts.spawnFn ?? realSpawn);
  return { audio, mime: "audio/mpeg", engine: "say" };
}
