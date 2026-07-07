import { useEffect, useRef, useState } from "react";
import { fetchTalkExplanation, prefetchModelTalkAudio, type ContentItem } from "../api";
import { playBlob, stopPlayback } from "../audio";
import { getSupport, resolveSupport } from "../support";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

type State = "script" | "audio" | "ready" | "playing" | "error";

/** モデルトークをTTSで聞きながら重ねて音読するシャドーイングブロック（知覚ドリル）。既定はスクリプトを隠して聞く */
export function ShadowingScreen(props: { topic: ContentItem }) {
  const [state, setState] = useState<State>("script");
  const [text, setText] = useState("");
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  // スクリプト表示の既定は preset に従う（多め=最初から表示 / おまかせ・少なめ=隠して聞く）。
  // マウント時に固定し、ユーザーは「スクリプトを表示」ボタンでいつでも開ける。
  const [showScript, setShowScript] = useState(() => resolveSupport(null, getSupport().preset, false));
  // 日本語訳と解説: null=未取得, "loading"=生成中, それ以外=本文
  const [explain, setExplain] = useState<string | null>(null);
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
      const { text: t, blob } = await prefetchModelTalkAudio(props.topic.id, (stage) => {
        if (aliveRef.current) setState(stage);
      });
      if (!aliveRef.current) return;
      setText(t);
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
        まずはスクリプトを見ずに、音声に少し遅れてかぶせるように声に出して繰り返します（シャドーイング）。1回聞くだけでもOK。行き詰まったら「スクリプトを表示」で確認できます。
      </p>
      {state === "script" && <p className="text-muted">✍ コーチがモデルトークを書いています…</p>}
      {state === "audio" && <p className="text-muted">🎙 音声を生成しています…</p>}
      {state === "error" && (
        <Banner kind="error" action={<Button onClick={prepare}>再試行</Button>}>
          {errorMsg}
        </Banner>
      )}
      {(state === "ready" || state === "playing") && (
        <div className="stack">
          <Button variant="primary" onClick={play} disabled={state === "playing"}>
            {state === "playing" ? "🔊 再生中…" : "▶ 再生（何度でも）"}
          </Button>
          {!showScript && (
            <Button variant="secondary" onClick={() => setShowScript(true)}>📄 スクリプトを表示</Button>
          )}
          {showScript && (
            <>
              <Card className="reading-text">{text}</Card>
              {explain === null && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    setExplain("loading");
                    try {
                      const t = await fetchTalkExplanation(text);
                      if (aliveRef.current) setExplain(t);
                    } catch {
                      if (aliveRef.current) setExplain("解説を取得できませんでした。もう一度お試しください。");
                    }
                  }}
                >
                  💡 日本語訳と解説
                </Button>
              )}
              {explain === "loading" && <p className="text-sm text-muted">日本語訳と解説を書いています…</p>}
              {explain !== null && explain !== "loading" && (
                <p className="sentence-explain text-sm">{explain}</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
