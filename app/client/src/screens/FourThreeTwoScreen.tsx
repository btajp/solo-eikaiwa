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
import { formatClientError } from "../lib/user-error";
import { resolveSttOutcome } from "../stt-result";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ChunkList } from "../ui/ChunkList";
import { CollectedPhrasesNotice } from "../ui/CollectedPhrasesNotice";
import { ExplainBox } from "../ui/ExplainBox";
import { LevelChip } from "../ui/LevelChip";
import { PlaybackButton } from "../ui/PlaybackButton";
import { RecordButton } from "../ui/RecordButton";
import { TimerChip } from "../ui/TimerChip";
import { canRevealJaFromHintDefault, getSupport, resolveSupport, useSupport } from "../support";
import { isDisclosureOpen, splitBilingualHint, toggleDisclosure } from "../support-disclosure";
import { canRetryAeFeedback } from "./aeFeedbackRetry";

/** メニュー params に roundsSec が無い場合（当日分の古いキャッシュ等）のフォールバック */
const DEFAULT_ROUNDS_SEC = [120, 90, 60];
const PREP_SECONDS = 180;

type Phase = { kind: "prep" } | { kind: "round"; index: number } | { kind: "ae" } | { kind: "done" };
type RecState = "idle" | "starting" | "recording" | "transcribing";
type PrepState = "loading" | "ready" | "error";

/**
 * スキャフォールド付き 4/3/2 流暢性ブロック。
 * 準備フェーズ（チャンク＋アウトライン＋モデル聴取）→ 同じ話を 2分→(AE)→1.5分→1分。
 * ラウンド秒数は menu params (roundsSec) が正で、流暢性の伸びに応じてサーバ側で較正する。
 */
export function FourThreeTwoScreen(props: {
  topic: ContentItem; sessionId: string; blockId: string; roundsSec?: number[];
  hintMode?: "ja" | "en"; modelTalkMode?: "auto" | "button";
  onBeforeRecord?: () => boolean;
  onReady?: () => void; onValidAttempt?: () => void;
  onOpenCollectedPhrases?: () => void;
  /** 全ラウンドとフィードバックを終え、親の次ブロック導線を出してよいときに通知する。 */
  onFlowComplete?: () => void;
  lang: Lang;
}) {
  const t = STR[props.lang].ftt432;
  const playback = STR[props.lang].playback;
  const support = useSupport();
  const disclosureKey = `${props.sessionId}:${props.topic.id}`;
  // モデルトークを事前準備するか: 個別トグル → メニューの stage 既定（auto か）で解決。
  // 事前準備は本文表示・音声再生を行わず、明示操作後の待ち時間だけを短縮する。
  const [preloadModelTalk] = useState(() =>
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
  const [jaRevealedFor, setJaRevealedFor] = useState<string | null>(null);
  // 準備フェーズ
  const [prepState, setPrepState] = useState<PrepState>("loading");
  const [prep, setPrep] = useState<PrepPack | null>(null);
  type ModelState = "idle" | "script" | "audio" | "ready" | "playing" | "error";
  const [modelState, setModelState] = useState<ModelState>(preloadModelTalk ? "script" : "idle");
  const [modelTalk, setModelTalk] = useState<{ disclosureKey: string; text: string } | null>(null);
  const visibleModelText = modelTalk?.disclosureKey === disclosureKey ? modelTalk.text : "";
  const topicHints = props.topic.hints.map(splitBilingualHint);
  const hintDefault = prep?.hintDefault ?? props.hintMode ?? "ja";
  const canRevealJa = canRevealJaFromHintDefault(support, hintDefault);
  const hasTopicJapaneseHints = topicHints.some((hint) => Boolean(hint.ja));
  const prepChunks = prep?.chunks.filter((chunk) => typeof chunk.en === "string" && chunk.en) ?? [];
  const hasPrepJapaneseHints = prepChunks.some((chunk) => Boolean(chunk.ja));
  const showJa = canRevealJa && isDisclosureOpen(jaRevealedFor, disclosureKey);
  const playRow = usePlayRow<number>();
  const prepFetchedRef = useRef(false); // StrictMode の二重マウントで prep を二重フェッチしない
  const readyNotifiedRef = useRef(false);
  const flowCompleteNotifiedRef = useRef(false);
  const prepTimer = useCountdown(PREP_SECONDS);
  const recorderRef = useRef(new Recorder());
  const roundStartedRef = useRef(false);
  const aliveRef = useRef(true);
  const roundIndexRef = useRef(0);
  const recStateRef = useRef<RecState>("idle");
  const stopInFlightRef = useRef(false);
  const finishInFlightRef = useRef(false);
  const modelPlaybackGenerationRef = useRef(0);
  const elapsedSecRef = useRef<number[]>(Array(roundsSec.length).fill(0));
  const segmentStartedAtRef = useRef(0);
  const timer = useCountdown(roundsSec[0], {
    onExpire: () => { void stopRecording(roundIndexRef.current, true); },
  });

  const roundIndex = phase.kind === "round" ? phase.index : 0;
  useEffect(() => { roundIndexRef.current = roundIndex; }, [roundIndex]);

  useEffect(() => {
    if (phase.kind !== "done" || flowCompleteNotifiedRef.current) return;
    flowCompleteNotifiedRef.current = true;
    props.onFlowComplete?.();
  }, [phase.kind, props.onFlowComplete]);

  function updateRecState(next: RecState) {
    recStateRef.current = next;
    setRecState(next);
  }

  useEffect(() => {
    aliveRef.current = true;
    if (!prepFetchedRef.current) {
      prepFetchedRef.current = true;
      loadPrep();
      if (preloadModelTalk) {
        prefetchModelTalkAudio(props.topic.id, (stage) => {
          if (aliveRef.current) setModelState(stage);
        })
          .then(() => {
            if (!aliveRef.current) return;
            setModelState("ready");
          })
          .catch(() => {
            if (aliveRef.current) setModelState("error");
          });
      }
    }
    return () => {
      const idx = roundIndexRef.current;
      const liveElapsed = recStateRef.current === "recording"
        ? Math.max(0.1, Math.round((performance.now() - segmentStartedAtRef.current) / 100) / 10)
        : 0;
      aliveRef.current = false;
      modelPlaybackGenerationRef.current++;
      recorderRef.current.cancel();
      stopPlayback();
      if (roundStartedRef.current) {
        roundStartedRef.current = false;
        sendSessionEvent("round_end", props.sessionId, {
          blockId: props.blockId,
          block: "four-three-two",
          round: idx + 1,
          aborted: true,
          transcript: transcriptsRef.current[idx],
          elapsedSec: elapsedSecRef.current[idx] + liveElapsed,
          ...(sttFailedRef.current[idx] ? { sttFailed: true } : {}),
        });
      }
    };
  }, []);

  // 教材の取得に成功するまでは、準備時間も親セッション時間も進めない。
  useEffect(() => {
    if (prepState !== "ready") return;
    if (!readyNotifiedRef.current) {
      readyNotifiedRef.current = true;
      props.onReady?.();
    }
    if (!prepTimer.expired && !prepTimer.running) prepTimer.start();
  }, [prepState, prepTimer, props.onReady]);

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
      setErrorMsg(formatClientError(props.lang, err, "load"));
      setPrepState("error");
    }
  }

  async function playModelTalk() {
    const generation = ++modelPlaybackGenerationRef.current;
    setErrorMsg("");
    try {
      const { text, blob } = await prefetchModelTalkAudio(props.topic.id, (stage) => {
        if (aliveRef.current) setModelState(stage);
      });
      if (!aliveRef.current || modelPlaybackGenerationRef.current !== generation) return;
      setModelTalk({ disclosureKey, text });
      setModelState("playing");
      try {
        await playBlob(blob);
      } finally {
        if (aliveRef.current && modelPlaybackGenerationRef.current === generation) setModelState("ready");
      }
    } catch (err) {
      if (!aliveRef.current || modelPlaybackGenerationRef.current !== generation) return;
      setErrorMsg(formatClientError(props.lang, err, "play"));
      setModelState("error");
    }
  }

  function stopModelTalk() {
    modelPlaybackGenerationRef.current++;
    stopPlayback();
    if (aliveRef.current) setModelState("ready");
  }

  async function toggleRecording() {
    setErrorMsg("");
    const index = roundIndexRef.current;
    if (recStateRef.current === "idle") {
      if (timer.expired) return;
      if (props.onBeforeRecord && !props.onBeforeRecord()) return;
      updateRecState("starting");
      try {
        stopPlayback();
        await recorderRef.current.start();
        if (!aliveRef.current || roundIndexRef.current !== index) {
          recorderRef.current.cancel();
          return;
        }
        segmentStartedAtRef.current = performance.now();
        updateRecState("recording");
        if (!timer.running && !timer.expired) {
          timer.start();
        }
        if (!roundStartedRef.current) {
          roundStartedRef.current = true;
          sendSessionEvent("round_start", props.sessionId, {
            blockId: props.blockId, block: "four-three-two", round: index + 1,
          });
        }
      } catch (err) {
        if (!aliveRef.current) return;
        setErrorMsg(formatClientError(props.lang, err, "record"));
        updateRecState("idle");
      }
      return;
    }
    if (recStateRef.current === "recording") await stopRecording(index);
  }

  async function stopRecording(index: number, fromExpiry = false): Promise<boolean> {
    if (recStateRef.current !== "recording" || stopInFlightRef.current || roundIndexRef.current !== index) return false;
    stopInFlightRef.current = true;
    updateRecState("transcribing");
    timer.pause();
    try {
      const { blob, durationSec } = await recorderRef.current.stopTimed();
      if (!aliveRef.current) return false;
      const outcome = await resolveSttOutcome(() => sttUpload(blob));
      if (!aliveRef.current || roundIndexRef.current !== index) return false;
      if (outcome.kind === "empty") {
        sttFailedRef.current[index] = true;
        setErrorMsg(t.notHeard);
        if (fromExpiry) timer.reset(roundsSec[index]);
        return false;
      }
      if (outcome.kind === "error") throw outcome.error;
      // 同一ラウンド内で失敗後に録り直して成功した場合、直前の失敗印を引きずらないよう解除する
      sttFailedRef.current[index] = false;
      elapsedSecRef.current[index] += durationSec;
      transcriptsRef.current[index] = [transcriptsRef.current[index], outcome.text]
        .filter(Boolean)
        .join(" ");
      setTranscripts([...transcriptsRef.current]);
      props.onValidAttempt?.();
      return true;
    } catch (err) {
      if (!aliveRef.current) return false;
      // STT呼び出しの失敗でtranscriptが空のままround_endが記録され得るため印を付ける
      // （技術障害を英語力の低さのシグナルとして扱わないため。サーバ側 fttOutputSignals で観測対象外にする）
      sttFailedRef.current[index] = true;
      setErrorMsg(formatClientError(props.lang, err, "record"));
      if (fromExpiry) timer.reset(roundsSec[index]);
      return false;
    } finally {
      stopInFlightRef.current = false;
      if (aliveRef.current && roundIndexRef.current === index) updateRecState("idle");
    }
  }

  async function finishRound() {
    if (finishInFlightRef.current) return;
    const index = roundIndexRef.current;
    if (recStateRef.current === "starting" || recStateRef.current === "transcribing") return;
    finishInFlightRef.current = true;
    try {
      if (recStateRef.current === "recording") {
        const transcribed = await stopRecording(index);
        if (!transcribed) return;
      }
      if (!aliveRef.current || roundIndexRef.current !== index) return;
      timer.pause();
      if (roundStartedRef.current) {
        roundStartedRef.current = false;
        sendSessionEvent("round_end", props.sessionId, {
          blockId: props.blockId,
          block: "four-three-two",
          round: index + 1,
          transcript: transcriptsRef.current[index],
          elapsedSec: elapsedSecRef.current[index],
          ...(sttFailedRef.current[index] ? { sttFailed: true } : {}),
        });
      }
      if (index === 0) {
        setPhase({ kind: "ae" });
        const transcript = transcriptsRef.current[0];
        if (!transcript.trim()) {
          setAeSkippedNoRecording(true);
          setAe(null);
        } else {
          setAeSkippedNoRecording(false);
          await requestAeFeedback(transcript);
        }
      } else if (index < roundsSec.length - 1) {
        startRound(index + 1);
      } else {
        setPhase({ kind: "done" });
      }
    } finally {
      finishInFlightRef.current = false;
    }
  }

  /**
   * Round 1 の transcript から AE フィードバックを要求する。失敗しても transcript は手元に
   * 残っているため、ae フェーズの再試行ボタンから同じ経路で再要求できる (#200)。
   */
  async function requestAeFeedback(transcript: string) {
    setErrorMsg("");
    setAeLoading(true);
    try {
      const feedback = await fetchAeFeedback(transcript, props.topic.title);
      if (!aliveRef.current) return;
      setAe(feedback);
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(formatClientError(props.lang, err, "request"));
    } finally {
      if (aliveRef.current) setAeLoading(false);
    }
  }

  function startRound(index: number) {
    if (props.onBeforeRecord && !props.onBeforeRecord()) return;
    roundIndexRef.current = index;
    updateRecState("idle");
    setPhase({ kind: "round", index });
    timer.reset(roundsSec[index]);
    roundStartedRef.current = false;
  }

  function toggleJaHints() {
    setJaRevealedFor((current) => toggleDisclosure(current, disclosureKey));
  }

  if (phase.kind === "prep") {
    return (
      <div className="stack">
        <Card header={t.prepTitle(props.topic.title)}>
          <LevelChip kind="auto" lang={props.lang} />
          {props.lang === "ja" && props.topic.titleJa && <p className="text-muted">{props.topic.titleJa}</p>}
          <p className="text-muted">
            {t.prepIntro(roundsSec.map(formatMmSs).join(" → "), roundsSec.length, formatMmSs(PREP_SECONDS))}
          </p>
          <p className="text-sm text-muted">{t.prepMicNote}</p>
          <p className="section-label">{t.prepTimerLabel}</p>
          <TimerChip
            remaining={prepTimer.remaining} expired={prepTimer.expired} note={t.prepTimerNote}
            ariaLabel={t.prepTimerAria(formatMmSs(prepTimer.remaining))}
          />
        </Card>
        {canRevealJa && (hasTopicJapaneseHints || hasPrepJapaneseHints) && (
          <Button variant="secondary" onClick={toggleJaHints}>
            {showJa ? t.hideJaHints : t.showJaHints}
          </Button>
        )}
        {topicHints.length > 0 && (
          <div className="text-muted"><ChunkList chunks={topicHints} playingIdx={null} showJa={showJa} /></div>
        )}
        {prepState === "loading" && <p className="text-muted">{t.loading}</p>}
        {prepState === "error" && (
          <Banner kind="error" action={<Button onClick={loadPrep}>{t.retry}</Button>}>
            {errorMsg}
          </Banner>
        )}
        {prepState === "ready" && prep && (() => {
          const filteredChunks = prepChunks;
          return (
          <div className="stack">
            {filteredChunks.length > 0 && (
              <>
                <ChunkList
                  chunks={filteredChunks} playingIdx={playRow.playingKey} onPlay={(i, text) => playRow.play(i, text)} showJa={showJa}
                  onStop={playRow.stop} stopLabel={playback.stop}
                  playAria={(en) => STR[props.lang].chunkList.playAria(en)}
                />
              </>
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
          <PlaybackButton
            playing={modelState === "playing"}
            onPlay={playModelTalk}
            onStop={stopModelTalk}
            disabled={modelState === "script" || modelState === "audio"}
            playLabel={
              modelState === "script" ? t.modelScript
                : modelState === "audio" ? t.modelAudio
                  : modelState === "error" ? t.modelRetry
                    : t.modelIdle
            }
            stopLabel={playback.stop}
          />
          <Button variant="primary" onClick={() => startRound(0)} disabled={prepState !== "ready"}>
            {t.startRound1(formatMmSs(roundsSec[0]))}
          </Button>
        </div>
        {visibleModelText && (
          <details>
            <summary className="text-muted">{t.modelTranscript}</summary>
            <p className="reading-text">{visibleModelText}</p>
          </details>
        )}
        {prepState !== "error" && (errorMsg || playRow.error) && (
          <Banner kind="error">{errorMsg || formatClientError(props.lang, playRow.error, "play")}</Banner>
        )}
      </div>
    );
  }

  if (phase.kind === "ae") {
    return (
      <Card header={t.aeTitle}>
        {aeLoading && <p className="text-muted">{t.aeLoading}</p>}
        {aeSkippedNoRecording && <p>{t.aeNoRecording}</p>}
        {ae && (
          <div>
            {ae.praise && <Banner kind="info">👏 {ae.praise}</Banner>}
            <ul>
              {ae.items.map((item, i) => (
                <AeItemView key={i} item={item} lang={props.lang} />
              ))}
            </ul>
            <CollectedPhrasesNotice summary={ae} lang={props.lang} onOpen={props.onOpenCollectedPhrases} />
          </div>
        )}
        {errorMsg && (
          <Banner
            kind="error"
            action={
              canRetryAeFeedback({ errorMsg, aeLoading, transcript: transcriptsRef.current[0] ?? "" }) ? (
                <Button onClick={() => void requestAeFeedback(transcriptsRef.current[0])} disabled={aeLoading}>
                  {t.aeRetry}
                </Button>
              ) : undefined
            }
          >
            {errorMsg}
          </Banner>
        )}
        <Button variant="primary" onClick={() => startRound(1)} disabled={aeLoading}>
          {t.startRound2(formatMmSs(roundsSec[1]))}
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
        {t.roundHeading(roundIndex + 1, formatMmSs(roundsSec[roundIndex]), props.topic.title)}
      </h3>
      <p className="text-muted">{t.listeners[roundIndex % t.listeners.length]}</p>
      {canRevealJa && (hasTopicJapaneseHints || hasPrepJapaneseHints) && (
        <Button variant="secondary" onClick={toggleJaHints}>
          {showJa ? t.hideJaHints : t.showJaHints}
        </Button>
      )}
      {topicHints.length > 0 && (
        <div className="text-sm text-muted"><ChunkList chunks={topicHints} playingIdx={null} showJa={showJa} /></div>
      )}
      {prep && (() => {
        const filteredChunks = prepChunks;
        if (filteredChunks.length === 0) return null;
        return (
          <details className="round-chunks">
            <summary className="text-sm text-muted">{t.roundChunksToggle}</summary>
            <ChunkList
              chunks={filteredChunks} playingIdx={playRow.playingKey} onPlay={(i, text) => playRow.play(i, text)} showJa={showJa}
              onStop={playRow.stop} stopLabel={playback.stop}
              playAria={(en) => STR[props.lang].chunkList.playAria(en)}
            />
          </details>
        );
      })()}
      <div
        className={`round-timer${timer.expired ? " is-expired" : ""}`}
        role="timer"
        aria-label={t.roundTimerAria(roundIndex + 1, formatMmSs(timer.remaining))}
      >
        {formatMmSs(timer.remaining)} {timer.expired && <span className="text-sm">{t.timeUp}</span>}
      </div>
      <p className="text-sm text-muted">{t.roundTimeboxNote}</p>
      <div className="round-actions">
        <RecordButton
          onClick={toggleRecording}
          disabled={recState === "starting" || recState === "transcribing" || (timer.expired && recState === "idle")}
          recording={recState === "recording"}
        >
          {recState === "recording"
            ? t.recStop
            : recState === "starting"
              ? t.recStarting
              : recState === "transcribing"
              ? t.recTranscribing
              : t.recStart}
        </RecordButton>
        <Button onClick={finishRound} disabled={recState === "starting" || recState === "transcribing"}>
          {t.roundFinish}
        </Button>
      </div>
      {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      {transcripts[roundIndex] && (
        <Card className="reading-text">
          <strong>{t.transcriptYou}</strong> {transcripts[roundIndex]}
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
