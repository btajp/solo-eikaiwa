import { useEffect, useRef, useState } from "react";
import {
  fetchMenu, fetchQuickMenu, progressBlockAbort, progressBlockStart, progressBlockXp, sendSessionEvent,
  type Menu, type MenuBlock, type QuickDrillKind, type RoleplayDomain,
} from "../api";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { formatMmSs, useCountdown } from "../useCountdown";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { FlowExitButton } from "../ui/FlowExitButton";
import { ProgressDots, Screen } from "../ui/Screen";
import { TimerChip } from "../ui/TimerChip";
import { FourThreeTwoScreen } from "./FourThreeTwoScreen";
import { ReflectionScreen } from "./ReflectionScreen";
import { RoleplayScreen } from "./RoleplayScreen";
import { ShadowingScreen } from "./ShadowingScreen";
import { WarmupReadingScreen } from "./WarmupReadingScreen";
import { blockTitle } from "./blockTitle";
import { FeedbackRow } from "../ui/FeedbackRow";
import {
  completionRequest,
  makeSessionCoordinator,
  retainFailedCompletion,
  type OpenBlockHandle,
  type PendingCompletion,
} from "./sessionCoordinator";
import {
  blockCompletionGate,
  initialBlockProgress,
  markBlockReady,
  markValidAttempt,
  requiresInternalCompletion,
} from "./sessionBlockProgress";

export type MenuSource =
  | { type: "daily"; minutes: 60 | 30 }
  | { type: "quick"; drill: QuickDrillKind; domain?: RoleplayDomain };

/** セッション種別を feedback の refId に使う短い署名にする（例: daily-60 / quick-shadowing / quick-roleplay-daily）。 */
function sourceSignature(src: MenuSource): string {
  if (src.type === "daily") return `daily-${src.minutes}`;
  return `quick-${src.drill}${src.domain ? `-${src.domain}` : ""}`;
}

/** メニューを取得し、ブロックを順番に進行させる。ブロックタイマーと進行イベント記録を持つ */
export function SessionRunner(props: {
  source: MenuSource; sessionId: string; lang: Lang; onExit: () => void; onBeforeRecording?: () => boolean;
  onOpenCollectedPhrases?: () => void;
}) {
  const t = STR[props.lang].session;
  const [menu, setMenu] = useState<Menu | null>(null);
  const [index, setIndex] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const timer = useCountdown(0);
  const [done, setDone] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [failedCompletions, setFailedCompletions] = useState<PendingCompletion[]>([]);
  const [retryingCompletion, setRetryingCompletion] = useState<string | null>(null);
  const [blockProgress, setBlockProgress] = useState(initialBlockProgress);
  const [internalFlowComplete, setInternalFlowComplete] = useState(false);
  const retryingRef = useRef(false);
  const coordinatorRef = useRef(makeSessionCoordinator());
  const blockProgressRef = useRef(initialBlockProgress());
  const generationRef = useRef(0);
  const aliveRef = useRef(true);

  function beginAttempt(kind: string): Promise<number | null> {
    return progressBlockStart(kind).catch((err) => {
      console.warn("block-start failed:", err);
      return null;
    });
  }

  function loadMenu() {
    const generation = coordinatorRef.current.beginGeneration();
    generationRef.current = generation;
    setErrorMsg("");
    const fetching = props.source.type === "daily"
      ? fetchMenu(props.source.minutes)
      : fetchQuickMenu(props.source.drill, props.source.domain);
    fetching
      .then((m) => {
        if (!coordinatorRef.current.isCurrent(generation)) return;
        setMenu(m);
        resetBlockProgress();
      })
      .catch((err) => {
        if (coordinatorRef.current.isCurrent(generation)) {
          setErrorMsg(formatClientError(props.lang, err, "load"));
        }
      });
  }

  useEffect(() => {
    aliveRef.current = true;
    loadMenu();
    return () => {
      aliveRef.current = false;
      coordinatorRef.current.invalidateGeneration();
      const open = coordinatorRef.current.takeOpen();
      if (!open) return;
      sendSessionEvent("block_end", props.sessionId, { blockId: open.id, kind: open.kind, aborted: true });
      open.attemptId.then((attemptId) => {
        if (attemptId !== null) {
          progressBlockAbort(attemptId, open.kind).catch((err) => console.warn("block-abort failed:", err));
        }
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // state遷移が描画されるまで同期guardは閉じたままにし、同一render内の連打を拒否する。
    setAdvancing(false);
  }, [index, done]);

  async function postCompletion(pending: PendingCompletion): Promise<void> {
    try {
      await progressBlockXp(pending);
      if (aliveRef.current) {
        setFailedCompletions((items) => items.filter((item) => item.completionId !== pending.completionId));
      }
    } catch (err) {
      console.warn("xp post failed:", err);
      if (aliveRef.current) {
        setFailedCompletions((items) => retainFailedCompletion(items, pending));
      }
    }
  }

  async function completeHandle(handle: OpenBlockHandle): Promise<void> {
    const attemptId = await handle.attemptId;
    await postCompletion(completionRequest(handle, attemptId));
  }

  async function retryCompletion(pending: PendingCompletion): Promise<void> {
    if (retryingRef.current) return;
    retryingRef.current = true;
    setRetryingCompletion(pending.completionId);
    await postCompletion(pending);
    retryingRef.current = false;
    if (aliveRef.current) setRetryingCompletion(null);
  }

  const failed = failedCompletions[0];
  const completionNotice = failed ? (
    <Banner
      kind="info"
      action={<Button onClick={() => retryCompletion(failed)} disabled={retryingCompletion !== null}>
        {retryingCompletion === failed.completionId ? t.xpRetrying : t.xpRetry}
      </Button>}
    >
      {t.xpSaveFailed}
    </Banner>
  ) : null;
  const exitButton = <FlowExitButton onClick={props.onExit}>{STR[props.lang].appShell.backToHome}</FlowExitButton>;

  if (errorMsg) {
    return (
      <div className="screen stack">
        {exitButton}
        <Banner kind="error" action={<Button onClick={loadMenu}>{t.retry}</Button>}>{errorMsg}</Banner>
      </div>
    );
  }
  if (!menu) {
    return <div className="screen stack">{exitButton}<p className="text-muted">{t.building}</p></div>;
  }

  if (done) {
    return (
      <div className="screen stack fade-in">
        {exitButton}
        {completionNotice}
        <p className="text-muted">{t.doneSummary}</p>
        <FeedbackRow context={{ blockKind: "session", refId: sourceSignature(props.source) }} lang={props.lang} />
        <div className="round-actions">
          <Button variant="primary" size="lg" onClick={props.onExit}>{t.doneExit}</Button>
        </div>
      </div>
    );
  }

  const block = menu.blocks[index];
  const isLast = index === menu.blocks.length - 1;
  const completionGate = blockCompletionGate(blockProgress);
  const hasInternalFlow = requiresInternalCompletion(block.kind);
  const showOuterCompletion = !hasInternalFlow || internalFlowComplete;

  function resetBlockProgress() {
    const initial = initialBlockProgress();
    blockProgressRef.current = initial;
    setBlockProgress(initial);
    setInternalFlowComplete(false);
  }

  function reportBlockReady(blockId: string) {
    if (blockId !== block.id) return;
    const next = markBlockReady(blockProgressRef.current);
    blockProgressRef.current = next;
    setBlockProgress(next);
    if (!coordinatorRef.current.open(block, () => beginAttempt(block.kind), generationRef.current)) return;
    timer.reset(block.minutes * 60);
    timer.start();
    sendSessionEvent("block_start", props.sessionId, { blockId: block.id, kind: block.kind });
  }

  function reportValidAttempt(blockId: string) {
    if (blockId !== block.id) return;
    const next = markValidAttempt(blockProgressRef.current);
    blockProgressRef.current = next;
    setBlockProgress(next);
  }

  function reportInternalFlowComplete(blockId: string) {
    if (blockId !== block.id) return;
    setInternalFlowComplete(true);
  }

  function nextBlock() {
    if (!showOuterCompletion || completionGate !== "ready") return;
    const open = coordinatorRef.current.take(block.id);
    if (!open) return;
    setAdvancing(true);
    sendSessionEvent("block_end", props.sessionId, { blockId: block.id, kind: block.kind, completed: true });
    void completeHandle(open);
    if (isLast) {
      timer.pause();
      setDone(true);
      return;
    }
    resetBlockProgress();
    setIndex(index + 1);
    timer.reset(0);
  }

  return (
    <div className="screen stack">
      {exitButton}
      <Screen
        title={blockTitle(block, props.lang)}
        meta={
          <>
            <ProgressDots current={index} total={menu.blocks.length} label={t.blockAria(index, menu.blocks.length)} />
            {blockProgress.ready && !hasInternalFlow && <TimerChip remaining={timer.remaining} expired={timer.expired} note={t.timerNote} />}
          </>
        }
      >
        {completionNotice}
        {/* v0.26 wave5: rotation の情報的注記。ラウンドロビン振替・帯域緩和で選ばれたときだけ出す中立な一文（警告調ではない） */}
        {block.fallback && <Banner kind="info">{t.fallbackNote}</Banner>}
        {hasInternalFlow && <p className="text-sm text-muted">{t.blockEstimate(formatMmSs(block.minutes * 60))}</p>}
        <div key={block.id} className="fade-in">
          <BlockBody
            block={block} sessionId={props.sessionId} lang={props.lang}
            onBeforeRecording={props.onBeforeRecording}
            onReady={() => reportBlockReady(block.id)}
            onValidAttempt={() => reportValidAttempt(block.id)}
            onInternalFlowComplete={() => reportInternalFlowComplete(block.id)}
            onOpenCollectedPhrases={props.onOpenCollectedPhrases}
          />
        </div>
        {showOuterCompletion && <>
          {completionGate !== "ready" && <Banner kind="info">{
            completionGate === "preparing" ? t.preparingBlock : t.completeAfterAttempt
          }</Banner>}
          <div className="text-sm text-muted">{t.leaveBeforeComplete}</div>
          <div className="round-actions">
            <Button variant="primary" size="lg" onClick={nextBlock} disabled={advancing || completionGate !== "ready"}>
              {isLast ? t.finish : t.next}
            </Button>
          </div>
        </>}
      </Screen>
    </div>
  );
}

function BlockBody({
  block, sessionId, lang, onBeforeRecording, onReady, onValidAttempt, onInternalFlowComplete, onOpenCollectedPhrases,
}: {
  block: MenuBlock; sessionId: string; lang: Lang; onBeforeRecording?: () => boolean;
  onReady: () => void; onValidAttempt: () => void;
  onInternalFlowComplete: () => void;
  onOpenCollectedPhrases?: () => void;
}) {
  switch (block.kind) {
    case "warmup-reading":
      return block.params.topic ? <WarmupReadingScreen topic={block.params.topic} sessionId={sessionId} hintMode={block.params.hintMode} lang={lang} onReady={onReady} onValidAttempt={onValidAttempt} /> : <p>{STR[lang].session.noTopic}</p>;
    case "four-three-two":
      return block.params.topic ? (
        <FourThreeTwoScreen
          topic={block.params.topic} sessionId={sessionId} blockId={block.id}
          roundsSec={block.params.roundsSec} hintMode={block.params.hintMode} modelTalkMode={block.params.modelTalkMode}
          onBeforeRecord={onBeforeRecording} lang={lang} onReady={onReady} onValidAttempt={onValidAttempt}
          onFlowComplete={onInternalFlowComplete} onOpenCollectedPhrases={onOpenCollectedPhrases}
        />
      ) : (
        <p>{STR[lang].session.noTopic}</p>
      );
    case "roleplay":
      return block.params.scenario
        ? <RoleplayScreen
            scenario={block.params.scenario} sessionId={sessionId} lang={lang}
            onBeforeRecord={onBeforeRecording} onReady={onReady} onValidAttempt={onValidAttempt}
          />
        : <p>{STR[lang].session.noScenario}</p>;
    case "shadowing":
      return block.params.topic ? <ShadowingScreen topic={block.params.topic} lang={lang} sessionId={sessionId} blockId={block.id} onReady={onReady} onValidAttempt={onValidAttempt} /> : <p>{STR[lang].session.noTopic}</p>;
    case "reflection":
      return <ReflectionScreen sessionId={sessionId} lang={lang} onReady={onReady} onValidAttempt={onValidAttempt} onOpenCollectedPhrases={onOpenCollectedPhrases} />;
    default:
      return <p>{STR[lang].session.unknownBlock(block.kind)}</p>;
  }
}
