import { useEffect, useRef, useState } from "react";
import {
  fetchMenu, fetchQuickMenu, progressBlockAbort, progressBlockStart, progressBlockXp, sendSessionEvent,
  type Menu, type MenuBlock, type QuickDrillKind, type RoleplayDomain,
} from "../api";
import { STR, type Lang } from "../i18n";
import { useCountdown } from "../useCountdown";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { ProgressDots, Screen } from "../ui/Screen";
import { TimerChip } from "../ui/TimerChip";
import { ChunkPlaceholderScreen } from "./ChunkPlaceholderScreen";
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

export type MenuSource =
  | { type: "daily"; minutes: 60 | 30 }
  | { type: "quick"; drill: QuickDrillKind; domain?: RoleplayDomain };

/** セッション種別を feedback の refId に使う短い署名にする（例: daily-60 / quick-shadowing / quick-roleplay-daily）。 */
function sourceSignature(src: MenuSource): string {
  if (src.type === "daily") return `daily-${src.minutes}`;
  return `quick-${src.drill}${src.domain ? `-${src.domain}` : ""}`;
}

/** メニューを取得し、ブロックを順番に進行させる。ブロックタイマーと進行イベント記録を持つ */
export function SessionRunner(props: { source: MenuSource; sessionId: string; lang: Lang; onExit: () => void }) {
  const t = STR[props.lang].session;
  const [menu, setMenu] = useState<Menu | null>(null);
  const [index, setIndex] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const timer = useCountdown(0);
  const [done, setDone] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [failedCompletions, setFailedCompletions] = useState<PendingCompletion[]>([]);
  const [retryingCompletion, setRetryingCompletion] = useState<string | null>(null);
  const retryingRef = useRef(false);
  const coordinatorRef = useRef(makeSessionCoordinator());
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
        const first = m.blocks[0];
        if (!coordinatorRef.current.open(first, () => beginAttempt(first.kind), generation)) return;
        timer.reset(first.minutes * 60);
        timer.start();
        sendSessionEvent("block_start", props.sessionId, { blockId: first.id, kind: first.kind });
      })
      .catch((err) => {
        if (coordinatorRef.current.isCurrent(generation)) {
          setErrorMsg(err instanceof Error ? err.message : String(err));
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

  if (errorMsg) {
    return (
      <div>
        <Banner kind="error" action={<Button onClick={loadMenu}>{t.retry}</Button>}>{errorMsg}</Banner>
      </div>
    );
  }
  if (!menu) return <p className="text-muted">{t.building}</p>;

  if (done) {
    return (
      <div className="stack fade-in">
        {completionNotice}
        <FeedbackRow context={{ blockKind: "session", refId: sourceSignature(props.source) }} lang={props.lang} />
        <div className="round-actions">
          <Button variant="primary" size="lg" onClick={props.onExit}>{t.doneExit}</Button>
        </div>
      </div>
    );
  }

  const block = menu.blocks[index];
  const isLast = index === menu.blocks.length - 1;

  function nextBlock() {
    const open = coordinatorRef.current.take(block.id);
    if (!open) return;
    setAdvancing(true);
    sendSessionEvent("block_end", props.sessionId, { blockId: block.id, kind: block.kind });
    void completeHandle(open);
    if (isLast) {
      setDone(true);
      return;
    }
    const next = menu!.blocks[index + 1];
    setIndex(index + 1);
    timer.reset(next.minutes * 60);
    timer.start();
    if (coordinatorRef.current.open(next, () => beginAttempt(next.kind), generationRef.current)) {
      sendSessionEvent("block_start", props.sessionId, { blockId: next.id, kind: next.kind });
    }
  }

  return (
    <Screen
      title={blockTitle(block, props.lang)}
      meta={
        <>
          <ProgressDots current={index} total={menu.blocks.length} label={t.blockAria(index, menu.blocks.length)} />
          <TimerChip remaining={timer.remaining} expired={timer.expired} note={t.timerNote} />
        </>
      }
    >
      {completionNotice}
      {/* v0.26 wave5: rotation の情報的注記。ラウンドロビン振替・帯域緩和で選ばれたときだけ出す中立な一文（警告調ではない） */}
      {block.fallback && <Banner kind="info">{t.fallbackNote}</Banner>}
      <div key={block.id} className="fade-in">
        <BlockBody block={block} sessionId={props.sessionId} lang={props.lang} />
      </div>
      <div className="round-actions">
        <Button variant="primary" size="lg" onClick={nextBlock} disabled={advancing}>
          {isLast ? t.finish : t.next}
        </Button>
      </div>
    </Screen>
  );
}

function BlockBody({ block, sessionId, lang }: { block: MenuBlock; sessionId: string; lang: Lang }) {
  switch (block.kind) {
    case "chunk-placeholder":
      return <ChunkPlaceholderScreen />;
    case "warmup-reading":
      return block.params.topic ? <WarmupReadingScreen topic={block.params.topic} lang={lang} /> : <p>{STR[lang].session.noTopic}</p>;
    case "four-three-two":
      return block.params.topic ? (
        <FourThreeTwoScreen
          topic={block.params.topic} sessionId={sessionId} blockId={block.id}
          roundsSec={block.params.roundsSec} modelTalkMode={block.params.modelTalkMode} lang={lang}
        />
      ) : (
        <p>{STR[lang].session.noTopic}</p>
      );
    case "roleplay":
      return block.params.scenario ? <RoleplayScreen scenario={block.params.scenario} lang={lang} /> : <p>{STR[lang].session.noScenario}</p>;
    case "shadowing":
      return block.params.topic ? <ShadowingScreen topic={block.params.topic} lang={lang} /> : <p>{STR[lang].session.noTopic}</p>;
    case "reflection":
      return <ReflectionScreen lang={lang} />;
    default:
      return <p>{STR[lang].session.unknownBlock(block.kind)}</p>;
  }
}
