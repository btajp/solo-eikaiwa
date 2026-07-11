import { useEffect, useRef, useState } from "react";
import { fetchTalkExplanation, prefetchModelTalkAudio, type ContentItem } from "../api";
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
import { resolveShadowingPlaybackOutcome, type ShadowingPlaybackOutcome } from "./shadowingPlayback";

type State = "script" | "audio" | "ready" | "playing" | "error";

/** モデルトークをTTSで聞きながら重ねて音読するシャドーイングブロック（知覚ドリル）。既定はスクリプトを隠して聞く */
export function ShadowingScreen(props: {
  topic: ContentItem; lang: Lang; onReady?: () => void; onValidAttempt?: () => void;
}) {
  const t = STR[props.lang].shadowing;
  const playback = STR[props.lang].playback;
  const [state, setState] = useState<State>("script");
  const [text, setText] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [playbackFailed, setPlaybackFailed] = useState(false);
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
    if (resolution.validAttempt) props.onValidAttempt?.();
    if (resolution.showRetry && playbackError !== null) {
      setErrorMsg(formatClientError(props.lang, playbackError, "play"));
    }
    setPlaybackFailed(resolution.showRetry);
    setState(resolution.nextState);
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
          {errorMsg}
        </Banner>
      )}
      {(state === "ready" || state === "playing") && (
        <div className="stack">
          {state === "ready" && playbackFailed && (
            <Banner kind="error" action={<Button onClick={play}>{t.playbackRetry}</Button>}>
              <p>{t.playbackError}</p>
              {errorMsg && <p className="text-sm text-muted">{errorMsg}</p>}
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
