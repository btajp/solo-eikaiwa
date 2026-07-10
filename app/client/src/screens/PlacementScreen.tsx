import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  confirmPlacement, fetchPlacementTasks, fetchUtteranceTranslation, sttUpload, submitPlacement,
  type PlacementResult, type PlacementTaskDef,
} from "../api";
import { Recorder, stopPlayback } from "../audio";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { placementRecordingAction } from "../recording-controls";
import { resolveSttOutcome } from "../stt-result";
import { formatMmSs, useCountdown } from "../useCountdown";
import { useExplain } from "../useExplain";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FlowExitButton } from "../ui/FlowExitButton";
import { RecordButton } from "../ui/RecordButton";
import { TimerChip } from "../ui/TimerChip";
import { validatePlacementLevel } from "./placement-level";

type Step =
  | { kind: "loading" }
  | { kind: "load-error"; message: string }
  | { kind: "intro" }
  | { kind: "task"; index: number }
  | { kind: "submitting" }
  | { kind: "submit-error"; message: string }
  | { kind: "result"; result: PlacementResult };
type RecState = "idle" | "starting" | "recording" | "transcribing";

function wordCountOf(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * プレースメント測定（スペック§6）: 3タスクを順に録音→STT→全件そろったら評価に送る。
 * 結果は利用者が確定操作をするまでレベルに反映しない（研究制約§2）。
 */
export function PlacementScreen(props: { lang: Lang; onBeforeStart?: () => boolean; onExit: () => void }) {
  const t = STR[props.lang].placement;
  const [step, setStep] = useState<Step>({ kind: "loading" });
  const [tasks, setTasks] = useState<PlacementTaskDef[]>([]);
  const [recState, setRecState] = useState<RecState>("idle");
  const [transcripts, setTranscripts] = useState<string[]>([]);
  const [durations, setDurations] = useState<number[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  // 結果画面の確定操作
  const [choosing, setChoosing] = useState(false);
  const [chooseValue, setChooseValue] = useState("");
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState(false);
  const [appliedLevel, setAppliedLevel] = useState<number | null>(null);

  const recorderRef = useRef(new Recorder());
  const recStateRef = useRef<RecState>("idle");
  const stopInFlightRef = useRef(false);
  const activeTaskIndexRef = useRef(0);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);
  const timer = useCountdown(60, {
    onExpire: () => { void stopRecording(activeTaskIndexRef.current, true); },
  });

  function updateRecState(next: RecState) {
    recStateRef.current = next;
    setRecState(next);
  }

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      loadTasks();
    }
    return () => {
      aliveRef.current = false;
      recorderRef.current.cancel();
      stopPlayback();
    };
  }, []);

  async function loadTasks() {
    setStep({ kind: "loading" });
    try {
      const defs = await fetchPlacementTasks();
      if (!aliveRef.current) return;
      setTasks(defs);
      setTranscripts(Array(defs.length).fill(""));
      setDurations(Array(defs.length).fill(0));
      setStep({ kind: "intro" });
    } catch (err) {
      if (!aliveRef.current) return;
      setStep({ kind: "load-error", message: formatClientError(props.lang, err, "load") });
    }
  }

  function startTask(index: number) {
    if (props.onBeforeStart && !props.onBeforeStart()) return;
    setErrorMsg("");
    activeTaskIndexRef.current = index;
    updateRecState("idle");
    timer.reset(tasks[index].durationSec);
    setStep({ kind: "task", index });
  }

  async function toggleRecording(index: number) {
    setErrorMsg("");
    if (recStateRef.current === "idle") {
      if (props.onBeforeStart && !props.onBeforeStart()) return;
      activeTaskIndexRef.current = index;
      updateRecState("starting");
      try {
        await recorderRef.current.start();
        if (!aliveRef.current || activeTaskIndexRef.current !== index) {
          recorderRef.current.cancel();
          return;
        }
        updateRecState("recording");
        if (!timer.running && !timer.expired) timer.start();
      } catch (err) {
        if (!aliveRef.current) return;
        setErrorMsg(formatClientError(props.lang, err, "record"));
        updateRecState("idle");
      }
      return;
    }
    if (recStateRef.current === "recording") await stopRecording(index);
  }

  async function stopRecording(index: number, fromExpiry = false) {
    if (recStateRef.current !== "recording" || stopInFlightRef.current) return;
    stopInFlightRef.current = true;
    updateRecState("transcribing");
    timer.pause();
    try {
      const { blob, durationSec } = await recorderRef.current.stopTimed();
      if (!aliveRef.current) return;
      const outcome = await resolveSttOutcome(() => sttUpload(blob));
      if (!aliveRef.current || activeTaskIndexRef.current !== index) return;
      if (outcome.kind === "empty") {
        setErrorMsg(t.notHeard);
        if (fromExpiry) timer.reset(tasks[index]?.durationSec ?? 60);
        updateRecState("idle");
        return;
      }
      if (outcome.kind === "error") throw outcome.error;
      const text = outcome.text;
      // 測定なので録り直しは「置き換え」（追記しない）
      setTranscripts((prev) => prev.map((v, i) => (i === index ? text : v)));
      setDurations((prev) => prev.map((v, i) => (i === index ? durationSec : v)));
      updateRecState("idle");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(formatClientError(props.lang, err, "record"));
      if (fromExpiry) timer.reset(tasks[index]?.durationSec ?? 60);
      updateRecState("idle");
    } finally {
      stopInFlightRef.current = false;
    }
  }

  function redo(index: number) {
    setTranscripts((prev) => prev.map((v, i) => (i === index ? "" : v)));
    setDurations((prev) => prev.map((v, i) => (i === index ? 0 : v)));
    timer.reset(tasks[index].durationSec);
  }

  async function submitAll() {
    setStep({ kind: "submitting" });
    try {
      const result = await submitPlacement(tasks.map((def, i) => ({
        taskId: def.id,
        transcript: transcripts[i],
        durationSec: durations[i],
        wordCount: wordCountOf(transcripts[i]),
      })));
      if (!aliveRef.current) return;
      setStep({ kind: "result", result });
    } catch (err) {
      if (!aliveRef.current) return;
      setStep({ kind: "submit-error", message: formatClientError(props.lang, err, "submit") });
    }
  }

  async function confirm(accept: boolean, level?: number) {
    setConfirmBusy(true);
    setConfirmError(false);
    try {
      await confirmPlacement(accept, level);
      if (!aliveRef.current) return;
      if (accept && level !== undefined) {
        setAppliedLevel(level);
        setChoosing(false);
      } else {
        exitPlacement();
      }
    } catch (err) {
      if (!aliveRef.current) return;
      console.warn("placement confirm failed:", err);
      setConfirmError(true);
    } finally {
      if (aliveRef.current) setConfirmBusy(false);
    }
  }

  function exitPlacement() {
    timer.pause();
    recorderRef.current.cancel();
    stopPlayback();
    props.onExit();
  }

  function placementFrame(children: ReactNode, warnBeforeExit = true) {
    return (
      <div className="stack">
        <FlowExitButton onClick={exitPlacement}>{STR[props.lang].appShell.backToHome}</FlowExitButton>
        <div className="hero"><h2 className="hero-title">{t.introTitle}</h2></div>
        {warnBeforeExit && <p className="text-sm text-muted">{t.exitNote}</p>}
        {children}
      </div>
    );
  }

  if (step.kind === "loading") return placementFrame(<p className="text-muted">{t.loading}</p>, false);

  if (step.kind === "load-error") {
    return placementFrame(
      <Banner kind="error" action={<Button onClick={loadTasks}>{t.loadRetry}</Button>}>
        {step.message}
      </Banner>,
      false,
    );
  }

  if (step.kind === "intro") {
    return placementFrame(
      <div className="stack">
        <Card>
          <p className="text-muted">{t.introBody}</p>
          <p className="text-sm text-muted">{t.xpNote}</p>
        </Card>
        <Button variant="primary" size="lg" onClick={() => startTask(0)}>{t.introStart}</Button>
      </div>,
    );
  }

  if (step.kind === "task") {
    const i = step.index;
    const def = tasks[i];
    const instruction = props.lang === "ja" ? def.instructionJa : def.instructionEn;
    const hasAnswer = transcripts[i].trim().length > 0;
    const recordingAction = placementRecordingAction(hasAnswer);
    const isLast = i === tasks.length - 1;
    return placementFrame(
      <div className="stack">
        <Card header={`${t.taskLabel(i + 1, tasks.length)} — ${instruction}`}>
          <p className="text-sm text-muted">{t.promptLabel}:</p>
          <p className="reading-text">{def.promptText}</p>
          <PlacementPrompt key={def.id} text={def.promptText} lang={props.lang} />
          <TimerChip remaining={timer.remaining} expired={timer.expired} />
        </Card>
        <div className="start-row">
          <RecordButton
            onClick={() => toggleRecording(i)}
            disabled={recState === "starting" || recState === "transcribing"}
            recording={recState === "recording"}
          >
            {recState === "recording"
              ? t.recordStop
              : recState === "starting"
                ? t.recordStarting
                : recState === "transcribing"
                  ? t.transcribing
                  : recordingAction === "replace" ? t.recordReplace : t.recordStart}
          </RecordButton>
          {hasAnswer && recState === "idle" && (
            <Button onClick={() => redo(i)}>{t.redo}</Button>
          )}
          {hasAnswer && recState === "idle" && (
            <Button variant="primary" onClick={() => (isLast ? submitAll() : startTask(i + 1))}>
              {isLast ? t.submit : t.next}
            </Button>
          )}
        </div>
        {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
        {hasAnswer && (
          <Card header={t.yourAnswer}>
            <p className="reading-text">{transcripts[i]}</p>
          </Card>
        )}
      </div>,
    );
  }

  if (step.kind === "submitting") {
    return placementFrame(<p>{t.submitting}</p>);
  }

  if (step.kind === "submit-error") {
    return placementFrame(
      <div className="stack">
        <Banner kind="error">{t.submitError}</Banner>
        <p className="text-sm text-muted">{step.message}</p>
        <Button variant="primary" onClick={submitAll}>{t.retry}</Button>
      </div>,
    );
  }

  // result
  const { result } = step;
  const choiceValidation = validatePlacementLevel(chooseValue);
  const choiceError = !choiceValidation.valid ? t.chooseInputError(choiceValidation.reason) : null;
  return placementFrame(
    <div className="stack">
      <Card header={t.resultTitle}>
        <p><strong>{t.resultStage(result.stage)}</strong></p>
        <p className="text-sm text-muted">{t.stageLevelNote(result.stage, result.startLevel)}</p>
        <p className="reading-text">{result.rationale}</p>
        <p className="text-sm text-muted">{t.xpNote}</p>
      </Card>
      {confirmError && <Banner kind="error">{t.confirmError}</Banner>}
      {appliedLevel !== null ? (
        <>
          <Banner kind="info">{t.levelApplied(appliedLevel)}</Banner>
          <div className="round-actions">
            <Button variant="primary" size="lg" onClick={exitPlacement}>{STR[props.lang].appShell.backToHome}</Button>
          </div>
        </>
      ) : !choosing ? (
        <div className="start-row">
          <Button variant="primary" onClick={() => confirm(true, result.startLevel)} disabled={confirmBusy}>
            {t.resultStartAt(result.startLevel)}
          </Button>
          <Button onClick={() => { setChooseValue(String(result.startLevel)); setChoosing(true); }} disabled={confirmBusy}>
            {t.chooseOwn}
          </Button>
          <Button variant="ghost" onClick={() => confirm(false)} disabled={confirmBusy}>{t.notNow}</Button>
        </div>
      ) : (
        <div className="stack">
          <p id="placement-level-help" className="text-sm text-muted">{t.chooseInputHelp}</p>
          <div className="start-row">
            <label className="text-sm text-muted">
              {t.chooseLabel}{" "}
              <input
                className="level-input" type="number" min={1} max={999} step={1} value={chooseValue} autoFocus
                onChange={(e) => setChooseValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && choiceValidation.valid) void confirm(true, choiceValidation.level);
                  else if (e.key === "Escape") setChoosing(false);
                }}
                aria-invalid={!choiceValidation.valid}
                aria-describedby={choiceError ? "placement-level-help placement-level-error" : "placement-level-help"}
              />
            </label>
            <Button
              variant="primary"
              onClick={() => { if (choiceValidation.valid) void confirm(true, choiceValidation.level); }}
              disabled={confirmBusy || !choiceValidation.valid}
            >
              {t.apply}
            </Button>
            <Button variant="ghost" onClick={() => setChoosing(false)} disabled={confirmBusy}>{t.cancel}</Button>
          </div>
          {choiceError && <p id="placement-level-error" className="level-edit-error" role="alert">{choiceError}</p>}
        </div>
      )}
      {appliedLevel === null && <p className="text-sm text-muted">{t.applyTiming}</p>}
    </div>,
    false,
  );
}

/** お題本文の日本語訳トグル（ユーザー起点のみ・translate エンドポイント流用）。低ステージ受験者向けの補助。 */
function PlacementPrompt({ text, lang }: { text: string; lang: Lang }) {
  const t = STR[lang].placement;
  const { state, request } = useExplain(() => fetchUtteranceTranslation(text));
  return (
    <div className="chat-translate">
      {state.status === "idle" && (
        <Button variant="ghost" onClick={request}>{t.showPromptJa}</Button>
      )}
      {state.status === "loading" && <p className="text-sm text-muted">{t.translating}</p>}
      {state.status === "error" && (
        <p className="text-sm text-muted">{t.translateError}<Button variant="ghost" onClick={request}>{t.retryTranslate}</Button></p>
      )}
      {state.status === "done" && <p className="sentence-explain text-sm">{state.text}</p>}
    </div>
  );
}
