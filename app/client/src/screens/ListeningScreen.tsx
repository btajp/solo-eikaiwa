import { useEffect, useRef, useState } from "react";
import {
  fetchListeningLibrary, fetchListeningItem, logListening, fetchProgressSummary, fetchTalkExplanation,
  playTtsCached, prefetchTts, type ListeningMeta, type ListeningDetail,
} from "../api";
import { stopPlayback } from "../audio";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { localizedTitle } from "../localized-title";
import { useLoad } from "../useLoad";
import { useExplain } from "../useExplain";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { FlowExitButton } from "../ui/FlowExitButton";
import { FeedbackRow } from "../ui/FeedbackRow";
import { ExplainBox } from "../ui/ExplainBox";
import { LevelChip } from "../ui/LevelChip";
import { PlaybackButton } from "../ui/PlaybackButton";
import { resolvePendingListeningLog, type PendingListeningLog } from "./listeningLogRequest";

type LibraryData = { items: ListeningMeta[]; weeklyCount: number; stage: number };

/** 一覧のレベル適合フィルタに使う stage を進捗サマリから、素材と週次カウントを listening API から同時取得する。 */
async function loadLibrary(): Promise<LibraryData> {
  const [lib, summary] = await Promise.all([fetchListeningLibrary(), fetchProgressSummary()]);
  return { items: lib.items, weeklyCount: lib.weeklyCount, stage: summary.stage };
}

/** 多聴ミニライブラリ。一覧（レベル適合フィルタ既定・全表示可）→ 再生（逐次TTS・スクリプト隠し既定）→ 聴取記録（情報表示のみ）。 */
export function ListeningScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].listeningScreen;
  const { state, reload } = useLoad(loadLibrary);
  const [selected, setSelected] = useState<ListeningMeta | null>(null);
  // プレイヤーが聴取記録したら返ってくる最新の「今週n本」で表示を上書きする（一覧を再取得しない）
  const [weekOverride, setWeekOverride] = useState<number | null>(null);

  if (selected) {
    return <ListeningPlayer meta={selected} lang={lang} onListened={setWeekOverride} onBack={() => setSelected(null)} />;
  }

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{t.title}</h2>
        <LevelChip kind="band" lang={lang} />
        <p className="hero-date">{t.desc}</p>
      </div>
      {state.status === "loading" && <p className="text-muted">{t.loading}</p>}
      {state.status === "error" && (
        <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{formatClientError(lang, state.error, "load")}</Banner>
      )}
      {state.status === "ready" && (
        <ListeningList
          data={state.data} lang={lang}
          weekCount={weekOverride ?? state.data.weeklyCount}
          onOpen={setSelected}
        />
      )}
    </div>
  );
}

/** 一覧: レベル適合フィルタ（既定）↔ 全表示トグル。週次カウントは情報表示（ノルマなし）。 */
function ListeningList({ data, lang, weekCount, onOpen }: {
  data: LibraryData; lang: Lang; weekCount: number; onOpen: (m: ListeningMeta) => void;
}) {
  const t = STR[lang].listeningScreen;
  const [showAll, setShowAll] = useState(false);
  const shown = showAll
    ? data.items
    : data.items.filter((it) => it.level[0] <= data.stage && data.stage <= it.level[1]);
  return (
    <>
      <p className="text-sm text-muted">{t.weekCount(weekCount)}</p>
      <div className="lang-toggle" role="group" aria-label={t.filterFit}>
        <button className={!showAll ? "is-active" : ""} aria-pressed={!showAll} onClick={() => setShowAll(false)}>{t.filterFit}</button>
        <button className={showAll ? "is-active" : ""} aria-pressed={showAll} onClick={() => setShowAll(true)}>{t.filterAll}</button>
      </div>
      {shown.length === 0 && <p className="text-muted">{t.empty}</p>}
      {shown.map((it) => (
        <Card
          key={it.id}
          header={
            <>
              {localizedTitle(it, lang)} <span className="text-sm text-muted">{t.domain[it.domain]}</span>
              {/* #220: 2話者対話素材のバッジ（情報表示のみ） */}
              {it.format === "dialogue" && <span className="text-sm text-muted"> · {t.dialogueBadge}</span>}
            </>
          }
        >
          <Button variant="primary" onClick={() => onOpen(it)}>{t.open}</Button>
        </Card>
      ))}
    </>
  );
}

/** 1素材の再生画面。本文（paragraphs）を取得してから逐次プレイヤーを描画する。 */
function ListeningPlayer({ meta, lang, onListened, onBack }: {
  meta: ListeningMeta; lang: Lang; onListened: (weeklyCount: number) => void; onBack: () => void;
}) {
  const t = STR[lang].listeningScreen;
  const { state, reload } = useLoad(() => fetchListeningItem(meta.id));
  return (
    <div className="stack">
      <FlowExitButton onClick={onBack}>{t.back}</FlowExitButton>
      <div className="hero"><h2 className="hero-title">{localizedTitle(meta, lang)}</h2></div>
      {state.status === "loading" && <p className="text-muted">{t.scriptLoading}</p>}
      {state.status === "error" && (
        <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{formatClientError(lang, state.error, "load")}</Banner>
      )}
      {state.status === "ready" && <ListeningPlayback item={state.data} lang={lang} onListened={onListened} />}
    </div>
  );
}

/**
 * 逐次TTS再生本体。段落ごとに playTtsCached を await 連鎖で順次再生する。
 * - tokenRef は単調増加の「再生世代」。playAll 開始時に発番し（my）、各 await の後で
 *   tokenRef.current !== my なら自分は古い世代と判定して即 return する。boolean の abortRef
 *   ではこれができない: fetch 待ち中（stopPlayback は再生開始前で no-op）に stop → 再度 play すると、
 *   新しい playAll が abortRef を false に戻すため、await から目覚めた「旧」ループがそのまま生き返り、
 *   新旧2ループが並走して段落が早送りされ、実際には聴いていないのに logListening まで届いてしまう
 *   （研究上の記録忠実性を損なう）。世代が増分される tokenRef ならこの蘇生が起きない。
 * - stop: tokenRef を増分してから stopPlayback()。
 * - unmount: aliveRef=false + tokenRef 増分 + stopPlayback() でループと setState を安全に停止。
 * 全段落を通し再生し終えたときだけ、かつ自分が最新世代のときだけ聴取を記録する（情報表示のみ）。
 */
function ListeningPlayback({ item, lang, onListened }: {
  item: ListeningDetail; lang: Lang; onListened: (weeklyCount: number) => void;
}) {
  const t = STR[lang].listeningScreen;
  const playback = STR[lang].playback;
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const [showScript, setShowScript] = useState(false);
  const [listened, setListened] = useState(false);
  const [errorMsg, setErrorMsg] = useState("");
  const [logStatus, setLogStatus] = useState<"idle" | "saving" | "failed">("idle");
  const aliveRef = useRef(true);
  const tokenRef = useRef(0);
  const pendingLogRef = useRef<PendingListeningLog | null>(null);
  const explainer = useExplain(() => fetchTalkExplanation(item.paragraphs.join("\n\n")));
  // #220: dialogue はラベル抜きの発話本文を結合した1テキストで再生する（同梱の話者別voice結合音声の
  // ルックアップキーがこの文字列と一致する契約 — server/dialogue-audio.ts dialogueBundledCacheKey）。
  // monologue は従来どおり段落単位の逐次再生。
  const dialogueTurns = item.format === "dialogue" && item.turns && item.turns.length > 0 ? item.turns : null;
  const playUnits = dialogueTurns ? [dialogueTurns.map((turn) => turn.text).join("\n\n")] : item.paragraphs;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      tokenRef.current++;
      stopPlayback();
    };
  }, []);

  async function saveListeningLog(pending: PendingListeningLog) {
    setLogStatus("saving");
    try {
      const { weeklyCount } = await logListening(pending.itemId, pending.attemptId);
      if (!aliveRef.current || pendingLogRef.current?.attemptId !== pending.attemptId) return;
      pendingLogRef.current = null;
      onListened(weeklyCount);
      setLogStatus("idle");
    } catch (err) {
      if (!aliveRef.current || pendingLogRef.current?.attemptId !== pending.attemptId) return;
      setLogStatus("failed");
      console.warn("listening log failed:", err);
    }
  }

  async function playAll() {
    setErrorMsg("");
    const my = ++tokenRef.current;
    for (let i = 0; i < playUnits.length; i++) {
      if (tokenRef.current !== my || !aliveRef.current) return;
      setPlayingIdx(i);
      try {
        if (i + 1 < playUnits.length) prefetchTts(playUnits[i + 1]);
        await playTtsCached(playUnits[i]);
      } catch (err) {
        if (tokenRef.current !== my || !aliveRef.current) return;
        setErrorMsg(formatClientError(lang, err, "play"));
        setPlayingIdx(null);
        return;
      }
    }
    if (tokenRef.current !== my || !aliveRef.current) return;
    setPlayingIdx(null);
    // 通し再生自体は完了扱いにし、聴取記録だけを同じattempt IDで安全に再試行できるよう分離する。
    setListened(true);
    const pending = resolvePendingListeningLog(pendingLogRef.current, item.id);
    pendingLogRef.current = pending;
    await saveListeningLog(pending);
  }

  function retryListeningLog() {
    const pending = pendingLogRef.current;
    if (pending) void saveListeningLog(pending);
  }

  function stop() {
    tokenRef.current++;
    stopPlayback();
    setPlayingIdx(null);
  }

  const isPlaying = playingIdx !== null;
  return (
    <div className="stack">
      <p className="text-muted">{t.desc}</p>
      {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      {logStatus === "saving" && <Banner kind="info">{t.logSaving}</Banner>}
      {logStatus === "failed" && (
        <Banner kind="info" action={<Button onClick={retryListeningLog}>{t.logRetry}</Button>}>
          {t.logFailed}
        </Banner>
      )}
      <PlaybackButton
        playing={isPlaying}
        onPlay={playAll}
        onStop={stop}
        playLabel={t.play}
        stopLabel={playback.stop}
        playVariant="primary"
      />
      {isPlaying && <p className="text-sm text-muted">{playback.playing}</p>}
      {!showScript && <Button variant="secondary" onClick={() => setShowScript(true)}>{t.showScript}</Button>}
      {showScript && (
        <>
          {/* 1本の地続きのスクリプト。段落は TTS 再生単位であって別々の文章ではないため、1枚のカードに通常の段落として流す。
              dialogue（#220）は話者ラベル付きでターンを表示する（再生は結合1本のため段落ハイライトは行わない） */}
          <Card className="reading-text">
            {dialogueTurns
              ? dialogueTurns.map((turn, i) => (
                <p key={i} className="listening-para">
                  <strong className="listening-speaker">{turn.speaker}:</strong> {turn.text}
                </p>
              ))
              : item.paragraphs.map((p, i) => (
                <p key={i} className={`listening-para${playingIdx === i ? " is-playing" : ""}`}>{p}</p>
              ))}
          </Card>
          <ExplainBox
            state={explainer.state} request={explainer.request}
            labels={{ more: t.explainMore, loading: t.explainLoading, error: t.explainError, retry: t.retry }}
          />
        </>
      )}
      {listened && <FeedbackRow context={{ blockKind: "listening", refId: item.id }} lang={lang} />}
    </div>
  );
}
