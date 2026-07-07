import { useEffect, useRef, useState } from "react";
import {
  fetchAeFeedback, fetchFixExplanation, fetchPrepPack, prefetchModelTalkAudio, sendSessionEvent, sttUpload,
  type AeFeedback, type ContentItem, type PrepPack,
} from "../api";
import { playBlob, Recorder, stopPlayback } from "../audio";
import { formatMmSs, useCountdown } from "../useCountdown";
import { usePlayRow } from "../usePlayRow";
import { useExplain } from "../useExplain";
import { STR, type Lang } from "../i18n";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ChunkList } from "../ui/ChunkList";
import { ExplainBox } from "../ui/ExplainBox";
import { LevelChip } from "../ui/LevelChip";
import { TimerChip } from "../ui/TimerChip";
import { getSupport, resolveSupport, showJaFromPrep, useSupport } from "../support";

/** メニュー params に roundsSec が無い場合（当日分の古いキャッシュ等）のフォールバック */
const DEFAULT_ROUNDS_SEC = [120, 90, 60];
const PREP_SECONDS = 180;

const LISTENERS = [
  "Listener: a colleague who doesn't know this topic yet.",
  "New listener: your manager. Tell the same story, faster.",
  "New listener: someone at a conference. Same story, shorter.",
] as const;

/** 90 → "1.5"、120 → "2" のような数値文字列（単位は呼び出し側の辞書で付与） */
function minNum(seconds: number): string {
  const m = seconds / 60;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}`;
}

type Phase = { kind: "prep" } | { kind: "round"; index: number } | { kind: "ae" } | { kind: "done" };
type RecState = "idle" | "recording" | "transcribing";
type PrepState = "loading" | "ready" | "error";

/**
 * スキャフォールド付き 4/3/2 流暢性ブロック。
 * 準備フェーズ（チャンク＋アウトライン＋モデル聴取）→ 同じ話を 2分→(AE)→1.5分→1分。
 * ラウンド秒数は menu params (roundsSec) が正で、流暢性の伸びに応じてサーバ側で較正する。
 */
export function FourThreeTwoScreen(props: {
  topic: ContentItem; sessionId: string; blockId: string; roundsSec?: number[];
  modelTalkMode?: "auto" | "button"; lang: Lang;
}) {
  const t = STR[props.lang].ftt432;
  const support = useSupport();
  // モデルトーク自動再生の可否: 個別トグル → メニューの stage 既定（auto か）で解決。
  // 初期 modelState と一度きりの prefetch effect が参照するため、マウント時に固定する。
  const [autoPlay] = useState(() =>
    resolveSupport(getSupport().modelTalk, (props.modelTalkMode ?? "auto") === "auto"),
  );
  const roundsSec =
    props.roundsSec && props.roundsSec.length >= 2 && props.roundsSec.every((s) => s > 0)
      ? props.roundsSec
      : DEFAULT_ROUNDS_SEC;

  const [phase, setPhase] = useState<Phase>({ kind: "prep" });
  const [recState, setRecState] = useState<RecState>("idle");
  const [transcripts, setTranscripts] = useState<string[]>(() => Array(roundsSec.length).fill(""));
  // setState は非同期に反映されるため、finishRound が直後に読む用の同期ミラーを持つ
  const transcriptsRef = useRef<string[]>(Array(roundsSec.length).fill(""));
  // STT（sttUpload）が失敗したラウンドの印。round_end の meta.sttFailed に伝え、技術障害を
  // 降格シグナル（lowOutput）の観測対象から除外できるようにする（サーバ側 fttOutputSignals 参照）
  const sttFailedRef = useRef<boolean[]>(Array(roundsSec.length).fill(false));
  const [ae, setAe] = useState<AeFeedback | null>(null);
  const [aeLoading, setAeLoading] = useState(false);
  const [aeSkippedNoRecording, setAeSkippedNoRecording] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  // 準備フェーズ
  const [prepState, setPrepState] = useState<PrepState>("loading");
  const [prep, setPrep] = useState<PrepPack | null>(null);
  type ModelState = "idle" | "script" | "audio" | "ready" | "playing" | "error";
  const [modelState, setModelState] = useState<ModelState>(autoPlay ? "script" : "idle");
  const [modelText, setModelText] = useState("");
  const playRow = usePlayRow<number>();
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
      if (autoPlay) {
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
          ...(sttFailedRef.current[idx] ? { sttFailed: true } : {}),
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
        setErrorMsg(t.micError(err instanceof Error ? err.message : String(err)));
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
      // 同一ラウンド内で失敗後に録り直して成功した場合、直前の失敗印を引きずらないよう解除する
      sttFailedRef.current[roundIndex] = false;
      transcriptsRef.current[roundIndex] = [transcriptsRef.current[roundIndex], text]
        .filter(Boolean)
        .join(" ");
      setTranscripts([...transcriptsRef.current]);
      setRecState("idle");
    } catch (err) {
      if (!aliveRef.current) return;
      // STT呼び出しの失敗でtranscriptが空のままround_endが記録され得るため印を付ける
      // （技術障害を英語力の低さのシグナルとして扱わないため。サーバ側 fttOutputSignals で観測対象外にする）
      sttFailedRef.current[roundIndex] = true;
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
        ...(sttFailedRef.current[roundIndex] ? { sttFailed: true } : {}),
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
        <Card header={t.prepTitle(props.topic.title)}>
          <LevelChip kind="auto" lang={props.lang} />
          {props.lang === "ja" && props.topic.titleJa && <p className="text-muted">{props.topic.titleJa}</p>}
          <p className="text-muted">
            {t.prepIntro(roundsSec.map((s) => t.min(minNum(s))).join("→"), roundsSec.length, t.min(minNum(PREP_SECONDS)))}
          </p>
          <p className="text-sm text-muted">{t.prepMicNote}</p>
          <TimerChip remaining={prepTimer.remaining} expired={prepTimer.expired} note={t.prepTimerNote} />
        </Card>
        <ul className="text-muted">
          {props.topic.hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
        {prepState === "loading" && <p>{t.loading}</p>}
        {prepState === "error" && (
          <Banner kind="error" action={<Button onClick={loadPrep}>{t.retry}</Button>}>
            {errorMsg}
          </Banner>
        )}
        {prepState === "ready" && prep && (() => {
          const filteredChunks = prep.chunks.filter((c) => typeof c.en === "string" && c.en);
          const showJa = showJaFromPrep(support, prep);
          return (
          <div className="stack">
            {filteredChunks.length > 0 && (
              <ChunkList
                chunks={filteredChunks} playingIdx={playRow.playingKey} onPlay={(i, text) => playRow.play(i, text)} showJa={showJa}
                playAria={(en) => STR[props.lang].chunkList.playAria(en)}
              />
            )}
            {prep.outline.length > 0 && (
              <Card header={t.outlineTitle}>
                <ol>
                  {prep.outline.map((o, i) => (
                    <li key={i}>{o}</li>
                  ))}
                </ol>
              </Card>
            )}
          </div>
          );
        })()}
        <div className="start-row">
          <Button onClick={playModelTalk} disabled={modelState === "script" || modelState === "audio" || modelState === "playing"}>
            {modelState === "idle" && t.modelIdle}
            {modelState === "script" && t.modelScript}
            {modelState === "audio" && t.modelAudio}
            {modelState === "ready" && t.modelIdle}
            {modelState === "playing" && t.modelPlaying}
            {modelState === "error" && t.modelRetry}
          </Button>
          <Button variant="primary" onClick={() => startRound(0)}>
            {t.startRound1(t.min(minNum(roundsSec[0])))}
          </Button>
        </div>
        {modelText && (
          <details open>
            <summary className="text-muted">{t.modelTranscript}</summary>
            <p className="reading-text">{modelText}</p>
          </details>
        )}
        {prepState !== "error" && (errorMsg || playRow.error) && <Banner kind="error">{errorMsg || playRow.error}</Banner>}
      </div>
    );
  }

  if (phase.kind === "ae") {
    return (
      <Card header={t.aeTitle}>
        {aeLoading && <p>{t.aeLoading}</p>}
        {aeSkippedNoRecording && <p>{t.aeNoRecording}</p>}
        {ae && (
          <div>
            {ae.praise && <Banner kind="info">👏 {ae.praise}</Banner>}
            <ul>
              {ae.items.map((item, i) => (
                <AeItemView key={i} item={item} lang={props.lang} />
              ))}
            </ul>
          </div>
        )}
        {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
        <Button variant="primary" onClick={() => startRound(1)} disabled={aeLoading}>
          {t.startRound2(t.min(minNum(roundsSec[1])))}
        </Button>
      </Card>
    );
  }

  if (phase.kind === "done") {
    return (
      <Card>
        <p>{t.doneBody(roundsSec.length)}</p>
      </Card>
    );
  }

  return (
    <div className="round-stage">
      <h3>
        {t.roundHeading(roundIndex + 1, t.min(minNum(roundsSec[roundIndex])), props.topic.title)}
      </h3>
      <p className="text-muted">{LISTENERS[roundIndex % LISTENERS.length]}</p>
      <ul className="text-sm text-muted">
        {props.topic.hints.map((h, i) => (
          <li key={i}>{h}</li>
        ))}
      </ul>
      {prep && (() => {
        const filteredChunks = prep.chunks.filter((c) => typeof c.en === "string" && c.en);
        if (filteredChunks.length === 0) return null;
        const showJa = showJaFromPrep(support, prep);
        return (
          <details className="round-chunks">
            <summary className="text-sm text-muted">{t.roundChunksToggle}</summary>
            <ChunkList
              chunks={filteredChunks} playingIdx={playRow.playingKey} onPlay={(i, text) => playRow.play(i, text)} showJa={showJa}
              playAria={(en) => STR[props.lang].chunkList.playAria(en)}
            />
          </details>
        );
      })()}
      <div className={`round-timer${timer.expired ? " is-expired" : ""}`}>
        {formatMmSs(timer.remaining)} {timer.expired && <span className="text-sm">{t.timeUp}</span>}
      </div>
      <p className="text-sm text-muted">{t.roundTimeboxNote}</p>
      <div className="round-actions">
        <button
          className={`btn btn-primary btn-lg record-btn${recState === "recording" ? " is-recording" : ""}`}
          onClick={toggleRecording}
          disabled={recState === "transcribing"}
        >
          {recState === "recording" ? t.recStop : recState === "transcribing" ? t.recTranscribing : t.recStart}
        </button>
        <Button onClick={finishRound} disabled={recState === "transcribing"}>
          {t.roundFinish}
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

/** AE指摘1件。「もっと詳しく」で fetchFixExplanation を呼び、解説を自分の state に保持する */
function AeItemView({ item, lang }: { item: { quote: string; issue: string; better: string; why_ja: string }; lang: Lang }) {
  const t = STR[lang].ftt432;
  const { state, request } = useExplain(() => fetchFixExplanation(item.quote, item.better, item.issue));
  return (
    <li className="ae-item">
      {item.quote && (
        <div>
          <s>{item.quote}</s> → <strong>{item.better}</strong> <em>({item.issue})</em>
        </div>
      )}
      <div className="ae-why">{item.why_ja}</div>
      <ExplainBox
        state={state} request={request} showIdleButton={Boolean(item.quote && item.better)}
        labels={{ more: t.explainMore, loading: t.explainLoading, error: t.explainError, retry: t.retry }}
      />
    </li>
  );
}
