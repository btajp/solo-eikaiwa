import { useEffect, useRef, useState } from "react";
import {
  fetchAeFeedback, fetchPrepPack, playTtsCached, prefetchModelTalkAudio, sendSessionEvent, sttUpload,
  type AeFeedback, type ContentItem, type PrepPack,
} from "../api";
import { playBlob, Recorder, stopPlayback } from "../audio";
import { formatMmSs, useCountdown } from "../useCountdown";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ChunkList } from "../ui/ChunkList";
import { TimerChip } from "../ui/TimerChip";

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
      setModelState("playing");
      try {
        await playBlob(blob);
      } finally {
        if (aliveRef.current) setModelState("ready");
      }
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
      <div className="stack">
        <Card header={`準備 — ${props.topic.title}`}>
          {props.topic.titleJa && <p className="text-muted">{props.topic.titleJa}</p>}
          <p className="text-muted">
            これから同じ話を {roundsSec.map(minLabel).join("→")} で{roundsSec.length}回話します。まず使えそうな表現と骨組みを確認してください（目安 {minLabel(PREP_SECONDS)}）。
          </p>
          <TimerChip remaining={prepTimer.remaining} expired={prepTimer.expired} note="そろそろ始めましょう" />
        </Card>
        <ul className="text-muted">
          {props.topic.hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
        {prepState === "loading" && <p>コーチが表現チャンクを用意しています…</p>}
        {prepState === "error" && (
          <Banner kind="error" action={<Button onClick={loadPrep}>再試行</Button>}>
            {errorMsg}
          </Banner>
        )}
        {prepState === "ready" && prep && (
          <div className="stack">
            {prep.chunks.filter((c) => typeof c.en === "string" && c.en).length > 0 && (
              <ChunkList chunks={prep.chunks.filter((c) => typeof c.en === "string" && c.en)} playingIdx={playingIdx} onPlay={playChunk} />
            )}
            {prep.outline.length > 0 && (
              <Card header="話の骨組み">
                <ol>
                  {prep.outline.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ol>
              </Card>
            )}
          </div>
        )}
        <div className="start-row">
          <Button onClick={playModelTalk} disabled={modelState === "script" || modelState === "audio" || modelState === "playing"}>
            {modelState === "script" && "✍ 原稿を作成中…"}
            {modelState === "audio" && "🎙 音声を生成中…"}
            {modelState === "ready" && "🎧 モデルトークを聞く（任意）"}
            {modelState === "playing" && "🔊 再生中…"}
            {modelState === "error" && "🎧 モデルトーク（再試行）"}
          </Button>
          <Button variant="primary" onClick={() => startRound(0)}>
            Round 1 を始める（{minLabel(roundsSec[0])}）→
          </Button>
        </div>
        {modelText && (
          <details open>
            <summary className="text-muted">モデルトーク本文</summary>
            <p className="reading-text">{modelText}</p>
          </details>
        )}
        {prepState !== "error" && errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      </div>
    );
  }

  if (phase.kind === "ae") {
    return (
      <Card header="フィードバック（読んだら Round 2 へ）">
        {aeLoading && <p>コーチがフィードバックを書いています…</p>}
        {aeSkippedNoRecording && <p>録音がなかったのでフィードバックはありません</p>}
        {ae && (
          <div>
            {ae.praise && <Banner kind="info">👏 {ae.praise}</Banner>}
            <ul>
              {ae.items.map((item, i) => (
                <li key={i} className="ae-item">
                  {item.quote && (
                    <div>
                      <s>{item.quote}</s> → <strong>{item.better}</strong> <em>({item.issue})</em>
                    </div>
                  )}
                  <div className="ae-why">{item.why_ja}</div>
                </li>
              ))}
            </ul>
          </div>
        )}
        {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
        <Button variant="primary" onClick={() => startRound(1)} disabled={aeLoading}>
          Round 2 を始める（{minLabel(roundsSec[1])}）
        </Button>
      </Card>
    );
  }

  if (phase.kind === "done") {
    return (
      <Card>
        <p>4/3/2 完了！同じ話を{roundsSec.length}回、少しずつ速く話せました。</p>
      </Card>
    );
  }

  return (
    <div className="round-stage">
      <h3>
        Round {roundIndex + 1}（{minLabel(roundsSec[roundIndex])}） — {props.topic.title}
      </h3>
      <p className="text-muted">{LISTENERS[roundIndex % LISTENERS.length]}</p>
      <ul className="text-sm text-muted">
        {props.topic.hints.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
      <div className={`round-timer${timer.expired ? " is-expired" : ""}`}>
        {formatMmSs(timer.remaining)} {timer.expired && <span className="text-sm">— 時間切れ！</span>}
      </div>
      <div className="round-actions">
        <button
          className={`btn btn-primary btn-lg record-btn${recState === "recording" ? " is-recording" : ""}`}
          onClick={toggleRecording}
          disabled={recState === "transcribing"}
        >
          {recState === "recording" ? "⏹ 録音を止める" : recState === "transcribing" ? "📝 文字起こし中…" : "🎙 話し始める"}
        </button>
        <Button onClick={finishRound} disabled={recState === "transcribing"}>
          このラウンドを終える →
        </Button>
      </div>
      {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      {transcripts[roundIndex] && (
        <Card className="reading-text">
          <strong>You:</strong> {transcripts[roundIndex]}
        </Card>
      )}
    </div>
  );
}
