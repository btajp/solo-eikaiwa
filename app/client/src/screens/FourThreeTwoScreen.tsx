import { useEffect, useRef, useState } from "react";
import {
  fetchAeFeedback, fetchPrepPack, playTtsCached, prefetchModelTalkAudio, sendSessionEvent, sttUpload,
  type AeFeedback, type ContentItem, type PrepPack,
} from "../api";
import { playBlob, Recorder, stopPlayback } from "../audio";
import { formatMmSs, useCountdown } from "../useCountdown";

/** メニュー params に roundsSec が無い場合（当日分の古いキャッシュ等）のフォールバック */
const DEFAULT_ROUNDS_SEC = [120, 90, 60];
const PREP_SECONDS = 180;

const LISTENERS = [
  "Listener: a colleague who doesn't know this topic yet.",
  "New listener: your manager. Tell the same story, faster.",
  "New listener: someone at a conference. Same story, shorter.",
] as const;

/** 90 → "1.5分"、120 → "2分" のような表示 */
function minLabel(seconds: number): string {
  const m = seconds / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}分`;
}

type Phase = { kind: "prep" } | { kind: "round"; index: number } | { kind: "ae" } | { kind: "done" };
type RecState = "idle" | "recording" | "transcribing";
type PrepState = "loading" | "ready" | "error";

/**
 * スキャフォールド付き 4/3/2 流暢性ブロック。
 * 準備フェーズ（チャンク＋アウトライン＋モデル聴取）→ 同じ話を 2分→(AE)→1.5分→1分。
 * ラウンド秒数は menu params (roundsSec) が正で、流暢性の伸びに応じてサーバ側で較正する。
 */
export function FourThreeTwoScreen(props: { topic: ContentItem; sessionId: string; blockId: string; roundsSec?: number[] }) {
  const roundsSec =
    props.roundsSec && props.roundsSec.length >= 2 && props.roundsSec.every((s) => s > 0)
      ? props.roundsSec
      : DEFAULT_ROUNDS_SEC;

  const [phase, setPhase] = useState<Phase>({ kind: "prep" });
  const [recState, setRecState] = useState<RecState>("idle");
  const [transcripts, setTranscripts] = useState<string[]>(() => Array(roundsSec.length).fill(""));
  // setState は非同期に反映されるため、finishRound が直後に読む用の同期ミラーを持つ
  const transcriptsRef = useRef<string[]>(Array(roundsSec.length).fill(""));
  const [ae, setAe] = useState<AeFeedback | null>(null);
  const [aeLoading, setAeLoading] = useState(false);
  const [aeSkippedNoRecording, setAeSkippedNoRecording] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  // 準備フェーズ
  const [prepState, setPrepState] = useState<PrepState>("loading");
  const [prep, setPrep] = useState<PrepPack | null>(null);
  type ModelState = "script" | "audio" | "ready" | "playing" | "error";
  const [modelState, setModelState] = useState<ModelState>("script");
  const [modelText, setModelText] = useState("");
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const prepFetchedRef = useRef(false); // StrictMode の二重マウントで prep を二重フェッチしない
  const prepTimer = useCountdown(PREP_SECONDS);
  const recorderRef = useRef(new Recorder());
  const timer = useCountdown(roundsSec[0]);
  const roundStartedRef = useRef(false);
  const aliveRef = useRef(true);
  const roundIndexRef = useRef(0);
  const remainingRef = useRef(timer.remaining);

  const roundIndex = phase.kind === "round" ? phase.index : 0;
  useEffect(() => { roundIndexRef.current = roundIndex; }, [roundIndex]);
  useEffect(() => { remainingRef.current = timer.remaining; }, [timer.remaining]);

  useEffect(() => {
    aliveRef.current = true;
    if (!prepFetchedRef.current) {
      prepFetchedRef.current = true;
      loadPrep();
      prepTimer.start();
      prefetchModelTalkAudio(props.topic.id, (stage) => {
        if (aliveRef.current) setModelState(stage);
      })
        .then(({ text }) => {
          if (!aliveRef.current) return;
          setModelText(text);
          setModelState("ready");
        })
        .catch(() => {
          if (aliveRef.current) setModelState("error");
        });
    }
    return () => {
      aliveRef.current = false;
      recorderRef.current.cancel();
      stopPlayback();
      if (roundStartedRef.current) {
        roundStartedRef.current = false;
        const idx = roundIndexRef.current;
        sendSessionEvent("round_end", props.sessionId, {
          blockId: props.blockId,
          block: "four-three-two",
          round: idx + 1,
          aborted: true,
          transcript: transcriptsRef.current[idx],
          elapsedSec: roundsSec[idx] - remainingRef.current,
        });
      }
    };
  }, []);

  async function loadPrep() {
    setPrepState("loading");
    setErrorMsg("");
    try {
      const pack = await fetchPrepPack(props.topic.id);
      if (!aliveRef.current) return;
      setPrep(pack);
      setPrepState("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPrepState("error");
    }
  }

  async function playModelTalk() {
    setErrorMsg("");
    try {
      const { text, blob } = await prefetchModelTalkAudio(props.topic.id, (stage) => {
        if (aliveRef.current) setModelState(stage);
      });
      if (!aliveRef.current) return;
      setModelText(text);
      await playBlob(blob);
      if (aliveRef.current) setModelState("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setModelState("error");
    }
  }

  async function playChunk(i: number, text: string) {
    setErrorMsg("");
    setPlayingIdx(i);
    try {
      await playTtsCached(text);
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setPlayingIdx(null);
    }
  }

  async function toggleRecording() {
    setErrorMsg("");
    if (recState === "idle") {
      try {
        stopPlayback();
        await recorderRef.current.start();
        setRecState("recording");
        if (!timer.running && !timer.expired) {
          timer.start();
          roundStartedRef.current = true;
          sendSessionEvent("round_start", props.sessionId, { blockId: props.blockId, block: "four-three-two", round: roundIndex + 1 });
        }
      } catch (err) {
        setErrorMsg(`マイクにアクセスできません: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    if (recState !== "recording") return;
    try {
      setRecState("transcribing");
      const blob = await recorderRef.current.stop();
      if (!aliveRef.current) return;
      const text = await sttUpload(blob);
      if (!aliveRef.current) return;
      transcriptsRef.current[roundIndex] = [transcriptsRef.current[roundIndex], text]
        .filter(Boolean)
        .join(" ");
      setTranscripts([...transcriptsRef.current]);
      setRecState("idle");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setRecState("idle");
    }
  }

  async function finishRound() {
    if (recState === "recording") await toggleRecording();
    if (!aliveRef.current) return;
    timer.pause();
    if (roundStartedRef.current) {
      roundStartedRef.current = false;
      sendSessionEvent("round_end", props.sessionId, {
        blockId: props.blockId,
        block: "four-three-two",
        round: roundIndex + 1,
        transcript: transcriptsRef.current[roundIndex],
        elapsedSec: roundsSec[roundIndex] - timer.remaining,
      });
    }
    if (roundIndex === 0) {
      setPhase({ kind: "ae" });
      const transcript = transcriptsRef.current[0];
      if (!transcript.trim()) {
        setAeSkippedNoRecording(true);
        setAe(null);
      } else {
        setAeSkippedNoRecording(false);
        setAeLoading(true);
        try {
          const feedback = await fetchAeFeedback(transcript, props.topic.title);
          if (!aliveRef.current) return;
          setAe(feedback);
        } catch (err) {
          if (!aliveRef.current) return;
          setErrorMsg(err instanceof Error ? err.message : String(err));
        } finally {
          if (aliveRef.current) setAeLoading(false);
        }
      }
    } else if (roundIndex < roundsSec.length - 1) {
      startRound(roundIndex + 1);
    } else {
      setPhase({ kind: "done" });
    }
  }

  function startRound(index: number) {
    setPhase({ kind: "round", index });
    timer.reset(roundsSec[index]);
    roundStartedRef.current = false;
  }

  if (phase.kind === "prep") {
    return (
      <div>
        <h3>準備 — {props.topic.title}</h3>
        {props.topic.titleJa && <p style={{ color: "#666" }}>{props.topic.titleJa}</p>}
        <p style={{ color: "#666" }}>
          これから同じ話を {roundsSec.map(minLabel).join("→")} で{roundsSec.length}回話します。まず使えそうな表現と骨組みを確認してください（目安 {minLabel(PREP_SECONDS)}）。
        </p>
        <p style={{ fontVariantNumeric: "tabular-nums" }}>⏱ 準備 {formatMmSs(prepTimer.remaining)}{prepTimer.expired && " — そろそろ始めましょう"}</p>
        <ul>
          {props.topic.hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
        {prepState === "loading" && <p>コーチが表現チャンクを用意しています…</p>}
        {prepState === "error" && (
          <p style={{ color: "crimson" }}>
            {errorMsg} <button onClick={loadPrep}>再試行</button>
          </p>
        )}
        {prepState === "ready" && prep && (
          <div>
            {prep.chunks.length > 0 && (
              <div>
                <h4>使える表現</h4>
                <ul>
                  {prep.chunks
                    .filter((c) => typeof c.en === "string" && c.en)
                    .map((c, i) => (
                      <li key={i}>
                        <button
                          onClick={() => playChunk(i, c.en)}
                          disabled={playingIdx !== null}
                          style={{ marginRight: "0.5rem", cursor: "pointer" }}
                          aria-label={`「${c.en}」を再生`}
                        >
                          {playingIdx === i ? "…" : "🔊"}
                        </button>
                        <strong>{c.en}</strong>
                        {c.ja && <span style={{ color: "#666" }}> — {c.ja}</span>}
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {prep.outline.length > 0 && (
              <div>
                <h4>話の骨組み</h4>
                <ol>
                  {prep.outline.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
        <p>
          <button
            onClick={playModelTalk}
            disabled={modelState === "script" || modelState === "audio" || modelState === "playing"}
            style={{ padding: "0.6rem 1.2rem" }}
          >
            {modelState === "script" && "✍ 原稿を作成中…"}
            {modelState === "audio" && "🎙 音声を生成中…"}
            {modelState === "ready" && "🎧 モデルトークを聞く（任意）"}
            {modelState === "playing" && "🔊 再生中…"}
            {modelState === "error" && "🎧 モデルトーク（再試行）"}
          </button>{" "}
          <button onClick={() => startRound(0)} style={{ padding: "0.6rem 1.2rem" }}>
            Round 1 を始める（{minLabel(roundsSec[0])}）→
          </button>
        </p>
        {modelText && (
          <details open style={{ marginTop: "0.5rem" }}>
            <summary style={{ cursor: "pointer", color: "#666" }}>モデルトーク本文</summary>
            <p style={{ whiteSpace: "pre-wrap", lineHeight: 1.8 }}>{modelText}</p>
          </details>
        )}
        {prepState !== "error" && errorMsg && <p style={{ color: "crimson" }}>{errorMsg}</p>}
      </div>
    );
  }

  if (phase.kind === "ae") {
    return (
      <div>
        <h3>フィードバック（読んだら Round 2 へ）</h3>
        {aeLoading && <p>コーチがフィードバックを書いています…</p>}
        {aeSkippedNoRecording && <p>録音がなかったのでフィードバックはありません</p>}
        {ae && (
          <div>
            {ae.praise && <p>👏 {ae.praise}</p>}
            <ul>
              {ae.items.map((item, i) => (
                <li key={i} style={{ marginBottom: "0.6rem" }}>
                  {item.quote && (
                    <div>
                      <s>{item.quote}</s> → <strong>{item.better}</strong> <em>({item.issue})</em>
                    </div>
                  )}
                  <div>{item.why_ja}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {errorMsg && <p style={{ color: "crimson" }}>{errorMsg}</p>}
        <button onClick={() => startRound(1)} disabled={aeLoading} style={{ padding: "0.6rem 1.2rem" }}>
          Round 2 を始める（{minLabel(roundsSec[1])}）
        </button>
      </div>
    );
  }

  if (phase.kind === "done") {
    return <p>4/3/2 完了！同じ話を{roundsSec.length}回、少しずつ速く話せました。</p>;
  }

  return (
    <div>
      <h3>
        Round {roundIndex + 1}（{minLabel(roundsSec[roundIndex])}） — {props.topic.title}
      </h3>
      <p style={{ color: "#666" }}>{LISTENERS[roundIndex % LISTENERS.length]}</p>
      <ul>
        {props.topic.hints.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
      <p style={{ fontSize: "2rem", fontVariantNumeric: "tabular-nums" }}>
        ⏱ {formatMmSs(timer.remaining)} {timer.expired && "— 時間切れ！"}
      </p>
      <button onClick={toggleRecording} disabled={recState === "transcribing"} style={{ padding: "0.6rem 1.2rem" }}>
        {recState === "recording" ? "⏹ 録音を止める" : recState === "transcribing" ? "📝 文字起こし中…" : "🎙 話し始める"}
      </button>{" "}
      <button onClick={finishRound} disabled={recState === "transcribing"} style={{ padding: "0.6rem 1.2rem" }}>
        このラウンドを終える →
      </button>
      {errorMsg && <p style={{ color: "crimson" }}>{errorMsg}</p>}
      {transcripts[roundIndex] && (
        <p style={{ whiteSpace: "pre-wrap" }}>
          <strong>You:</strong> {transcripts[roundIndex]}
        </p>
      )}
    </div>
  );
}
