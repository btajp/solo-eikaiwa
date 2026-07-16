import { resolveSttOutcome } from "../stt-result";

/** 録音後の会話パイプライン。失敗時にも、再試行に必要な中間結果を明示的に保持する。 */
export type ConversationPipelinePhase =
  | "idle"
  | "transcribing"
  | "stt-retry"
  | "thinking"
  | "reply-retry"
  | "synthesizing"
  | "speaking"
  | "audio-retry";

export type ConversationPipelineFailure = "stt-empty" | "stt" | "reply" | "audio";

export type ConversationPipelineState = {
  phase: ConversationPipelinePhase;
  failure: ConversationPipelineFailure | null;
  error: unknown | null;
  recording: Blob | null;
  userText: string | null;
  replyText: string | null;
  audioBlob: Blob | null;
};

export type ConversationReply = { replyText: string; sessionId: string };

export type FreeTalkPipelineOptions = {
  transcribe: (recording: Blob) => Promise<string>;
  /** signal は cancel()/reset()/操作の乗り換え時に abort される（切断後もサーバ側LLM実行が続くのを防ぐ・#189） */
  requestReply: (userText: string, sessionId?: string, signal?: AbortSignal) => Promise<ConversationReply>;
  createAudio: (text: string) => Promise<Blob>;
  playAudio: (audio: Blob) => Promise<unknown>;
  onUser?: (text: string) => void;
  onReply?: (text: string, sessionId: string) => void;
  onState?: (state: ConversationPipelineState) => void;
};

export function initialConversationPipelineState(): ConversationPipelineState {
  return {
    phase: "idle", failure: null, error: null,
    recording: null, userText: null, replyText: null, audioBlob: null,
  };
}

/**
 * 録音済みBlob → STT → 会話 → TTS → 再生を管理する。
 * retryは失敗フェーズだけを再実行し、user/AI turnの確定イベントを重複発火しない。
 */
export class FreeTalkPipeline {
  private operation = 0;
  private conversationSessionId: string | undefined;
  private currentState = initialConversationPipelineState();
  /** 進行中の会話要求（requestReply）を中断するためのAbortController（#189） */
  private replyAbort: AbortController | null = null;

  constructor(private readonly options: FreeTalkPipelineOptions) {}

  get state(): ConversationPipelineState {
    return this.currentState;
  }

  /** 進行中の要求を無効化して次の操作番号を発番する。遅延応答の破棄と同時に転送中のfetchも中断する。 */
  private nextOperation(): number {
    this.replyAbort?.abort();
    this.replyAbort = null;
    return ++this.operation;
  }

  async submitRecording(recording: Blob): Promise<void> {
    if (this.currentState.phase !== "idle") return;
    const operation = this.nextOperation();
    await this.transcribe(recording, operation);
  }

  async retry(): Promise<void> {
    const { phase, recording, userText, replyText, audioBlob } = this.currentState;
    if (phase === "stt-retry" && recording) {
      const operation = this.nextOperation();
      await this.transcribe(recording, operation);
      return;
    }
    if (phase === "reply-retry" && userText) {
      const operation = this.nextOperation();
      await this.requestReply(userText, operation);
      return;
    }
    if (phase === "audio-retry" && replyText) {
      const operation = this.nextOperation();
      await this.playReply(replyText, audioBlob, operation);
    }
  }

  /** STT失敗の録り直し等で中間結果を破棄する。会話session自体は既存turnのため保持する。 */
  reset(): void {
    this.nextOperation();
    this.setState(initialConversationPipelineState());
  }

  /** unmount時に遅延した応答を無効化し、進行中の会話要求も中断する。UIへの通知はしない。 */
  cancel(): void {
    this.nextOperation();
  }

  private isCurrent(operation: number): boolean {
    return this.operation === operation;
  }

  private setState(state: ConversationPipelineState): void {
    this.currentState = state;
    this.options.onState?.(state);
  }

  private async transcribe(recording: Blob, operation: number): Promise<void> {
    this.setState({
      phase: "transcribing", failure: null, error: null,
      recording, userText: null, replyText: null, audioBlob: null,
    });
    const outcome = await resolveSttOutcome(() => this.options.transcribe(recording));
    if (!this.isCurrent(operation)) return;
    if (outcome.kind === "empty") {
      this.setState({
        phase: "stt-retry", failure: "stt-empty", error: null,
        recording, userText: null, replyText: null, audioBlob: null,
      });
      return;
    }
    if (outcome.kind === "error") {
      this.setState({
        phase: "stt-retry", failure: "stt", error: outcome.error,
        recording, userText: null, replyText: null, audioBlob: null,
      });
      return;
    }

    this.setState({
      phase: "thinking", failure: null, error: null,
      recording: null, userText: outcome.text, replyText: null, audioBlob: null,
    });
    this.options.onUser?.(outcome.text);
    await this.requestReply(outcome.text, operation);
  }

  private async requestReply(userText: string, operation: number): Promise<void> {
    this.setState({
      phase: "thinking", failure: null, error: null,
      recording: null, userText, replyText: null, audioBlob: null,
    });
    const abort = new AbortController();
    this.replyAbort = abort;
    try {
      const reply = await this.options.requestReply(userText, this.conversationSessionId, abort.signal);
      if (this.replyAbort === abort) this.replyAbort = null;
      if (!this.isCurrent(operation)) return;
      this.conversationSessionId = reply.sessionId;
      this.setState({
        phase: "synthesizing", failure: null, error: null,
        recording: null, userText, replyText: reply.replyText, audioBlob: null,
      });
      this.options.onReply?.(reply.replyText, reply.sessionId);
      await this.playReply(reply.replyText, null, operation);
    } catch (error) {
      if (this.replyAbort === abort) this.replyAbort = null;
      if (!this.isCurrent(operation)) return;
      this.setState({
        phase: "reply-retry", failure: "reply", error,
        recording: null, userText, replyText: null, audioBlob: null,
      });
    }
  }

  private async playReply(replyText: string, cachedAudio: Blob | null, operation: number): Promise<void> {
    let audio = cachedAudio;
    if (!audio) {
      this.setState({
        phase: "synthesizing", failure: null, error: null,
        recording: null, userText: this.currentState.userText, replyText, audioBlob: null,
      });
      try {
        audio = await this.options.createAudio(replyText);
      } catch (error) {
        if (!this.isCurrent(operation)) return;
        this.setState({
          phase: "audio-retry", failure: "audio", error,
          recording: null, userText: this.currentState.userText, replyText, audioBlob: null,
        });
        return;
      }
    }
    if (!this.isCurrent(operation)) return;
    this.setState({
      phase: "speaking", failure: null, error: null,
      recording: null, userText: this.currentState.userText, replyText, audioBlob: audio,
    });
    try {
      await this.options.playAudio(audio);
      if (!this.isCurrent(operation)) return;
      this.setState(initialConversationPipelineState());
    } catch (error) {
      if (!this.isCurrent(operation)) return;
      this.setState({
        phase: "audio-retry", failure: "audio", error,
        recording: null, userText: this.currentState.userText, replyText, audioBlob: audio,
      });
    }
  }
}
