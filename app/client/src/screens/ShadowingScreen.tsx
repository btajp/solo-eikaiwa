import { useEffect, useRef, useState } from "react";
import { fetchTalkExplanation, prefetchModelTalkAudio, type ContentItem } from "../api";
import { playBlob, stopPlayback } from "../audio";
import { STR, type Lang } from "../i18n";
import { useExplain } from "../useExplain";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

type State = "script" | "audio" | "ready" | "playing" | "error";

/** モデルトークをTTSで聞きながら重ねて音読するシャドーイングブロック（知覚ドリル）。既定はスクリプトを隠して聞く */
export function ShadowingScreen(props: { topic: ContentItem; lang: Lang }) {
  const t = STR[props.lang].shadowing;
  const [state, setState] = useState<State>("script");
  const [text, setText] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  // スクリプト表示の既定は常に非表示（隠して聞く）。ユーザーは「スクリプトを表示」ボタンでいつでも開ける。
  const [showScript, setShowScript] = useState(false);
  const explainer = useExplain(() => fetchTalkExplanation(text));
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      prepare();
    }
    return () => {
      aliveRef.current = false;
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function prepare() {
    setErrorMsg("");
    setState("script");
    try {
      const { text: talkText, blob } = await prefetchModelTalkAudio(props.topic.id, (stage) => {
        if (aliveRef.current) setState(stage);
      });
      if (!aliveRef.current) return;
      setText(talkText);
      setAudioBlob(blob);
      setState("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  async function play() {
    if (!audioBlob) return;
    setState("playing");
    try {
      await playBlob(audioBlob);
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
    if (aliveRef.current) setState("ready");
  }

  return (
    <div className="stack">
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
          <Button variant="primary" onClick={play} disabled={state === "playing"}>
            {state === "playing" ? t.playing : t.play}
          </Button>
          {!showScript && (
            <Button variant="secondary" onClick={() => setShowScript(true)}>{t.showScript}</Button>
          )}
          {showScript && (
            <>
              <Card className="reading-text">{text}</Card>
              {explainer.state.status === "idle" && (
                <Button variant="ghost" onClick={explainer.request}>{t.explainMore}</Button>
              )}
              {explainer.state.status === "loading" && <p className="text-sm text-muted">{t.explainLoading}</p>}
              {explainer.state.status === "error" && (
                <p className="text-sm text-muted">{t.explainError}<Button variant="ghost" onClick={explainer.request}>{t.retry}</Button></p>
              )}
              {explainer.state.status === "done" && <p className="sentence-explain text-sm">{explainer.state.text}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
