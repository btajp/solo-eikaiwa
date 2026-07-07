import { useEffect, useRef, useState } from "react";
import {
  fetchSentenceExplanation, fetchSentenceQueue, fetchSentences, gradeChunk, gradeSentence, playTtsCached,
} from "../api";
import { stopPlayback } from "../audio";
import { clozeText } from "../cloze";
import { STR, type Lang } from "../i18n";
import { useLoad } from "../useLoad";
import { useExplain } from "../useExplain";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { localYmd } from "../dates";
import { initialPhase, type Phase } from "./practicePhase";

const SET_SIZE = 20;

/** 練習タブ: ja→（声に出す）→[歯抜け]→答えを見る→自動再生→自己評価、の産出リトリーバルフロー */
export function PracticeTab({ lang, hideNote, clozeDefault, audioFirst = false, newPerDay }: { lang: Lang; hideNote: boolean; clozeDefault: boolean; audioFirst?: boolean; newPerDay: number }) {
  const t = STR[lang].sentences;
  const load = useLoad(() => fetchSentenceQueue(newPerDay));
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>(initialPhase(audioFirst, clozeDefault));
  const [gradedCount, setGradedCount] = useState(0);
  const [continuedSets, setContinuedSets] = useState(0);
  const [dueTomorrow, setDueTomorrow] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; stopPlayback(); };
  }, []);

  const queue = load.state.status === "ready" ? load.state.data : [];
  const current = queue[idx];
  const done = load.state.status === "ready" && !current;
  // セット境界: idx が SET_SIZE の倍数（>0）に到達し、まだ後続があり、このセットをまだ「続ける」していない
  const atSetBoundary = !done && idx > 0 && idx % SET_SIZE === 0 && idx / SET_SIZE > continuedSets;

  // 「音から」フェーズに入ったカードごとに一度だけ TTS を自動再生する（英文・ja は非表示のまま）。
  // 音声は補助 — 失敗してもフローは止めない。ref キーで StrictMode 二重実行・再レンダーの重複再生を防ぐ。
  const listenPlayedRef = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "listen" || !current) return;
    const key = current.kind === "chunk" ? `c${current.id}` : `s${current.no}`;
    if (listenPlayedRef.current === key) return;
    listenPlayedRef.current = key;
    playTtsCached(current.en).catch(() => {});
  }, [phase, current]);

  useEffect(() => {
    // 完了画面で「明日の復習予定数」を出す（情報表示のみ・失敗は無視）
    if (!done || dueTomorrow !== null) return;
    fetchSentences()
      .then((all) => {
        if (!aliveRef.current) return;
        const tmr = new Date();
        tmr.setDate(tmr.getDate() + 1);
        const tomorrow = localYmd(tmr);
        setDueTomorrow(all.filter((s) => s.srs && s.srs.due <= tomorrow).length);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  async function reveal() {
    setPhase("answer");
    try {
      await playTtsCached(current.en);
    } catch {
      // 音声は補助 — 再生失敗でフローを止めない（🔊で再試行できる）
    }
  }

  async function grade(g: "good" | "soso" | "bad") {
    setBusy(true);
    setErrorMsg("");
    try {
      if (current.kind === "chunk") await gradeChunk(current.id, g);
      else await gradeSentence(current.no, g);
      if (!aliveRef.current) return;
      stopPlayback();
      setGradedCount((n) => n + 1);
      setIdx((i) => i + 1);
      setPhase(initialPhase(audioFirst, clozeDefault));
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  if (load.state.status === "loading") return <p className="text-muted">{t.loading}</p>;
  if (load.state.status === "error") {
    return <Banner kind="error" action={<Button onClick={load.reload}>{t.retry}</Button>}>{load.state.error}</Banner>;
  }
  if (atSetBoundary) {
    return (
      <Card>
        <p className="sentence-done">{t.setDone(queue.length - idx)}</p>
        <p className="text-muted">{t.setNote}</p>
        <Button variant="primary" size="lg" onClick={() => setContinuedSets(idx / SET_SIZE)}>
          {t.setContinue}
        </Button>
      </Card>
    );
  }
  if (done) {
    return (
      <Card>
        <p className="sentence-done">{t.doneTitle(gradedCount)}</p>
        <p className="text-muted">
          {dueTomorrow === null ? "" : t.dueTomorrow(dueTomorrow)}
          {t.doneBody}
        </p>
      </Card>
    );
  }
  return (
    <div className="stack">
      <p className="text-sm text-muted">{t.remaining(queue.length - idx, gradedCount)}</p>
      <Card>
        {phase !== "listen" && (current.kind === "chunk" ? (
          <>
            <p className="text-sm text-muted">{t.chunkLabel}</p>
            <p className="sentence-ja">{current.promptText}</p>
          </>
        ) : (
          <p className="sentence-ja">{current.ja}</p>
        ))}
        {/* ヒント非表示中でも答え合わせ時は表示する（隠す意味があるのは想起の前だけ） */}
        {phase !== "listen" && (!hideNote || phase === "answer") && current.note && <p className="text-sm text-muted">{current.note}</p>}
        {phase === "listen" && (
          <>
            <p className="text-muted">{t.listenPrompt}</p>
            <div className="round-actions">
              <Button variant="ghost" onClick={() => playTtsCached(current.en).catch(() => {})} ariaLabel={t.playAgain}>
                {t.playAgain}
              </Button>
              <Button variant="primary" size="lg" onClick={reveal}>{t.showAnswer}</Button>
            </div>
          </>
        )}
        {phase === "prompt" && (
          <>
            <p className="text-muted">{current.kind === "chunk" ? t.chunkSayIt : t.sayItFirst}</p>
            <div className="round-actions">
              <Button variant="secondary" onClick={() => setPhase("cloze")}>{t.showCloze}</Button>
              <Button variant="primary" size="lg" onClick={reveal}>{t.showAnswer}</Button>
            </div>
          </>
        )}
        {phase === "cloze" && (
          <>
            <p className="sentence-cloze">
              {clozeText(current.en, current.kind === "chunk" ? current.id + 100000 : current.no)}
            </p>
            <p className="text-muted">{t.clozeHint}</p>
            <div className="round-actions">
              <Button variant="primary" size="lg" onClick={reveal}>{t.showAnswer}</Button>
            </div>
          </>
        )}
        {phase === "answer" && (
          <>
            <p className="sentence-en">{current.en}</p>
            <div className="round-actions">
              <Button variant="ghost" onClick={() => playTtsCached(current.en).catch(() => {})} ariaLabel={t.playAgain}>
                {t.playAgain}
              </Button>
              {/* 解説は固定300文専用 — チャンクは AE フィードバック由来の note を既に持つ */}
            </div>
            {current.kind === "sentence" && <SentenceExplain key={current.no} no={current.no} lang={lang} />}
            <div className="grade-row">
              <Button onClick={() => grade("good")} disabled={busy}>{t.gradeGood}</Button>
              <Button onClick={() => grade("soso")} disabled={busy}>{t.gradeSoso}</Button>
              <Button onClick={() => grade("bad")} disabled={busy}>{t.gradeBad}</Button>
            </div>
          </>
        )}
        {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      </Card>
    </div>
  );
}

/** 例文1枚の「もっと詳しく」。no をキーにマウントするのでカードが変われば状態は自動でリセットされる。 */
function SentenceExplain({ no, lang }: { no: number; lang: Lang }) {
  const t = STR[lang].sentences;
  const { state, request } = useExplain(() => fetchSentenceExplanation(no));
  return (
    <>
      {state.status === "idle" && (
        <Button variant="ghost" onClick={request}>{t.explainMore}</Button>
      )}
      {state.status === "loading" && <p className="text-sm text-muted">{t.explainLoading}</p>}
      {state.status === "error" && (
        <p className="text-sm text-muted">{t.explainError}<Button variant="ghost" onClick={request}>{t.retry}</Button></p>
      )}
      {state.status === "done" && <p className="sentence-explain text-sm">{state.text}</p>}
    </>
  );
}
