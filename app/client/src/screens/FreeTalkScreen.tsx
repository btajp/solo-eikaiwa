import { useEffect, useRef, useState } from "react";
import { converse, fetchPhraseHints, fetchUtteranceTranslation, sttUpload, ttsFetch, type PhraseHint } from "../api";
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
  // AI発話ごとの訳。キーは turns の index。値: undefined=未取得, "loading"=取得中, それ以外=訳文
  const [translations, setTranslations] = useState<Record<number, string>>({});
  const [hintInput, setHintInput] = useState("");
  // 言い方ヒント。null=未取得, "loading"=取得中, 配列=提案結果
  const [hints, setHints] = useState<PhraseHint[] | "loading" | null>(null);
  const [hintError, setHintError] = useState("");

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
        setHintError("ヒントを取得できませんでした。もう一度お試しください。");
      }
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
      <div className="phrase-hint stack">
        <label className="text-sm text-muted" htmlFor="phrase-hint-input">
          うまく言えないときは、言いたいことを日本語で入力すると英語の言い方を提案します
        </label>
        <input
          id="phrase-hint-input"
          type="text"
          value={hintInput}
          onChange={(e) => setHintInput(e.target.value)}
          placeholder="例: その機能はまだ試していません"
        />
        <Button variant="secondary" onClick={requestHints} disabled={hints === "loading" || !hintInput.trim()}>
          💡 言い方のヒント
        </Button>
        {hints === "loading" && <p className="text-sm text-muted">言い方を考えています…</p>}
        {hintError && (
          <p className="sentence-explain text-sm">
            {hintError}
            <Button variant="ghost" onClick={requestHints}>再試行</Button>
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
        {turns.map((t, i) => (
          <div key={i} className={`chat-row ${t.role === "you" ? "you" : "ai"}`}>
            <div className={`bubble ${t.role === "you" ? "bubble-you" : "bubble-ai"}`} aria-label={t.role === "you" ? "あなた" : "AI"}>{t.text}</div>
            {t.role === "ai" && (
              <div className="chat-translate">
                {translations[i] === undefined && (
                  <Button variant="ghost" onClick={() => translateTurn(i, t.text)}>訳</Button>
                )}
                {translations[i] === "loading" && <p className="text-sm text-muted">訳しています…</p>}
                {translations[i] === "error" && (
                  <p className="text-sm text-muted">
                    訳を取得できませんでした。
                    <Button variant="ghost" onClick={() => translateTurn(i, t.text)}>再試行</Button>
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
    </div>
  );
}
