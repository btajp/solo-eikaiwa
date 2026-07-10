import { beginPlaybackRequest, isPlaybackRequestCurrent, playBlobForRequest, stopPlayback } from "../audio";
import { ttsFetch } from "./converse";
import { fetchModelTalk } from "./coach";

/**
 * テキスト単位のTTS Blobキャッシュ再生。初回押下時のみ /api/tts を叩き（サーバ側にも
 * テキスト単位のキャッシュがある）、以降はタブ内キャッシュから即再生。
 * in-flight Promise を共有し、失敗時はエントリを消して再試行可能にする（prepPackCache と同じパターン）。
 */
export const TTS_BLOB_CACHE_MAX_ENTRIES = 64;
export const MODEL_TALK_CACHE_MAX_ENTRIES = 16;

class PromiseLru<K, V> {
  private readonly map = new Map<K, Promise<V>>();

  constructor(private readonly maxEntries: number) {}

  get(key: K): Promise<V> | undefined {
    const value = this.map.get(key);
    if (!value) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: Promise<V>): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  deleteIfSame(key: K, value: Promise<V>): void {
    if (this.map.get(key) === value) this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

const ttsBlobCache = new PromiseLru<string, Blob>(TTS_BLOB_CACHE_MAX_ENTRIES);
const modelTalkCache = new PromiseLru<string, { text: string; blob: Blob }>(MODEL_TALK_CACHE_MAX_ENTRIES);
let cacheEpoch = 0;

function cached<K, V>(cache: PromiseLru<K, V>, key: K, factory: () => Promise<V>): Promise<V> {
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = factory();
  cache.set(key, promise);
  void promise.catch(() => cache.deleteIfSame(key, promise));
  return promise;
}

function assertCurrentEpoch(epoch: number): void {
  if (epoch !== cacheEpoch) throw new Error("TTS cache invalidated during fetch");
}

function cachedTtsBlob(text: string): Promise<Blob> {
  return cached(ttsBlobCache, text, async () => {
    const epoch = cacheEpoch;
    const blob = await ttsFetch(text);
    assertCurrentEpoch(epoch);
    return blob;
  });
}

/** 設定変更時に全音声cacheと進行中/取得待ち再生を無効化する。 */
export function invalidateTtsCaches(): void {
  cacheEpoch++;
  ttsBlobCache.clear();
  modelTalkCache.clear();
  stopPlayback();
}

export function ttsCacheStats(): { ttsEntries: number; modelTalkEntries: number } {
  return { ttsEntries: ttsBlobCache.size, modelTalkEntries: modelTalkCache.size };
}

export async function playTtsCached(text: string): Promise<void> {
  const generation = beginPlaybackRequest();
  const blob = await cachedTtsBlob(text);
  if (!isPlaybackRequestCurrent(generation)) return;
  await playBlobForRequest(blob, generation);
}

/**
 * ttsBlobCache を温めるだけの先読み（再生はしない）。次段落の音声を現在の再生中に用意しておき、
 * 段落間の無音ギャップを縮めるために使う。失敗は握りつぶす（本再生時に playTtsCached が再試行する）。
 */
export function prefetchTts(text: string): Promise<void> {
  const p = cachedTtsBlob(text);
  // 呼び出し側は fire-and-forget でき、テストや準備処理は完了を待てる。
  return p.then(() => undefined, () => undefined);
}

/**
 * モデルトーク（原稿テキスト→TTS Blob）の先読みキャッシュ。準備フェーズ表示時に呼び、
 * 「モデルトークを聞く」押下時には出来上がっている状態を狙う。onStage は初回生成時のみ発火する。
 */
export function prefetchModelTalkAudio(
  topicId: string,
  onStage?: (stage: "script" | "audio") => void,
): Promise<{ text: string; blob: Blob }> {
  return cached(modelTalkCache, topicId, async () => {
    const epoch = cacheEpoch;
    onStage?.("script");
    const text = await fetchModelTalk(topicId);
    onStage?.("audio");
    const blob = await ttsFetch(text);
    assertCurrentEpoch(epoch);
    return { text, blob };
  });
}
