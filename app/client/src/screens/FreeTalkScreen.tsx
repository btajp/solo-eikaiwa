import { useEffect, useRef, useState } from "react";
import { converse, fetchPhraseHints, fetchUtteranceTranslation, sttUpload, ttsFetch, type PhraseHint } from "../api";
import { playBlob, Recorder, stopPlayback } from "../audio";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { canDiscardConversationRecording, conversationPrimaryAction, type ConversationRecordingStatus } from "../recording-controls";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { FeedbackRow } from "../ui/FeedbackRow";
import { LevelChip } from "../ui/LevelChip";
import { RecordButton } from "../ui/RecordButton";
import { canShowFreeTalkReaction } from "../practice-reaction";
import { pipelineFailureAction } from "./free-talk-error";
import { FreeTalkPipeline, initialConversationPipelineState, type ConversationPipelineState } from "./free-talk-flow";

type Turn = { role: "you" | "ai"; text: string };
type Status = ConversationRecordingStatus;

/** 会話ループ画面。scenarioId を渡すとロールプレイモードになる（M1の自由会話UIを抽出したもの） */
export function FreeTalkScreen(props: {
  activitySessionId: string; scenarioId?: string; onSessionId?: (id: string) => void;
  /** STT・LLMの準備確認。falseなら録音を開始せず、親が復旧操作を表示する。 */
  onBeforeRecord?: () => boolean;
  /** セッション内のロールプレイが、空でない発話を受け取ったことを親へ知らせる。 */
  onValidTurn?: () => void;
  lang: Lang;
}) {
  const t = STR[props.lang].freeTalkScreen;
  const page = STR[props.lang].freeTalk;
  const LABELS: Record<Status, string> = {
    idle: t.idle, starting: t.starting, recording: t.recording, transcribing: t.transcribing,
    "stt-retry": t.sttRetry, thinking: t.thinking, "reply-retry": t.replyRetry,
    synthesizing: t.synthesizing, speaking: t.speaking, "audio-retry": t.audioRetry,
  };
  const [status, setStatus] = useState<Status>("idle");
  const statusRef = useRef<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [practiceFinished, setPracticeFinished] = useState(false);
  const [recordingError, setRecordingError] = useState("");
  const [pipelineState, setPipelineState] = useState<ConversationPipelineState>(initialConversationPipelineState);
  const recorderRef = useRef(new Recorder());
  // 録音開始待ちを破棄してすぐ録り直したとき、古い開始要求が新しい状態を上書きしないための世代番号。
  const recordingGenerationRef = useRef(0);
  // stop→sttUpload→converse→ttsFetch→playBlob の対話パイプラインがアンマウント後も
  // 走り続けないようにするフラグ。await の後・setState の前（特に playBlob の前）で毎回チェックする
  const aliveRef = useRef(true);
  const latestPropsRef = useRef(props);
  latestPropsRef.current = props;
  // AI発話ごとの訳。キーは turns の index。値: undefined=未取得, "loading"=取得中, それ以外=訳文
  const [translations, setTranslations] = useState<Record<number, string>>({});
  const [hintInput, setHintInput] = useState("");
  // 言い方ヒント。null=未取得, "loading"=取得中, 配列=提案結果
  const [hints, setHints] = useState<PhraseHint[] | "loading" | null>(null);
  const [hintError, setHintError] = useState("");

  function updateStatus(next: Status) {
    statusRef.current = next;
    setStatus(next);
  }

  const pipelineRef = useRef<FreeTalkPipeline | null>(null);
  if (pipelineRef.current === null) {
    pipelineRef.current = new FreeTalkPipeline({
      transcribe: sttUpload,
      requestReply: (text, sessionId, signal) => {
        const current = latestPropsRef.current;
        return converse(text, current.activitySessionId, sessionId, current.scenarioId, signal);
      },
      createAudio: ttsFetch,
      playAudio: playBlob,
      onUser: (text) => {
        if (!aliveRef.current) return;
        setTurns((prev) => [...prev, { role: "you", text }]);
        latestPropsRef.current.onValidTurn?.();
      },
      onReply: (text, sessionId) => {
        if (!aliveRef.current) return;
        latestPropsRef.current.onSessionId?.(sessionId);
        setTurns((prev) => [...prev, { role: "ai", text }]);
      },
      onState: (next) => {
        if (!aliveRef.current) return;
        setPipelineState(next);
        updateStatus(next.phase);
      },
    });
  }

  // 録音中/再生中に画面を離脱してもマイク・音声が解放されるよう、アンマウント時に停止する
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      pipelineRef.current?.cancel();
      recorderRef.current.cancel();
      stopPlayback();
    };
  }, []);

  function isCurrentStart(generation: number): boolean {
    return recordingGenerationRef.current === generation && statusRef.current === "starting";
  }

  async function startRecording() {
    setRecordingError("");
    if (latestPropsRef.current.onBeforeRecord && !latestPropsRef.current.onBeforeRecord()) return;
    const generation = ++recordingGenerationRef.current;
    updateStatus("starting");
    try {
      await recorderRef.current.start();
      if (!aliveRef.current || !isCurrentStart(generation)) {
        if (recordingGenerationRef.current === generation) recorderRef.current.cancel();
        return;
      }
      updateStatus("recording");
    } catch (err) {
      if (!aliveRef.current || !isCurrentStart(generation)) return;
      setRecordingError(formatClientError(props.lang, err, "record"));
      updateStatus("idle");
    }
  }

  async function stopAndSubmitRecording() {
    if (statusRef.current !== "recording") return;
    setRecordingError("");
    updateStatus("transcribing");
    try {
      const blob = await recorderRef.current.stop();
      if (!aliveRef.current) return;
      void pipelineRef.current?.submitRecording(blob);
    } catch (err) {
      if (!aliveRef.current) return;
      setRecordingError(formatClientError(props.lang, err, "record"));
      updateStatus("idle");
    }
  }

  function onMainButton() {
    if (statusRef.current === "idle") void startRecording();
    else if (statusRef.current === "recording") void stopAndSubmitRecording();
  }

  function retryPipelineStage() {
    setRecordingError("");
    void pipelineRef.current?.retry();
  }

  function recordAgain() {
    if (statusRef.current !== "stt-retry") return;
    pipelineRef.current?.reset();
    void startRecording();
  }

  function discardRecording() {
    if (!canDiscardConversationRecording(statusRef.current)) return;
    recordingGenerationRef.current++;
    recorderRef.current.cancel();
    pipelineRef.current?.reset();
    setRecordingError("");
    updateStatus("idle");
  }

  function pipelineErrorMessage(): string {
    if (pipelineState.failure === null) return "";
    if (pipelineState.failure === "stt-empty") return t.notHeard;
    return formatClientError(
      props.lang,
      pipelineState.error,
      pipelineFailureAction(pipelineState.failure, pipelineState.audioBlob !== null),
    );
  }

  async function translateTurn(i: number, text: string) {
    setTranslations((m) => ({ ...m, [i]: "loading" }));
    try {
      const ja = await fetchUtteranceTranslation(text);
      if (aliveRef.current) setTranslations((m) => ({ ...m, [i]: ja }));
    } catch {
      // "loading" と同じセンチネル方式。エラー文言を訳として保存するとボタン再表示条件が永久に成立しなくなる
      if (aliveRef.current) setTranslations((m) => ({ ...m, [i]: "error" }));
    }
  }

  async function requestHints() {
    const jaText = hintInput.trim();
    if (!jaText) return;
    setHintError("");
    setHints("loading");
    try {
      const suggestions = await fetchPhraseHints(jaText, turns.slice(-6));
      if (aliveRef.current) setHints(suggestions);
    } catch {
      if (aliveRef.current) {
        setHints(null);
        setHintError(t.hintError);
      }
    }
  }

  const primaryAction = conversationPrimaryAction(status);
  const errorMsg = recordingError || pipelineErrorMessage();

  return (
    <div className={props.scenarioId === undefined ? "stack" : undefined}>
      {props.scenarioId === undefined && (
        <div className="hero">
          <h2 className="hero-title">{page.title}</h2>
          <LevelChip kind="auto" lang={props.lang} />
          <p className="hero-date">{page.desc}</p>
        </div>
      )}
      <div>
        {!practiceFinished && (
          <>
            <div className="start-row">
              {primaryAction === "retry-stt" || primaryAction === "retry-reply" || primaryAction === "retry-audio" ? (
                <Button variant="primary" size="lg" onClick={retryPipelineStage}>{LABELS[status]}</Button>
              ) : (
                <RecordButton
                  recording={status === "recording"}
                  onClick={onMainButton}
                  disabled={primaryAction === "busy"}
                >
                  {LABELS[status]}
                </RecordButton>
              )}
              {status === "stt-retry" && (
                <Button variant="secondary" onClick={recordAgain}>{t.recordAgain}</Button>
              )}
              {canDiscardConversationRecording(status) && (
                <Button variant="secondary" onClick={discardRecording}>{t.discardRecording}</Button>
              )}
            </div>
            {status === "recording" && <p className="text-sm text-muted">{t.stopAndSendHint}</p>}
          </>
        )}
        {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
        <div className="phrase-hint stack">
          <label className="text-sm text-muted" htmlFor="phrase-hint-input">
            {t.hintLabel}
          </label>
          <input
            id="phrase-hint-input"
            type="text"
            value={hintInput}
            onChange={(e) => setHintInput(e.target.value)}
            placeholder={t.hintPlaceholder}
          />
          <Button variant="secondary" onClick={requestHints} disabled={hints === "loading" || !hintInput.trim()}>
            {t.hintButton}
          </Button>
          {hints === "loading" && <p className="text-sm text-muted">{t.hintThinking}</p>}
          {hintError && (
            <p className="sentence-explain text-sm">
              {hintError}
              <Button variant="ghost" onClick={requestHints} disabled={!hintInput.trim()}>{t.retry}</Button>
            </p>
          )}
          {Array.isArray(hints) && (
            <div className="stack">
              {hints.map((h, i) => (
                <div key={i} className="sentence-explain text-sm">
                  <div>{h.en}</div>
                  {h.ja && <div className="text-muted">{h.ja}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
        <section className="chat">
          {turns.map((turn, i) => (
            <div key={i} className={`chat-row ${turn.role === "you" ? "you" : "ai"}`}>
              <div className={`bubble ${turn.role === "you" ? "bubble-you" : "bubble-ai"}`} aria-label={turn.role === "you" ? t.you : t.ai}>{turn.text}</div>
              {turn.role === "ai" && (
                <div className="chat-translate">
                  {translations[i] === undefined && (
                    <Button variant="ghost" onClick={() => translateTurn(i, turn.text)}>{t.translate}</Button>
                  )}
                  {translations[i] === "loading" && <p className="text-sm text-muted">{t.translating}</p>}
                  {translations[i] === "error" && (
                    <p className="text-sm text-muted">
                      {t.translateError}
                      <Button variant="ghost" onClick={() => translateTurn(i, turn.text)}>{t.retry}</Button>
                    </p>
                  )}
                  {translations[i] !== undefined && translations[i] !== "loading" && translations[i] !== "error" && (
                    <p className="sentence-explain text-sm">{translations[i]}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </section>
        {props.scenarioId === undefined && turns.length >= 2 && !practiceFinished && status === "idle" && (
          <Button variant="secondary" onClick={() => setPracticeFinished(true)}>{t.finishPractice}</Button>
        )}
        {props.scenarioId === undefined && canShowFreeTalkReaction(turns.length, practiceFinished) && (
          <div className="stack">
            <FeedbackRow context={{ blockKind: "free-talk", refId: null }} lang={props.lang} />
            <Button variant="ghost" onClick={() => setPracticeFinished(false)}>{t.continuePractice}</Button>
          </div>
        )}
      </div>
    </div>
  );
}
