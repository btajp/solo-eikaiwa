/**
 * Tauri（WKWebView）実行時に tauri.conf.json の `app.windows[].userAgent` で埋め込んでいるマーカー。
 * window.__TAURI__ はリモートoriginではIPCが閉じているため使えず（withGlobalTauri=falseかつ
 * サーバ側originにIPCブリッジが無い）、代わりに UA 文字列で「デスクトップシェル内で動いているか」
 * を判定する。ブラウザで通常アクセスした場合はこのマーカーを含まないため false になる。
 */
const DESKTOP_UA_MARKER = "solo-eikaiwa-desktop";

export function isDesktopContext(ua: string = navigator.userAgent): boolean {
  return ua.includes(DESKTOP_UA_MARKER);
}

/**
 * MediaRecorder の mimeType 交渉。ブラウザ（Chrome/Firefox 等）は現行どおり audio/webm 固定
 * （挙動不変）。Tauri デスクトップシェルでは ffmpeg 非同梱を見込み、macOS 標準の afconvert が
 * 扱える audio/mp4 を優先する（WKWebView は実測で audio/mp4 録音に対応済み・未対応なら webm に
 * フォールバック）。
 */
export function pickRecorderMimeType(opts: {
  isDesktop?: boolean;
  isTypeSupported?: (mimeType: string) => boolean;
} = {}): string {
  const isDesktop = opts.isDesktop ?? isDesktopContext();
  if (!isDesktop) return "audio/webm";
  const isSupported = opts.isTypeSupported
    ?? ((t: string) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
  return isSupported("audio/mp4") ? "audio/mp4" : "audio/webm";
}

export type RecorderState = "idle" | "starting" | "recording" | "stopping";

export class RecorderCancelledError extends Error {
  constructor() {
    super("recording start cancelled");
    this.name = "RecorderCancelledError";
  }
}

export type RecorderOptions = {
  getUserMedia?: () => Promise<MediaStream>;
  createMediaRecorder?: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
  pickMimeType?: () => string;
  now?: () => number;
};

export class Recorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private mimeType = "audio/webm";
  private state: RecorderState = "idle";
  private epoch = 0;
  private startedAt = 0;
  private pendingStopReject: ((reason?: unknown) => void) | null = null;
  private readonly getUserMedia: () => Promise<MediaStream>;
  private readonly createMediaRecorder: (stream: MediaStream, options: MediaRecorderOptions) => MediaRecorder;
  private readonly chooseMimeType: () => string;
  private readonly now: () => number;

  constructor(options: RecorderOptions = {}) {
    this.getUserMedia = options.getUserMedia
      ?? (() => navigator.mediaDevices.getUserMedia({ audio: true }));
    this.createMediaRecorder = options.createMediaRecorder
      ?? ((stream, mediaOptions) => new MediaRecorder(stream, mediaOptions));
    this.chooseMimeType = options.pickMimeType ?? (() => pickRecorderMimeType());
    this.now = options.now ?? (() => performance.now());
  }

  getState(): RecorderState {
    return this.state;
  }

  async start(): Promise<void> {
    if (this.state !== "idle") {
      throw new Error(`recorder busy: ${this.state}`);
    }
    this.state = "starting";
    const epoch = ++this.epoch;
    let stream: MediaStream;
    try {
      stream = await this.getUserMedia();
    } catch (error) {
      if (this.epoch === epoch && this.state === "starting") this.state = "idle";
      throw error;
    }
    if (this.epoch !== epoch || this.state !== "starting") {
      stream.getTracks().forEach((track) => track.stop());
      throw new RecorderCancelledError();
    }
    try {
      this.chunks = [];
      this.mimeType = this.chooseMimeType();
      const recorder = this.createMediaRecorder(stream, { mimeType: this.mimeType });
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0 && this.mediaRecorder === recorder) this.chunks.push(event.data);
      };
      this.mediaRecorder = recorder;
      // timeslice を渡さないため ondataavailable は stop() 時に1回だけ発火する（単一Blob録音）。
      recorder.start();
      this.startedAt = this.now();
      this.state = "recording";
    } catch (error) {
      stream.getTracks().forEach((track) => track.stop());
      this.mediaRecorder = null;
      this.state = "idle";
      throw error;
    }
  }

  async stop(): Promise<Blob> {
    return (await this.stopTimed()).blob;
  }

  stopTimed(): Promise<{ blob: Blob; durationSec: number }> {
    return new Promise((resolve, reject) => {
      const mr = this.mediaRecorder;
      if (!mr || this.state !== "recording") return reject(new Error("not recording"));
      this.state = "stopping";
      const mimeType = this.mimeType;
      const durationMs = Math.max(100, this.now() - this.startedAt);
      const durationSec = Math.round(durationMs / 100) / 10;
      this.pendingStopReject = reject;
      mr.onstop = () => {
        mr.stream.getTracks().forEach((t) => t.stop());
        if (this.mediaRecorder === mr) {
          const blob = new Blob(this.chunks, { type: mimeType });
          this.mediaRecorder = null;
          this.chunks = [];
          this.pendingStopReject = null;
          this.state = "idle";
          resolve({ blob, durationSec });
        }
      };
      try {
        mr.stop();
      } catch (error) {
        this.pendingStopReject = null;
        this.state = "recording";
        reject(error);
      }
    });
  }

  /**
   * 画面離脱時などに録音開始待ちを無効化し、取得済みのマイクを即座に解放する中断処理。
   * stop() 待ちなら RecorderCancelledError で解除し、MediaRecorder の古いhandlerは外す。
   * idleを含むどの状態から呼んでも安全（冪等）。
   */
  cancel(): void {
    this.epoch++;
    const mr = this.mediaRecorder;
    if (!mr) {
      this.state = "idle";
      this.chunks = [];
      return;
    }
    mr.onstop = null;
    mr.ondataavailable = null;
    const stream = mr.stream;
    try {
      if (mr.state !== "inactive") mr.stop();
    } catch {
      // track停止と内部状態の破棄を優先する。cancel自体はcleanupから安全に呼べる必要がある。
    }
    stream.getTracks().forEach((t) => t.stop());
    this.pendingStopReject?.(new RecorderCancelledError());
    this.pendingStopReject = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.state = "idle";
  }
}

/**
 * 再生中の Audio 要素と、その playBlob() 呼び出しを待っている Promise の resolve を
 * ひと組で保持するレジストリ。stopPlayback() が「今何を止めるべきか」だけでなく
 * 「誰が待っているか」も分かるようにし、中断時に待ち手を解放できるようにする。
 */
type Playback = { audio: HTMLAudioElement; url: string; resolve: () => void };
let current: Playback | null = null;
let playbackGeneration = 0;

function stopCurrentPlayback(): void {
  if (!current) return;
  const { audio, url, resolve } = current;
  current = null;
  audio.onended = null;
  audio.onerror = null;
  resolve();
  audio.pause();
  URL.revokeObjectURL(url);
}

/** 新しい再生要求を予約し、取得待ちを含む古い要求と現在の再生を無効化する。 */
export function beginPlaybackRequest(): number {
  playbackGeneration++;
  stopCurrentPlayback();
  return playbackGeneration;
}

export function isPlaybackRequestCurrent(generation: number): boolean {
  return generation === playbackGeneration;
}

/** Blob再生の任意オプション。playbackRate はピッチを保ったままの再生速度（例: 0.7〜1.25） */
export type PlaybackOptions = { playbackRate?: number };

/**
 * 再生中の音声があれば再生速度を即時変更する（リスニングの速度トグル用・#194）。
 * 再生中でなければ何もしない（次の再生は呼び出し側が options で指定する）。
 */
export function setCurrentPlaybackRate(rate: number): void {
  if (!current || !(rate > 0)) return;
  current.audio.preservesPitch = true;
  current.audio.playbackRate = rate;
}

/** 取得前に予約した世代がまだ最新の場合だけBlob再生を開始する。 */
export async function playBlobForRequest(blob: Blob, generation: number, options?: PlaybackOptions): Promise<void> {
  if (!isPlaybackRequestCurrent(generation)) return;
  stopCurrentPlayback();
  if (!isPlaybackRequestCurrent(generation)) return;
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  const rate = options?.playbackRate;
  if (rate !== undefined && rate > 0) {
    // 速度を変えても声の高さを保つ（現行ブラウザは既定 true だが、意図として明示する）
    audio.preservesPitch = true;
    audio.playbackRate = rate;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      current = { audio, url, resolve };
      audio.onended = () => {
        if (current?.audio !== audio) return;
        current = null;
        resolve();
      };
      // デコード失敗等で onended が発火しない場合に "speaking" のまま固まらないよう、
      // reject して呼び出し側（App.tsxの既存catch）にエラーを伝搬させ復帰させる
      audio.onerror = () => {
        if (current?.audio !== audio) return;
        current = null;
        reject(new Error("audio playback failed"));
      };
      audio.play().catch((err) => {
        if (current?.audio !== audio) return;
        current = null;
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  } finally {
    // 成功時・失敗時どちらでも url を解放しレジストリを掃除する（失敗時だけ登録が
    // 残って stopPlayback() が古い Audio を掴んだままになる不整合を防ぐ）
    URL.revokeObjectURL(url);
    if (current && current.audio === audio) {
      current = null;
    }
  }
}

/**
 * 音声が最後まで再生されたときだけ true を返す。別の音声再生や画面離脱で中断された場合は
 * 正常終了として待ち手を解放しつつ false を返すため、練習実施の記録に中断を混ぜない。
 */
export async function playBlob(blob: Blob): Promise<boolean> {
  const generation = beginPlaybackRequest();
  await playBlobForRequest(blob, generation);
  return isPlaybackRequestCurrent(generation);
}

/**
 * 画面離脱時・次の再生開始時などに再生中の音声を即座に止めるための中断処理。
 * 再生中でなくても取得待ちの要求世代を無効化する（冪等）。
 *
 * 中断された playBlob() の Promise を resolve してから pause / revoke / レジストリ
 * クリアを行う（＝最後にボタンを押した操作が勝つ「last-click-wins」を「正常終了扱い」で
 * 表現する）。resolve せずに止めるだけだと、待っている側の await が二度と戻らず、
 * finally で戻すはずの UI 状態（例: 再生中インデックス）が固まってしまう。
 */
export function stopPlayback(): void {
  playbackGeneration++;
  stopCurrentPlayback();
}
