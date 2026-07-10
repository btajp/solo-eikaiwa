import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { open as fsOpen, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { MODELS_DIR } from "./paths";

/**
 * Whisper モデルの配布元・sha256（Tauri Phase 2 Task 4）。
 * ソース: https://huggingface.co/api/models/ggerganov/whisper.cpp/tree/main?recursive=false（2026-07-09 取得）。
 * `lfs.oid` は Git LFS の oid（LFS 仕様上、常に対象ファイル本体の sha256 hex）。実ダウンロードURL
 * （resolve/main/<file>、Range対応・206確認済み）への実リクエストでも `etag`/`x-linked-etag` が同一値である
 * ことを確認済み。`sizeBytes` は同レスポンスの `lfs.size`（バイト厳密値）。
 */
export type WhisperModelId = "large-v3-turbo" | "small";
export const WHISPER_MODEL_IDS: readonly WhisperModelId[] = ["large-v3-turbo", "small"];

export type ModelRegistryEntry = {
  id: WhisperModelId;
  filename: string;
  url: string;
  sizeBytes: number;
  sha256: string;
};

export const WHISPER_MODEL_REGISTRY: Record<WhisperModelId, ModelRegistryEntry> = {
  "large-v3-turbo": {
    id: "large-v3-turbo",
    filename: "ggml-large-v3-turbo.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
    sizeBytes: 1_624_555_275,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
  },
  small: {
    id: "small",
    filename: "ggml-small.bin",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    sizeBytes: 487_601_967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  },
};

/**
 * 空き容量チェックの安全係数。ダウンロード自体は `.part` 1本分（≒モデルサイズ）しか消費しないが、
 * 他プロセスの並行書き込みやファイルシステムの実効容量ブレに対する余裕を持たせる。
 */
const MIN_FREE_MULTIPLIER = 1.2;

export type DownloadStatus = "idle" | "downloading" | "verifying" | "done" | "error";

export type DownloadState = {
  status: DownloadStatus;
  model: WhisperModelId | null;
  receivedBytes: number;
  totalBytes: number;
  error: string | null;
  /** true: 次回 start() で続きから再開できる（.part が残っている）。false: 次は最初からになる。 */
  resumable: boolean;
};

const IDLE_STATE: DownloadState = {
  status: "idle", model: null, receivedBytes: 0, totalBytes: 0, error: null, resumable: false,
};

export type StartResult =
  | { ok: true; done: Promise<void> }
  | { ok: false; status: 400 | 409 | 507; error: string };

export type ModelDownloadManager = {
  getState: () => DownloadState;
  /** 同期関数: ディスク空き容量・同時実行チェックは全て同期I/Oのため即座に成否が確定する。
   * 成功時は本体ダウンロードを fire-and-forget で開始し、完了待ち用の Promise を添えて返す
   * （ルート側は await しない＝ポーリング設計。テストは result.done を await して完了を待てる）。 */
  start: (model: WhisperModelId) => StartResult;
  cancel: () => void;
  diskFreeBytes: () => number;
  installedModels: () => Record<WhisperModelId, boolean>;
};

/** statfs ベースの空き容量取得。node:fs.statfsSync は macOS/Linux 双方・Bun ランタイムで動作確認済み。 */
export function defaultFreeBytes(dir: string): number {
  const s = statfsSync(dir);
  return s.bsize * s.bavail;
}

/** 実行中のダウンロード1件の識別子。cancel() 後や新しい start() 後に、古い非同期処理が
 * 共有 state を誤って上書きしないためのガードに使う（`handle === current` で判定）。 */
type RunHandle = { controller: AbortController; cancelled: boolean };

class DownloadSizeExceededError extends Error {
  constructor(received: number, expected: number) {
    super(`download exceeds expected size: received ${received} bytes, limit ${expected} bytes`);
    this.name = "DownloadSizeExceededError";
  }
}

export function createModelDownloadManager(opts: {
  modelsDir?: string;
  registry?: Record<WhisperModelId, ModelRegistryEntry>;
  fetchFn?: typeof fetch;
  freeBytesFn?: (dir: string) => number;
} = {}): ModelDownloadManager {
  const modelsDir = opts.modelsDir ?? MODELS_DIR;
  const registry = opts.registry ?? WHISPER_MODEL_REGISTRY;
  const fetchFn = opts.fetchFn ?? fetch;
  const freeBytesFn = opts.freeBytesFn ?? defaultFreeBytes;

  let state: DownloadState = { ...IDLE_STATE };
  let current: RunHandle | null = null;

  function partPathOf(entry: ModelRegistryEntry): string {
    return path.join(modelsDir, `${entry.filename}.part`);
  }
  function finalPathOf(entry: ModelRegistryEntry): string {
    return path.join(modelsDir, entry.filename);
  }

  function start(model: WhisperModelId): StartResult {
    const entry = registry[model];
    if (!entry) return { ok: false, status: 400, error: `unknown model: ${model}` };
    if (state.status === "downloading" || state.status === "verifying") {
      return { ok: false, status: 409, error: "a whisper model download is already in progress" };
    }

    mkdirSync(modelsDir, { recursive: true });
    const partPath = partPathOf(entry);
    let existingBytes = existsSync(partPath) ? statSync(partPath).size : 0;
    if (existingBytes > entry.sizeBytes) {
      rmSync(partPath, { force: true });
      existingBytes = 0; // 破損/別モデルの残骸は保持せず最初からやり直す
    }

    // 空き容量は「これから新規に書く分」だけで見積もる（既存.partの分は既に消費済みで追加不要）。
    const remainingBytes = entry.sizeBytes - existingBytes;
    const required = Math.ceil(remainingBytes * MIN_FREE_MULTIPLIER);
    const free = freeBytesFn(modelsDir);
    if (free < required) {
      return {
        ok: false, status: 507,
        error: `insufficient disk space for ${model}: need ~${required} bytes free (have ${free})`,
      };
    }

    const handle: RunHandle = { controller: new AbortController(), cancelled: false };
    current = handle;
    state = {
      // .partが既に全バイト受信済み（verify中のcancelや途中終了後の再startで起こりうる）なら、
      // 再ダウンロードせず検証から再開する。これをしないと Range: bytes=<sizeBytes>- を実サーバへ
      // 送ることになり、416 Range Not Satisfiable → error → 次のstart()でも同じ416、という
      // 抜け出せないループになる（実HuggingFace CDNで再現確認済み）。
      status: remainingBytes === 0 ? "verifying" : "downloading",
      model, receivedBytes: existingBytes, totalBytes: entry.sizeBytes,
      error: null, resumable: true,
    };
    const done = (
      remainingBytes === 0 ? verifyAndFinish(entry, partPath, handle) : runDownload(entry, partPath, existingBytes, handle)
    ).catch(() => { /* 結果は state 側に反映済み */ });
    return { ok: true, done };
  }

  function cancel(): void {
    if (!current) return;
    current.cancelled = true;
    current.controller.abort();
    current = null;
    state = { ...IDLE_STATE };
  }

  async function runDownload(
    entry: ModelRegistryEntry, partPath: string, existingBytes: number, handle: RunHandle,
  ): Promise<void> {
    let fh: FileHandle | null = null;
    let received = existingBytes;
    let discardPartial = false;
    try {
      const headers: Record<string, string> = {};
      if (existingBytes > 0) headers.Range = `bytes=${existingBytes}-`;
      const res = await fetchFn(entry.url, { headers, signal: handle.controller.signal });
      if (handle.cancelled) return;

      // 防御: start()側の事前分岐（.part=sizeBytesなら検証直行）が効いていれば通常はここに来ないが、
      // レジストリのsizeBytesが実サーバの実サイズとズレている等の理由で Range 開始位置が既にリソース末尾
      // 以降になっていた場合、実サーバ（HuggingFace CDN含む）は416 Range Not Satisfiableを返す。416を
      // 「これ以上受信すべきものは無い」の裏付けとして扱い、再ダウンロードはせず検証へ回す
      // （中身が実際には不完全なら、検証のchecksum不一致経路が.partを削除して抜け出せない416ループを断つ）。
      if (res.status === 416 && existingBytes > 0) {
        const actualSize = existsSync(partPath) ? statSync(partPath).size : existingBytes;
        if (handle === current) state = { ...state, receivedBytes: actualSize };
        return verifyAndFinish(entry, partPath, handle);
      }
      if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);

      const resumed = res.status === 206;
      if (existingBytes > 0 && !resumed) received = 0; // サーバがRangeを無視 → 最初から書き直す
      if (handle === current) state = { ...state, receivedBytes: received };

      if (!res.body) throw new Error("download failed: empty response body");
      const maxResponseBytes = resumed ? entry.sizeBytes - existingBytes : entry.sizeBytes;
      const declaredLength = res.headers.get("content-length");
      if (declaredLength !== null) {
        if (!/^\d+$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength))) {
          throw new Error(`download failed: invalid Content-Length ${declaredLength}`);
        }
        if (Number(declaredLength) > maxResponseBytes) {
          discardPartial = true;
          handle.controller.abort();
          try { await res.body.cancel("response exceeds expected size"); } catch { /* 元のsize errorを優先 */ }
          throw new DownloadSizeExceededError(received + Number(declaredLength), entry.sizeBytes);
        }
      }
      fh = await fsOpen(partPath, resumed ? "a" : "w");
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (handle.cancelled) return;
        if (done) break;
        if (received + value.length > entry.sizeBytes) {
          discardPartial = true;
          handle.controller.abort();
          try { await reader.cancel("response exceeds expected size"); } catch { /* 元のsize errorを優先 */ }
          throw new DownloadSizeExceededError(received + value.length, entry.sizeBytes);
        }
        await fh.write(value);
        received += value.length;
        if (handle === current) state = { ...state, receivedBytes: received };
      }
      if (handle.cancelled) return;
      await fh.close();
      fh = null;

      if (received !== entry.sizeBytes) {
        throw new Error(`download incomplete: received ${received} of ${entry.sizeBytes} bytes`);
      }

      await verifyAndFinish(entry, partPath, handle);
    } catch (err) {
      if (handle.cancelled) return;
      if (discardPartial) {
        try { await fh?.close(); } catch { /* 破棄を継続 */ }
        fh = null;
        rmSync(partPath, { force: true });
        received = 0;
      }
      if (handle === current) {
        state = {
          status: "error", model: entry.id, receivedBytes: received, totalBytes: entry.sizeBytes,
          error: err instanceof Error ? err.message : String(err), resumable: !discardPartial,
        };
        current = null;
      }
    } finally {
      try { await fh?.close(); } catch { /* 既にcloseされている場合は無視 */ }
    }
  }

  /** ダウンロード済み（.partが全バイト揃っている）ファイルの検証→原子rename、または不一致時の破棄。
   * start()の直行分岐とrunDownloadの416防御分岐の両方から呼ばれる共通の末尾処理。 */
  async function verifyAndFinish(entry: ModelRegistryEntry, partPath: string, handle: RunHandle): Promise<void> {
    try {
      if (handle === current) state = { ...state, status: "verifying" };
      const digest = await sha256File(partPath, handle);
      if (handle.cancelled) return;

      if (digest === entry.sha256) {
        renameSync(partPath, finalPathOf(entry));
        if (handle === current) {
          state = {
            status: "done", model: entry.id, receivedBytes: entry.sizeBytes, totalBytes: entry.sizeBytes,
            error: null, resumable: false,
          };
          current = null;
        }
      } else {
        rmSync(partPath, { force: true });
        if (handle === current) {
          state = {
            status: "error", model: entry.id, receivedBytes: 0, totalBytes: entry.sizeBytes,
            error: `checksum mismatch for ${entry.filename} — please retry`, resumable: false,
          };
          current = null;
        }
      }
    } catch (err) {
      if (handle.cancelled) return;
      if (handle === current) {
        state = {
          status: "error", model: entry.id, receivedBytes: entry.sizeBytes, totalBytes: entry.sizeBytes,
          error: err instanceof Error ? err.message : String(err), resumable: true,
        };
        current = null;
      }
    }
  }

  async function sha256File(filePath: string, handle: RunHandle): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) {
      if (handle.cancelled) return "";
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }

  return {
    getState: () => ({ ...state }),
    start,
    cancel,
    diskFreeBytes: () => freeBytesFn(modelsDir),
    installedModels: () => {
      const out = {} as Record<WhisperModelId, boolean>;
      for (const id of WHISPER_MODEL_IDS) out[id] = existsSync(finalPathOf(registry[id]));
      return out;
    },
  };
}

/** 本番配線用の既定インスタンス（index.ts が RouteDeps に配線）。 */
export const modelDownloadManager = createModelDownloadManager();
