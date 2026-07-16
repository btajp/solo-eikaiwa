import { useEffect, useRef, useState } from "react";
import { fetchTalkExplanation, prefetchModelTalkAudio, sendSessionEvent, type ContentItem } from "../api";
import { playBlob, stopPlayback } from "../audio";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { useExplain } from "../useExplain";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ExplainBox } from "../ui/ExplainBox";
import { LevelChip } from "../ui/LevelChip";
import { PlaybackButton } from "../ui/PlaybackButton";
import {
  confirmSpoken,
  initialShadowingProgress,
  markListened,
  resolveShadowingPlaybackOutcome,
  type ShadowingPlaybackOutcome,
} from "./shadowingPlayback";

type State = "script" | "audio" | "ready" | "playing" | "error";

/** モデルトークをTTSで聞きながら重ねて音読するシャドーイングブロック（知覚ドリル）。既定はスクリプトを隠して聞く */
export function ShadowingScreen(props: {
  topic: ContentItem; lang: Lang; sessionId?: string; blockId?: string;
  onReady?: () => void; onValidAttempt?: () => void;
}) {
  const t = STR[props.lang].shadowing;
  const playback = STR[props.lang].playback;
  const [state, setState] = useState<State>("script");
  const [text, setText] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [playbackFailed, setPlaybackFailed] = useState(false);
  // 「聞いた」と「声に出した」を区別する（#181）。全編再生で listened、自己申告で spokenConfirmed。
  const [progress, setProgress] = useState(initialShadowingProgress);
  // スクリプト表示の既定は常に非表示（隠して聞く）。ユーザーは「スクリプトを表示」ボタンでいつでも開ける。
  const [showScript, setShowScript] = useState(false);
  const explainer = useExplain(() => fetchTalkExplanation(text));
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);
  const readyNotifiedRef = useRef(false);
  const playbackGenerationRef = useRef(0);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      prepare();
    }
    return () => {
      aliveRef.current = false;
      playbackGenerationRef.current++;
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function prepare() {
    playbackGenerationRef.current++;
    stopPlayback();
    setErrorMsg("");
    setPlaybackFailed(false);
    setState("script");
    try {
      const { text: talkText, blob } = await prefetchModelTalkAudio(props.topic.id, (stage) => {
        if (aliveRef.current) setState(stage);
      });
      if (!aliveRef.current) return;
      setText(talkText);
      setAudioBlob(blob);
      setState("ready");
      if (!readyNotifiedRef.current) {
        readyNotifiedRef.current = true;
        props.onReady?.();
      }
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(formatClientError(props.lang, err, "load"));
      setState("error");
    }
  }

  async function play() {
    if (!audioBlob) return;
    const generation = ++playbackGenerationRef.current;
    setPlaybackFailed(false);
    setErrorMsg("");
    setState("playing");
    let outcome: ShadowingPlaybackOutcome;
    let playbackError: unknown = null;
    try {
      const played = await playBlob(audioBlob);
      outcome = played ? "completed" : "stopped";
    } catch (err) {
      playbackError = err;
      outcome = "failed";
    }
    if (!aliveRef.current || playbackGenerationRef.current !== generation) return;
    const resolution = resolveShadowingPlaybackOutcome(outcome);
    if (resolution.listened) {
      // 全編再生は「聞いた」の記録。有効試行（XP・完了条件）は声に出した自己申告で別に扱う（#181）
      setProgress(markListened);
      sendSessionEvent("block_activity", props.sessionId, {
        blockId: props.blockId, kind: "shadowing", activity: "listened",
      });
    }
    if (resolution.showRetry && playbackError !== null) {
      setErrorMsg(formatClientError(props.lang, playbackError, "play"));
    }
    setPlaybackFailed(resolution.showRetry);
    setState(resolution.nextState);
  }

  /** 声に出して重ねられたことの自己申告（マイク不要）。初回だけ有効試行として通知する。 */
  function confirmSpokenPractice() {
    const { progress: next, firstConfirmation } = confirmSpoken(progress);
    setProgress(next);
    if (!firstConfirmation) return;
    props.onValidAttempt?.();
    sendSessionEvent("block_activity", props.sessionId, {
      blockId: props.blockId, kind: "shadowing", activity: "spoken-self-report",
    });
  }

  function stop() {
    playbackGenerationRef.current++;
    stopPlayback();
    if (aliveRef.current) setState("ready");
  }

  return (
    <div className="stack">
      <LevelChip kind="auto" lang={props.lang} />
      <p className="text-muted">
        {t.intro}
      </p>
      {state === "script" && <p className="text-muted">{t.writingScript}</p>}
      {state === "audio" && <p className="text-muted">{t.generatingAudio}</p>}
      {state === "error" && (
        <Banner kind="error" action={<Button onClick={prepare}>{t.retry}</Button>}>
          <span className="block">{errorMsg}</span>
          {/* #192: 同梱アセットの無いお題はLLM実行時生成が必要なため、行き止まりにせず設定への復旧導線を出す */}
          <span className="block text-sm text-muted">
            {t.llmSetupHint} <a href="#/settings">{t.openLlmSettings}</a>
          </span>
        </Banner>
      )}
      {(state === "ready" || state === "playing") && (
        <div className="stack">
          {state === "ready" && playbackFailed && (
            <Banner kind="error" action={<Button onClick={play}>{t.playbackRetry}</Button>}>
              <span className="block">{t.playbackError}</span>
              {errorMsg && <span className="block text-sm text-muted">{errorMsg}</span>}
            </Banner>
          )}
          <PlaybackButton
            playing={state === "playing"}
            onPlay={play}
            onStop={stop}
            playLabel={t.play}
            stopLabel={playback.stop}
            playVariant="primary"
          />
          {/* 全編再生後の任意自己確認（#181）。マイクは使わず自己申告で「声に出した」を記録する */}
          {progress.listened && (
            <div className="stack">
              <p className="text-sm text-muted">{t.spokenPrompt}</p>
              <Button variant="secondary" onClick={confirmSpokenPractice} disabled={progress.spokenConfirmed}>
                {progress.spokenConfirmed ? t.spokenConfirmed : t.confirmSpoken}
              </Button>
            </div>
          )}
          {!showScript && (
            <Button variant="secondary" onClick={() => setShowScript(true)}>{t.showScript}</Button>
          )}
          {showScript && (
            <>
              <Card className="reading-text">{text}</Card>
              <ExplainBox
                state={explainer.state} request={explainer.request}
                labels={{ more: t.explainMore, loading: t.explainLoading, error: t.explainError, retry: t.retry }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
