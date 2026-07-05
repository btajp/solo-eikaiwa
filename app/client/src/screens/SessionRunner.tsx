import { useEffect, useRef, useState } from "react";
import { fetchMenu, fetchQuickMenu, sendSessionEvent, type Menu, type MenuBlock, type QuickDrillKind } from "../api";
import { formatMmSs, useCountdown } from "../useCountdown";
import { ChunkPlaceholderScreen } from "./ChunkPlaceholderScreen";
import { FourThreeTwoScreen } from "./FourThreeTwoScreen";
import { ReflectionScreen } from "./ReflectionScreen";
import { RoleplayScreen } from "./RoleplayScreen";
import { ShadowingScreen } from "./ShadowingScreen";
import { WarmupReadingScreen } from "./WarmupReadingScreen";

export type MenuSource = { type: "daily"; minutes: 60 | 30 } | { type: "quick"; drill: QuickDrillKind };

/** メニューを取得し、ブロックを順番に進行させる。ブロックタイマーと進行イベント記録を持つ */
export function SessionRunner(props: { source: MenuSource; sessionId: string; onExit: () => void }) {
  const [menu, setMenu] = useState<Menu | null>(null);
  const [index, setIndex] = useState(0);
  const [errorMsg, setErrorMsg] = useState("");
  const timer = useCountdown(0);
  // StrictMode の開発時二重実行でメニュー取得/最初の block_start が重複しないようにする冪等ガード
  const initedRef = useRef(false);
  // block_start を送信済みで block_end 未送信のブロック（開いているブロック）を追跡する。
  // アンマウント時に開いたままなら block_end(aborted:true) を送って未対応イベントを防ぐ
  const openBlockRef = useRef<{ id: string; kind: string } | null>(null);

  function loadMenu() {
    setErrorMsg("");
    const fetching = props.source.type === "daily" ? fetchMenu(props.source.minutes) : fetchQuickMenu(props.source.drill);
    fetching
      .then((m) => {
        setMenu(m);
        const first = m.blocks[0];
        timer.reset(first.minutes * 60);
        timer.start();
        openBlockRef.current = { id: first.id, kind: first.kind };
        sendSessionEvent("block_start", props.sessionId, { blockId: first.id, kind: first.kind });
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
        <p style={{ color: "crimson" }}>{errorMsg}</p>
        <button onClick={loadMenu} style={{ padding: "0.6rem 1.2rem", cursor: "pointer" }}>再試行</button>
      </div>
    );
  }
  if (!menu) return <p>今日のメニューを組んでいます…</p>;

  const block = menu.blocks[index];
  const isLast = index === menu.blocks.length - 1;

  function nextBlock() {
    sendSessionEvent("block_end", props.sessionId, { blockId: block.id, kind: block.kind });
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
  }

  return (
    <div>
      <p style={{ color: "#666" }}>
        ブロック {index + 1}/{menu.blocks.length} ・ ⏱ {formatMmSs(timer.remaining)}
        {timer.expired && " — 時間切れ（キリのいいところで次へ）"}
      </p>
      <h2 style={{ fontSize: "1.1rem" }}>{block.title}</h2>
      <BlockBody block={block} sessionId={props.sessionId} />
      <hr style={{ margin: "1.5rem 0" }} />
      <button onClick={nextBlock} style={{ padding: "0.8rem 1.4rem", fontSize: "1rem", cursor: "pointer" }}>
        {isLast ? "✅ セッションを終える" : "次のブロックへ →"}
      </button>
    </div>
  );
}

function BlockBody({ block, sessionId }: { block: MenuBlock; sessionId: string }) {
  switch (block.kind) {
    case "chunk-placeholder":
      return <ChunkPlaceholderScreen />;
    case "warmup-reading":
      return block.params.topic ? <WarmupReadingScreen topic={block.params.topic} /> : <p>トピックがありません</p>;
    case "four-three-two":
      return block.params.topic ? (
        <FourThreeTwoScreen topic={block.params.topic} sessionId={sessionId} blockId={block.id} roundsSec={block.params.roundsSec} />
      ) : (
        <p>トピックがありません</p>
      );
    case "roleplay":
      return block.params.scenario ? <RoleplayScreen scenario={block.params.scenario} /> : <p>シナリオがありません</p>;
    case "shadowing":
      return block.params.topic ? <ShadowingScreen topic={block.params.topic} /> : <p>トピックがありません</p>;
    case "reflection":
      return <ReflectionScreen />;
    default:
      return <p>未知のブロック: {block.kind}</p>;
  }
}
