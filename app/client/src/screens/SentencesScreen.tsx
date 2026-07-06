import { useEffect, useRef, useState } from "react";
import {
  fetchSentenceQueue, fetchSentences, gradeSentence, playTtsCached,
  type SentenceItem,
} from "../api";
import { stopPlayback } from "../audio";
import { clozeText } from "../cloze";
import { STR, type Lang } from "../i18n";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

const NEW_PER_DAY = 10;
const HIDE_NOTE_KEY = "sentences.hideNote";

type Tab = "practice" | "browse";
type Phase = "prompt" | "cloze" | "answer";
type LoadState = "loading" | "ready" | "error";

function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function loadHideNote(): boolean {
  return localStorage.getItem(HIDE_NOTE_KEY) === "1";
}

function saveHideNote(v: boolean): void {
  localStorage.setItem(HIDE_NOTE_KEY, v ? "1" : "0");
}

/** 練習タブ: ja→（声に出す）→[歯抜け]→答えを見る→自動再生→自己評価、の産出リトリーバルフロー */
function PracticeTab({ lang, hideNote }: { lang: Lang; hideNote: boolean }) {
  const t = STR[lang].sentences;
  const [state, setState] = useState<LoadState>("loading");
  const [queue, setQueue] = useState<SentenceItem[]>([]);
  const [idx, setIdx] = useState(0);
  const [phase, setPhase] = useState<Phase>("prompt");
  const [gradedCount, setGradedCount] = useState(0);
  const [dueTomorrow, setDueTomorrow] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      load();
    }
    return () => {
      aliveRef.current = false;
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setState("loading");
    setErrorMsg("");
    try {
      const q = await fetchSentenceQueue(NEW_PER_DAY);
      if (!aliveRef.current) return;
      setQueue(q);
      setIdx(0);
      setPhase("prompt");
      setState("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  const current = queue[idx];
  const done = state === "ready" && !current;

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
      await gradeSentence(current.no, g);
      if (!aliveRef.current) return;
      stopPlayback();
      setGradedCount((n) => n + 1);
      setIdx((i) => i + 1);
      setPhase("prompt");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  }

  if (state === "loading") return <p className="text-muted">{t.loading}</p>;
  if (state === "error") {
    return <Banner kind="error" action={<Button onClick={load}>{t.retry}</Button>}>{errorMsg}</Banner>;
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
        <p className="sentence-ja">{current.ja}</p>
        {!hideNote && <p className="text-sm text-muted">{current.note}</p>}
        {phase === "prompt" && (
          <>
            <p className="text-muted">{t.sayItFirst}</p>
            <div className="round-actions">
              <Button variant="secondary" onClick={() => setPhase("cloze")}>{t.showCloze}</Button>
              <Button variant="primary" size="lg" onClick={reveal}>{t.showAnswer}</Button>
            </div>
          </>
        )}
        {phase === "cloze" && (
          <>
            <p className="sentence-cloze">{clozeText(current.en, current.no)}</p>
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
            </div>
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

/** 一覧タブ: domainフィルタ + カテゴリ見出しでのブラウズ。SRS状態は情報表示のみ */
function BrowseTab({ lang }: { lang: Lang }) {
  const t = STR[lang].sentences;
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<SentenceItem[]>([]);
  const [filter, setFilter] = useState<"all" | SentenceItem["domain"]>("all");
  const [playingNo, setPlayingNo] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      load();
    }
    return () => {
      aliveRef.current = false;
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setState("loading");
    setErrorMsg("");
    try {
      const all = await fetchSentences();
      if (!aliveRef.current) return;
      setItems(all);
      setState("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  async function play(s: SentenceItem) {
    setPlayingNo(s.no);
    try {
      await playTtsCached(s.en);
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setPlayingNo(null);
    }
  }

  if (state === "loading") return <p className="text-muted">{t.loading}</p>;
  if (state === "error") {
    return <Banner kind="error" action={<Button onClick={load}>{t.retry}</Button>}>{errorMsg}</Banner>;
  }
  const shown = filter === "all" ? items : items.filter((s) => s.domain === filter);
  const categories = [...new Map(shown.map((s) => [s.category_no, s.category])).entries()]
    .sort((a, b) => a[0] - b[0]);
  return (
    <div className="stack">
      <div className="filter-row">
        {(["all", "daily", "business", "it"] as const).map((f) => (
          <button
            key={f}
            className={`filter-chip${filter === f ? " is-active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? t.filterAll : t.domain[f]}
          </button>
        ))}
      </div>
      {errorMsg && <Banner kind="error">{errorMsg}</Banner>}
      {categories.map(([catNo, catName]) => (
        <Card key={catNo} header={`${catNo}. ${catName}`}>
          {shown.filter((s) => s.category_no === catNo).map((s) => (
            <div key={s.no} className="sentence-row">
              <Button
                variant="ghost"
                onClick={() => play(s)}
                disabled={playingNo !== null}
                ariaLabel={t.playAria(s.no)}
              >
                {playingNo === s.no ? "🔊" : "▶"}
              </Button>
              <div className="sentence-body">
                <span className="sentence-en">{s.en}</span>
                <span className="sentence-ja-sub">{s.ja}</span>
                <span className="text-sm text-muted">{s.note}</span>
              </div>
              <span className="sentence-srs text-sm text-muted">
                {s.srs ? `st${s.srs.stage} ・ ${s.srs.due.slice(5)}` : t.srsNew}
              </span>
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

export function SentencesScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].sentences;
  const [tab, setTab] = useState<Tab>("practice");
  const [hideNote, setHideNote] = useState(() => loadHideNote());

  function toggleHideNote() {
    setHideNote((v) => {
      saveHideNote(!v);
      return !v;
    });
  }

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{t.heroTitle}</h2>
        <p className="hero-date">{t.heroDesc}</p>
      </div>
      <div className="filter-row sentences-toolbar">
        <button className={`filter-chip${tab === "practice" ? " is-active" : ""}`} onClick={() => setTab("practice")}>
          {t.tabPractice}
        </button>
        <button className={`filter-chip${tab === "browse" ? " is-active" : ""}`} onClick={() => setTab("browse")}>
          {t.tabBrowse}
        </button>
        <label className="hide-note-toggle text-sm text-muted">
          <input type="checkbox" checked={hideNote} onChange={toggleHideNote} />
          {t.hideNoteLabel}
        </label>
      </div>
      {tab === "practice" ? <PracticeTab lang={lang} hideNote={hideNote} /> : <BrowseTab lang={lang} />}
    </div>
  );
}
