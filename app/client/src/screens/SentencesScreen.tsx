import { useState } from "react";
import { STR, type Lang } from "../i18n";
import { resolveSupport, useSupport } from "../support";
import { PracticeTab } from "./PracticeTab";
import { BrowseTab } from "./BrowseTab";

const HIDE_NOTE_KEY = "sentences.hideNote";
type Tab = "practice" | "browse";

function loadHideNote(): boolean {
  return localStorage.getItem(HIDE_NOTE_KEY) === "1";
}

function saveHideNote(v: boolean): void {
  localStorage.setItem(HIDE_NOTE_KEY, v ? "1" : "0");
}

export function SentencesScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].sentences;
  const [tab, setTab] = useState<Tab>("practice");
  const [hideNote, setHideNote] = useState(() => loadHideNote());
  const support = useSupport();
  // cloze を最初から出すか: 個別トグル → 既定 false（cloze は補助なので「オン」でのみ既定表示）
  const clozeDefault = resolveSupport(support.cloze, false);

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
      {tab === "practice" ? <PracticeTab lang={lang} hideNote={hideNote} clozeDefault={clozeDefault} /> : <BrowseTab lang={lang} />}
    </div>
  );
}
