import { useEffect, useRef, useState } from "react";
import {
  fetchMenu, fetchQuickMenu, progressBlockStart, progressBlockXp, sendSessionEvent,
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

export type MenuSource =
  | { type: "daily"; minutes: 60 | 30 }
  | { type: "quick"; drill: QuickDrillKind; domain?: RoleplayDomain };

/** メニューを取得し、ブロックを順番に進行させる。ブロックタイマーと進行イベント記録を持つ */
export function SessionRunner(props: { source: MenuSource; sessionId: string; lang: Lang; onExit: () => void }) {
  const t = STR[props.lang].session;
  const [menu, setMenu] = useState<Menu | null>(null);
  const [index, setIndex] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const timer = useCountdown(0);
  // StrictMode の開発時二重実行でメニュー取得/最初の block_start が重複しないようにする冪等ガード
  const initedRef = useRef(false);
  // block_start を送信済みで block_end 未送信のブロック（開いているブロック）を追跡する。
  // アンマウント時に開いたままなら block_end(aborted:true) を送って未対応イベントを防ぐ
  const openBlockRef = useRef<{ id: string; kind: string } | null>(null);
  // XP用のブロック試行ID（サーバの block_attempts）。取得失敗は記録なしで練習は続行
  const attemptIdRef = useRef<number | null>(null);
  // 「次のブロックへ」の連打で同一ブロックのXPが二重送信されないようにする同期ガード
  const advancingRef = useRef(false);

  function beginAttempt(kind: string) {
    attemptIdRef.current = null;
    progressBlockStart(kind)
      .then((id) => { attemptIdRef.current = id; })
      .catch((err) => console.warn("block-start failed:", err));
  }

  function loadMenu() {
    setErrorMsg("");
    const fetching = props.source.type === "daily"
      ? fetchMenu(props.source.minutes)
      : fetchQuickMenu(props.source.drill, props.source.domain);
    fetching
      .then((m) => {
        setMenu(m);
        const first = m.blocks[0];
        timer.reset(first.minutes * 60);
        timer.start();
        openBlockRef.current = { id: first.id, kind: first.kind };
        sendSessionEvent("block_start", props.sessionId, { blockId: first.id, kind: first.kind });
        beginAttempt(first.kind);
      })
      .catch((err) => setErrorMsg(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;
    loadMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // アンマウント時（例: 「← メニューに戻る」での途中離脱）に開いたブロックがあれば block_end を1回だけ送る
  useEffect(() => {
    return () => {
      const open = openBlockRef.current;
      if (open) {
        openBlockRef.current = null;
        sendSessionEvent("block_end", props.sessionId, { blockId: open.id, kind: open.kind, aborted: true });
      }
    };
  }, []);

  if (errorMsg) {
    return (
      <div>
        <Banner kind="error" action={<Button onClick={loadMenu}>{t.retry}</Button>}>{errorMsg}</Banner>
      </div>
    );
  }
  if (!menu) return <p className="text-muted">{t.building}</p>;

  const block = menu.blocks[index];
  const isLast = index === menu.blocks.length - 1;

  function nextBlock() {
    if (advancingRef.current) return;
    advancingRef.current = true;
    sendSessionEvent("block_end", props.sessionId, { blockId: block.id, kind: block.kind });
    progressBlockXp(block.minutes, attemptIdRef.current)
      .catch((err) => console.warn("xp post failed:", err));
    openBlockRef.current = null;
    if (isLast) {
      props.onExit();
      return;
    }
    const next = menu!.blocks[index + 1];
    setIndex(index + 1);
    timer.reset(next.minutes * 60);
    timer.start();
    openBlockRef.current = { id: next.id, kind: next.kind };
    sendSessionEvent("block_start", props.sessionId, { blockId: next.id, kind: next.kind });
    beginAttempt(next.kind);
    advancingRef.current = false;
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
      <div key={block.id} className="fade-in">
        <BlockBody block={block} sessionId={props.sessionId} lang={props.lang} />
      </div>
      <div className="round-actions">
        <Button variant="primary" size="lg" onClick={nextBlock} disabled={advancingRef.current}>
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
