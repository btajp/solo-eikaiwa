import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { BUNDLED_AUDIO_DIR, TTS_CACHE_DIR } from "./paths";
import { realSpawn, type SpawnFn } from "./spawn";
import { parseRemoteBaseUrl } from "./remote-endpoint";

/** 既定の OpenAI 互換エンドポイント。未設定時はここに向く（＝現行と完全同一）。 */
export const DEFAULT_TTS_BASE_URL = "https://api.openai.com/v1";
/** 既定モデル。同梱バンドルの cacheKey もこの値で生成済み（凍結・変更不可）。 */
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
/** 既定 voice。同梱バンドルの cacheKey もこの値で生成済み。 */
export const DEFAULT_TTS_VOICE = "alloy";

/** DB / UI が保持する上書き設定（各値 null = 既定に従う）。APIキーは持たない。 */
export type TtsSettings = {
  baseUrl: string | null;
  model: string | null;
  voice: string | null;
};

/**
 * TTS プロバイダの明示選択（DB/UI 由来・v0.29）。
 * - "auto": 従来の暗黙決定（鍵あり or カスタム baseUrl なら HTTP → 失敗/該当なしは say）
 * - "say": HTTP を試さず常に macOS say
 * - "openai-compat": 暗黙判定をスキップして常に HTTP を試す（失敗時の say フォールバックは維持 —
 *   「固定」は試行順の固定であり、音声が出ないより劣化再生のほうが学習体験を壊さないため）
 */
export type TtsProvider = "auto" | "say" | "openai-compat";

/** 解決済みの実効設定（synthesize が実際に使う値）。 */
export type ResolvedTtsConfig = {
  baseUrl: string;
  model: string;
  voice: string;
  apiKey?: string;
};

export type SynthesizeOpts = {
  voice?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** プロバイダの明示選択（DB/UI 由来）。省略時 "auto"（従来の暗黙決定）。 */
  provider?: TtsProvider;
  cacheDir?: string;
  /** リポジトリ同梱の読み取り専用音声（APIキーなしでも参照される） */
  bundledDir?: string;
  fetchFn?: typeof fetch;
  spawnFn?: SpawnFn;
  /** APIキー解決に使う env（省略時 Bun.env・TTS_API_KEY/OPENAI_API_KEY のみ読む）。テストで注入する。 */
  env?: Record<string, string | undefined>;
};

export function cacheKeyFor(model: string, voice: string, text: string): string {
  return createHash("sha256").update(`${model}|${voice}|${text}`).digest("hex");
}

/**
 * 実効 TTS 設定を解決する。優先順位: opts（リクエスト/DB 由来）> 既定 の2層
 * （env の TTS_BASE_URL/TTS_MODEL/TTS_VOICE フォールバックは廃止・v0.29。設定の真実は UI/DB のみ）。
 * APIキーはoptsで明示注入できる。直接呼び出し時だけenvのTTS_API_KEY、OPENAI_API_KEYへフォールバックする。
 */
export function resolveTtsConfig(
  opts: SynthesizeOpts = {},
  env: Record<string, string | undefined> = Bun.env,
): ResolvedTtsConfig {
  const pick = (o: string | undefined, d: string): string => o?.trim() || d;
  const rawKey = opts.apiKey ?? env.TTS_API_KEY ?? env.OPENAI_API_KEY;
  return {
    baseUrl: pick(opts.baseUrl, DEFAULT_TTS_BASE_URL),
    model: pick(opts.model, DEFAULT_TTS_MODEL),
    voice: pick(opts.voice, DEFAULT_TTS_VOICE),
    apiKey: rawKey?.trim() ? rawKey : undefined,
  };
}

async function synthesizeHttp(
  text: string, cfg: ResolvedTtsConfig, fetchFn: typeof fetch,
): Promise<Uint8Array> {
  const parsedBase = parseRemoteBaseUrl(cfg.baseUrl);
  if (!parsedBase.ok) throw new Error(parsedBase.error);
  const url = `${parsedBase.baseUrl}/audio/speech`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // APIキーがあるときだけ Authorization を載せる（kokoro-fastapi 等のローカルは鍵不要）。
  if (cfg.apiKey && parsedBase.credentialsAllowed) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  const res = await fetchFn(url, {
    method: "POST",
    redirect: "error",
    headers,
    body: JSON.stringify({ model: cfg.model, voice: cfg.voice, input: text, response_format: "mp3" }),
  });
  if (!res.ok) throw new Error(`TTS HTTP failed: ${res.status} ${await res.text()}`);
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
  const cfg = resolveTtsConfig(opts, opts.env ?? Bun.env);
  const cacheDir = opts.cacheDir ?? TTS_CACHE_DIR;
  const key = cacheKeyFor(cfg.model, cfg.voice, text);

  // 同梱音声（暗記例文300など）は最優先で参照する。既定 model/voice のときだけキーが一致してヒットし、
  // 非既定（ローカルTTS等）では別キーになり自然にミスして下の HTTP 層へ進む（＝アプリ全体で声を統一する）。
  // OpenAI TTS で事前生成したものなので engine は "openai" として返す
  const bundledPath = path.join(opts.bundledDir ?? BUNDLED_AUDIO_DIR, `${key}.mp3`);
  try {
    if (existsSync(bundledPath)) {
      return { audio: new Uint8Array(await Bun.file(bundledPath).arrayBuffer()), mime: "audio/mpeg", engine: "openai" };
    }
  } catch (err) {
    // バンドル読み取り失敗はベストエフォート（通常経路に続行）
    console.warn(`tts: bundled audio read failed for ${bundledPath}: ${String(err)}`);
  }

  // HTTP TTS を試すか（プロバイダ明示選択・v0.29）:
  // - "say" は常にスキップ / "openai-compat" は常に試す（失敗時の say フォールバックは下で維持）
  // - "auto"（既定）は従来の暗黙決定: APIキーがある（OpenAI 想定）か、baseUrl が既定以外に向いている
  //   （ローカル/自ホストの OpenAI 互換で鍵不要のケース）。既定 baseUrl + 鍵なしのときだけ HTTP を飛ばして say。
  const provider = opts.provider ?? "auto";
  const isCustomEndpoint = cfg.baseUrl !== DEFAULT_TTS_BASE_URL;
  const shouldTryHttp =
    provider === "say" ? false : provider === "openai-compat" ? true : Boolean(cfg.apiKey) || isCustomEndpoint;

  if (shouldTryHttp) {
    const cachePath = path.join(cacheDir, `${key}.mp3`);
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
      const audio = await synthesizeHttp(text, cfg, opts.fetchFn ?? fetch);
      try {
        await Bun.write(cachePath, audio);
      } catch (err) {
        // キャッシュ書き込みの失敗はセッションを落とさない（ベストエフォート）
        console.warn(`tts: cache write failed for ${cachePath}: ${String(err)}`);
      }
      return { audio, mime: "audio/mpeg", engine: "openai" };
    } catch (err) {
      // TTS API 障害 → macOS say にフォールバックしてセッション継続。provider="openai-compat"（固定）でも
      // フォールバックする（固定は試行順の固定）。ログに provider を含め、固定なのに say が鳴るケースを判別可能にする。
      console.warn(`tts: HTTP synthesis failed (provider=${provider}), falling back to say: ${String(err)}`);
    }
  }

  const audio = await synthesizeSay(text, opts.spawnFn ?? realSpawn);
  return { audio, mime: "audio/mpeg", engine: "say" };
}
