export class Recorder {
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];

  async start(): Promise<void> {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
    this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.start();
  }

  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const mr = this.mediaRecorder;
      if (!mr) return reject(new Error("not recording"));
      mr.onstop = () => {
        mr.stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(this.chunks, { type: "audio/webm" }));
      };
      mr.stop();
    });
  }

  /**
   * 画面離脱時などにマイクを即座に解放するための中断処理。録音中でなければ何もしない。
   * blob を resolve/reject せずに MediaRecorder とストリームトラックを止めるだけなので、
   * いつ呼んでも安全（冪等）。stop() のPromiseに結びついたハンドラは呼ばれないよう外す。
   */
  cancel(): void {
    const mr = this.mediaRecorder;
    if (!mr || mr.state === "inactive") return;
    mr.onstop = null;
    mr.ondataavailable = null;
    const stream = mr.stream;
    mr.stop();
    stream.getTracks().forEach((t) => t.stop());
  }
}

let currentAudio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

export async function playBlob(blob: Blob): Promise<void> {
  stopPlayback();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  currentAudio = audio;
  currentUrl = url;
  try {
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      // デコード失敗等で onended が発火しない場合に "speaking" のまま固まらないよう、
      // reject して呼び出し側（App.tsxの既存catch）にエラーを伝搬させ復帰させる
      audio.onerror = () => reject(new Error("audio playback failed"));
      audio.play().catch((err) => reject(err instanceof Error ? err : new Error(String(err))));
    });
  } finally {
    // 成功時・失敗時どちらでも url を解放しレジストリを掃除する（失敗時だけ登録が
    // 残って stopPlayback() が古い Audio を掴んだままになる不整合を防ぐ）
    URL.revokeObjectURL(url);
    if (currentAudio === audio) {
      currentAudio = null;
      currentUrl = null;
    }
  }
}

/**
 * 画面離脱時などに再生中の音声を即座に止めるための中断処理。再生中でなければ何もしない（冪等）。
 */
export function stopPlayback(): void {
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
  }
  if (currentUrl) URL.revokeObjectURL(currentUrl);
  currentAudio = null;
  currentUrl = null;
}
