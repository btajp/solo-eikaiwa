import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { BUNDLED_AUDIO_DIR, TTS_CACHE_DIR } from "./paths";
import { realSpawn, type SpawnFn } from "./spawn";
import { parseRemoteBaseUrl } from "./remote-endpoint";
import { OPENAI_BASE_URL } from "./openai";

/** 既定の OpenAI 互換エンドポイント。未設定時はここに向く（＝現行と完全同一）。 */
export const DEFAULT_TTS_BASE_URL = OPENAI_BASE_URL;
/** 既定モデル。同梱バンドルの cacheKey もこの値で生成済み（凍結・変更不可）。 */
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";
/** 既定 voice。同梱バンドルの cacheKey もこの値で生成済み。 */
export const DEFAULT_TTS_VOICE = "alloy";
export const DEFAULT_TTS_TIMEOUT_MS = 60_000;
/**
 * runtime HTTPキャッシュ（data/tts-cache）の既定容量上限（#207）。会話応答のような再利用されない
 * 音声も毎ターン書き込まれるため、無制限だと長期利用でGB級に増え続ける。超過分は「長く再生されて
 * いない順（mtime昇順のLRU）」に削除する。同梱バンドル（BUNDLED_AUDIO_DIR）はこの対象外。
 */
export const DEFAULT_TTS_CACHE_MAX_BYTES = 256 * 1024 * 1024;
const HTTP_CACHE_SCHEMA_VERSION = 2;
const HTTP_RESPONSE_FORMAT = "mp3";
const cleanedCacheDirs = new Set<string>();

/** DB / UI が保持する上書き設定（各値 null = 既定に従う）。APIキーは持たない。 */
export type TtsSettings = {
  baseUrl: string | null;
  model: string | null;
  voice: string | null;
  /** OpenAI 公式用設定。旧呼び出し元との後方互換のため省略時は null 扱い。 */
  openaiModel?: string | null;
  openaiVoice?: string | null;
};

/**
 * TTS プロバイダの明示選択（DB/UI 由来・v0.29）。
 * - "say": 既定ラベルの同梱音声があればそれを再生し、無いテキストは macOS say（HTTP は試さない）
 * - "openai": OpenAI 公式固定 URL を使う（既定ラベルなら同梱音声を優先）
 * - "openai-compat": 利用者指定の互換 URL を使う（同梱音声へ短絡しない）
 */
export type TtsProvider = "say" | "openai" | "openai-compat";

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
  /** プロバイダの明示選択（DB/UI 由来）。省略は内部呼び出しの後方互換時だけ許可する。 */
  provider?: TtsProvider;
  cacheDir?: string;
  /** 同梱音声生成CLIだけが凍結済みlegacy keyへ書く。通常実行は接続分離済みruntime key。 */
  cacheTarget?: "runtime" | "bundled";
  /** リポジトリ同梱の読み取り専用音声（APIキーなしでも参照される） */
  bundledDir?: string;
  fetchFn?: typeof fetch;
  spawnFn?: SpawnFn;
  signal?: AbortSignal;
  /** 合成全体の処理時間。省略providerの後方互換経路ではHTTP→sayも同じ期限に含む。 */
  timeoutMs?: number;
  /** say一時ディレクトリの親。テスト用 seam。 */
  tempRoot?: string;
  /** cacheの障害注入 seam。通常はBun.write/renameSync。 */
  cacheWriteFn?: (filePath: string, audio: Uint8Array) => Promise<unknown>;
  cacheRenameFn?: (from: string, to: string) => void;
  /** APIキー解決に使う env（省略時 Bun.env・TTS_API_KEY/OPENAI_API_KEY のみ読む）。テストで注入する。 */
  env?: Record<string, string | undefined>;
  /** runtime HTTPキャッシュの容量上限（バイト・省略時 DEFAULT_TTS_CACHE_MAX_BYTES）。テスト用 seam。 */
  cacheMaxBytes?: number;
};

export function cacheKeyFor(model: string, voice: string, text: string): string {
  return createHash("sha256").update(`${model}|${voice}|${text}`).digest("hex");
}

/** HTTP生成cache専用。凍結済みの同梱音声キーとは分け、接続・schema・生成形式も識別する。 */
export function httpCacheKeyFor(
  provider: TtsProvider,
  cfg: Pick<ResolvedTtsConfig, "baseUrl" | "model" | "voice">,
  text: string,
): string {
  const parsed = parseRemoteBaseUrl(cfg.baseUrl);
  const baseUrl = parsed.ok ? parsed.baseUrl : cfg.baseUrl.trim();
  const origin = parsed.ok ? parsed.origin : "invalid";
  return createHash("sha256").update(JSON.stringify({
    schema: HTTP_CACHE_SCHEMA_VERSION,
    provider,
    origin,
    baseUrl,
    model: cfg.model,
    voice: cfg.voice,
    responseFormat: HTTP_RESPONSE_FORMAT,
    text,
  })).digest("hex");
}

export class TtsTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`TTS timed out after ${timeoutMs}ms`);
    this.name = "TtsTimeoutError";
  }
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("TTS cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

function makeDeadlineSignal(parent: AbortSignal | undefined, requestedMs: number | undefined) {
  const timeoutMs = requestedMs !== undefined && Number.isFinite(requestedMs)
    ? Math.max(0, Math.floor(requestedMs))
    : DEFAULT_TTS_TIMEOUT_MS;
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(abortReason(parent!));
  parent?.addEventListener("abort", onParentAbort, { once: true });
  if (parent?.aborted) controller.abort(abortReason(parent));
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!controller.signal.aborted) {
    if (timeoutMs === 0) controller.abort(new TtsTimeoutError(timeoutMs));
    else timer = setTimeout(() => controller.abort(new TtsTimeoutError(timeoutMs)), timeoutMs);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
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
  text: string, cfg: ResolvedTtsConfig, fetchFn: typeof fetch, signal: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const parsedBase = parseRemoteBaseUrl(cfg.baseUrl);
  if (!parsedBase.ok) throw new Error(parsedBase.error);
  const url = `${parsedBase.baseUrl}/audio/speech`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // APIキーがあるときだけ Authorization を載せる（kokoro-fastapi 等のローカルは鍵不要）。
  if (cfg.apiKey && parsedBase.credentialsAllowed) headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  const res = await fetchFn(url, {
    method: "POST",
    redirect: "error",
    signal,
    headers,
    body: JSON.stringify({
      model: cfg.model, voice: cfg.voice, input: text, response_format: HTTP_RESPONSE_FORMAT,
    }),
  });
  if (!res.ok) throw new Error(`TTS HTTP failed: ${res.status} ${await res.text()}`);
  const audio = new Uint8Array(await res.arrayBuffer());
  throwIfAborted(signal);
  if (audio.length === 0) throw new Error("TTS HTTP returned empty audio");
  return audio;
}

async function synthesizeSay(
  text: string, spawn: SpawnFn, signal: AbortSignal, tempRoot = tmpdir(),
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const work = mkdtempSync(path.join(tempRoot, "say-"));
  try {
    const m4a = path.join(work, "out.m4a");
    const textFile = path.join(work, "text.txt");
    // text は argv に直接渡さない（"-" 始まりの文字列が say のフラグとして
    // 解釈される argv injection を防ぐため、ファイル経由で渡す）
    await Bun.write(textFile, text);
    throwIfAborted(signal);
    // macOS標準sayからブラウザ再生可能なAAC/M4Aを直接生成し、外部ffmpegへ依存しない。
    const s = await spawn(
      ["say", "-v", "Samantha", "-o", m4a, "--data-format=aac", "-f", textFile],
      { signal },
    );
    if (s.exitCode !== 0) throw new Error(`say failed: ${s.stderr}`);
    throwIfAborted(signal);
    const audio = new Uint8Array(await Bun.file(m4a).arrayBuffer());
    if (audio.length === 0) throw new Error("say returned empty audio");
    return audio;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function cleanupStaleCacheTemps(cacheDir: string): void {
  if (cleanedCacheDirs.has(cacheDir)) return;
  for (const name of readdirSync(cacheDir)) {
    if (!name.includes(".mp3.tmp-")) continue;
    rmSync(path.join(cacheDir, name), { force: true });
  }
  cleanedCacheDirs.add(cacheDir);
}

/**
 * runtime HTTPキャッシュのLRUエビクション（#207）。書き込み後に総容量が上限を超えていたら、
 * mtimeの古い順（=長く再生されていない順。キャッシュヒット時にmtimeを更新している）に削除する。
 * 直前に書いたエントリ（keepPath）は削除対象から除外し、返却直後の再再生を守る。
 * 削除はベストエフォート: 失敗しても合成結果には影響させない。
 */
function evictHttpCacheOverLimit(cacheDir: string, maxBytes: number, keepPath: string): void {
  try {
    const entries: { path: string; size: number; mtimeMs: number }[] = [];
    let total = 0;
    for (const name of readdirSync(cacheDir)) {
      if (!name.endsWith(".mp3")) continue; // .tmp-* 残骸は起動時掃除（cleanupStaleCacheTemps）の担当
      const filePath = path.join(cacheDir, name);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        total += stat.size;
        entries.push({ path: filePath, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        continue; // 並行削除等で消えた場合は対象外として続行
      }
    }
    if (total <= maxBytes) return;
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of entries) {
      if (total <= maxBytes) break;
      if (entry.path === keepPath) continue;
      rmSync(entry.path, { force: true });
      total -= entry.size;
    }
  } catch (err) {
    console.warn(`tts: cache eviction failed for ${cacheDir}: ${String(err)}`);
  }
}

async function writeCacheAtomic(
  cachePath: string, audio: Uint8Array, opts: SynthesizeOpts, signal: AbortSignal,
): Promise<void> {
  const tempPath = `${cachePath}.tmp-${process.pid}-${randomUUID()}`;
  const write = opts.cacheWriteFn ?? ((filePath: string, bytes: Uint8Array) => Bun.write(filePath, bytes));
  const rename = opts.cacheRenameFn ?? renameSync;
  try {
    throwIfAborted(signal);
    await write(tempPath, audio);
    throwIfAborted(signal);
    rename(tempPath, cachePath);
  } finally {
    try {
      rmSync(tempPath, { force: true });
    } catch {
      // cacheDir自体が壊れている場合も、合成本体の結果または元の書き込みエラーを優先する。
    }
  }
}

export async function synthesize(
  text: string, opts: SynthesizeOpts = {},
): Promise<{ audio: Uint8Array; mime: string; engine: "openai" | "say" }> {
  const deadline = makeDeadlineSignal(opts.signal, opts.timeoutMs);
  const signal = deadline.signal;
  try {
    throwIfAborted(signal);
    const cfg = resolveTtsConfig(opts, opts.env ?? Bun.env);
    const cacheDir = opts.cacheDir ?? TTS_CACHE_DIR;
    const explicitProvider = opts.provider !== undefined;
    const parsedBase = parseRemoteBaseUrl(cfg.baseUrl);
    const isDefaultEndpoint = parsedBase.ok && parsedBase.baseUrl === DEFAULT_TTS_BASE_URL;
    const provider: TtsProvider = opts.provider
      ?? (isDefaultEndpoint ? (cfg.apiKey ? "openai" : "say") : "openai-compat");
    const bundledKey = cacheKeyFor(cfg.model, cfg.voice, text);

    // 同梱音声は凍結済み旧キーを維持し、既定接続・既定model/voiceでのみ参照する。
    // say（キーなしの既定解決を含む）とOpenAI公式は同梱を優先し、同梱に無いテキストだけを
    // それぞれのエンジンで合成する（キーなしでも同梱672本のネイティブ品質を維持する契約）。
    // custom endpoint（openai-compat）が同じラベルを使っても、別providerの音声へ短絡しない。
    const canUseBundled = (provider === "openai" || provider === "say" || !explicitProvider)
      && isDefaultEndpoint
      && cfg.model === DEFAULT_TTS_MODEL
      && cfg.voice === DEFAULT_TTS_VOICE;
    const bundledPath = path.join(opts.bundledDir ?? BUNDLED_AUDIO_DIR, `${bundledKey}.mp3`);
    try {
      if (canUseBundled && existsSync(bundledPath)) {
        const audio = new Uint8Array(await Bun.file(bundledPath).arrayBuffer());
        throwIfAborted(signal);
        if (audio.length > 0) return { audio, mime: "audio/mpeg", engine: "openai" };
      }
    } catch (err) {
      if (signal.aborted) throw abortReason(signal);
      console.warn(`tts: bundled audio read failed for ${bundledPath}: ${String(err)}`);
    }

    const shouldTryHttp = provider === "openai" || provider === "openai-compat";

    if (shouldTryHttp) {
      if (opts.cacheTarget === "bundled" && !canUseBundled) {
        throw new Error("bundled TTS cache requires the default OpenAI endpoint, model, and voice");
      }
      const httpKey = opts.cacheTarget === "bundled"
        ? bundledKey
        : httpCacheKeyFor(provider, cfg, text);
      const cachePath = path.join(cacheDir, `${httpKey}.mp3`);
      try {
        mkdirSync(cacheDir, { recursive: true });
        cleanupStaleCacheTemps(cacheDir);
        if (existsSync(cachePath)) {
          const audio = new Uint8Array(await Bun.file(cachePath).arrayBuffer());
          throwIfAborted(signal);
          if (audio.length > 0) {
            try {
              // LRU: 再生されたエントリを最新扱いにして、エビクションの「長く再生されていない順」を保つ
              const now = new Date();
              utimesSync(cachePath, now, now);
            } catch {
              // mtime更新はLRU順位のためのベストエフォート。失敗しても再生には影響させない
            }
            return { audio, mime: "audio/mpeg", engine: "openai" };
          }
          rmSync(cachePath, { force: true });
        }
      } catch (err) {
        if (signal.aborted) throw abortReason(signal);
        console.warn(`tts: cache dir/read failed for ${cacheDir}: ${String(err)}`);
      }
      try {
        const audio = await synthesizeHttp(text, cfg, opts.fetchFn ?? fetch, signal);
        try {
          await writeCacheAtomic(cachePath, audio, opts, signal);
          // 同梱音声の生成CLI（cacheTarget: "bundled"）は全件保持が前提なのでエビクションしない。
          if (opts.cacheTarget !== "bundled") {
            evictHttpCacheOverLimit(cacheDir, opts.cacheMaxBytes ?? DEFAULT_TTS_CACHE_MAX_BYTES, cachePath);
          }
        } catch (err) {
          if (signal.aborted) throw abortReason(signal);
          console.warn(`tts: cache write failed for ${cachePath}: ${String(err)}`);
        }
        return { audio, mime: "audio/mpeg", engine: "openai" };
      } catch (err) {
        if (signal.aborted) throw abortReason(signal);
        if (explicitProvider) throw err;
        console.warn(`tts: HTTP synthesis failed (provider=${provider}), falling back to say: ${String(err)}`);
      }
    }

    const audio = await synthesizeSay(text, opts.spawnFn ?? realSpawn, signal, opts.tempRoot);
    return { audio, mime: "audio/mp4", engine: "say" };
  } finally {
    deadline.cleanup();
  }
}
