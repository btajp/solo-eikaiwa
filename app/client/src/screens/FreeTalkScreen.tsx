import { useEffect, useRef, useState } from "react";
import { converse, sttUpload, ttsFetch } from "../api";
import { playBlob, Recorder, stopPlayback } from "../audio";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";

type Turn = { role: "you" | "ai"; text: string };
type Status = "idle" | "recording" | "transcribing" | "thinking" | "speaking" | "error";

const LABELS: Record<Status, string> = {
  idle: "🎙 話す（クリックで録音開始）",
  recording: "⏹ 録音中…（クリックで送信）",
  transcribing: "📝 文字起こし中…",
  thinking: "🤔 考え中…",
  speaking: "🔊 再生中…",
  error: "🎙 もう一度話す",
};

/** 会話ループ画面。scenarioId を渡すとロールプレイモードになる（M1の自由会話UIを抽出したもの） */
export function FreeTalkScreen(props: { scenarioId?: string; onSessionId?: (id: string) => void }) {
  const [status, setStatus] = useState<Status>("idle");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const sessionIdRef = useRef<string | undefined>(undefined);
  const recorderRef = useRef(new Recorder());
  // stop→sttUpload→converse→ttsFetch→playBlob の対話パイプラインがアンマウント後も
  // 走り続けないようにするフラグ。await の後・setState の前（特に playBlob の前）で毎回チェックする
  const aliveRef = useRef(true);

  // 録音中/再生中に画面を離脱してもマイク・音声が解放されるよう、アンマウント時に停止する
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; recorderRef.current.cancel(); stopPlayback(); }; }, []);

  async function onMainButton() {
    setErrorMsg("");
    if (status === "idle" || status === "error") {
      try {
        await recorderRef.current.start();
        setStatus("recording");
      } catch (err) {
        setErrorMsg(`マイクにアクセスできません: ${err instanceof Error ? err.message : String(err)}`);
        setStatus("error");
      }
      return;
    }
    if (status !== "recording") return;
    try {
      setStatus("transcribing");
      const blob = await recorderRef.current.stop();
      if (!aliveRef.current) return;
      const text = await sttUpload(blob);
      if (!aliveRef.current) return;
      if (!text) {
        setErrorMsg("音声を聞き取れませんでした。もう一度話してください。");
        setStatus("error");
        return;
      }
      setTurns((t) => [...t, { role: "you", text }]);

      setStatus("thinking");
      const { replyText, sessionId } = await converse(text, sessionIdRef.current, props.scenarioId);
      if (!aliveRef.current) return;
      sessionIdRef.current = sessionId;
      props.onSessionId?.(sessionId);
      setTurns((t) => [...t, { role: "ai", text: replyText }]);

      setStatus("speaking");
      const audioBlob = await ttsFetch(replyText);
      if (!aliveRef.current) return;
      await playBlob(audioBlob);
      if (!aliveRef.current) return;
      setStatus("idle");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus("error");
    }
  }

  return (
    <div>
      <Button
        variant="primary"
        size="lg"
        onClick={onMainButton}
        disabled={status === "transcribing" || status === "thinking" || status === "speaking"}
      >
        {LABELS[status]}
      </Button>
      {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      <section className="chat">
        {turns.map((t, i) => (
          <div key={i} className={`chat-row ${t.role === "you" ? "you" : "ai"}`}>
            <div className={`bubble ${t.role === "you" ? "bubble-you" : "bubble-ai"}`}>{t.text}</div>
          </div>
        ))}
      </section>
    </div>
  );
}
