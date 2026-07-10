import { useEffect, useState } from "react";
import { STR, type Lang } from "../i18n";
import { Button } from "../ui/Button";
import { LevelChip } from "../ui/LevelChip";
import { resolveSupport, useSupport } from "../support";
import { PracticeTab } from "./PracticeTab";
import { BrowseTab } from "./BrowseTab";
import { needsPracticeReload, SENTENCE_SETTING_TIMING } from "./sentence-settings";

const HIDE_NOTE_KEY = "sentences.hideNote";
const AUDIO_FIRST_KEY = "sentences.audioFirst";
const NEW_PER_DAY_KEY = "sentences.newPerDay";
const NEW_PER_DAY_OPTIONS = [3, 5, 10] as const;
type Tab = "practice" | "browse";

function loadHideNote(): boolean {
  return localStorage.getItem(HIDE_NOTE_KEY) === "1";
}

function saveHideNote(v: boolean): void {
  localStorage.setItem(HIDE_NOTE_KEY, v ? "1" : "0");
}

function loadAudioFirst(): boolean {
  return localStorage.getItem(AUDIO_FIRST_KEY) === "1";
}

function saveAudioFirst(v: boolean): void {
  localStorage.setItem(AUDIO_FIRST_KEY, v ? "1" : "0");
}

function loadNewPerDay(): number {
  const v = Number(localStorage.getItem(NEW_PER_DAY_KEY));
  return (NEW_PER_DAY_OPTIONS as readonly number[]).includes(v) ? v : 10;
}

function saveNewPerDay(v: number): void {
  localStorage.setItem(NEW_PER_DAY_KEY, String(v));
}

export function SentencesScreen({
  lang, initialTab = "practice", onTabChange,
}: {
  lang: Lang;
  initialTab?: Tab;
  onTabChange?: (tab: Tab) => void;
}) {
  const t = STR[lang].sentences;
  const [tab, setTab] = useState<Tab>(initialTab);
  const [hideNote, setHideNote] = useState(() => loadHideNote());
  const [audioFirst, setAudioFirst] = useState(() => loadAudioFirst());
  const [newPerDay, setNewPerDay] = useState(() => loadNewPerDay());
  const [queueNewPerDay, setQueueNewPerDay] = useState(() => loadNewPerDay());
  const [practiceRevision, setPracticeRevision] = useState(0);
  const support = useSupport();
  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);
  // cloze を最初から出すか: 個別トグル → 既定 false（cloze は補助なので「オン」でのみ既定表示）
  const clozeDefault = resolveSupport(support.cloze, false);

  function toggleHideNote() {
    setHideNote((v) => {
      saveHideNote(!v);
      return !v;
    });
  }

  function toggleAudioFirst() {
    setAudioFirst((v) => {
      saveAudioFirst(!v);
      return !v;
    });
  }

  const newPerDayNeedsReload = needsPracticeReload(newPerDay, queueNewPerDay);

  function applyNewPerDay() {
    if (!newPerDayNeedsReload) return;
    setQueueNewPerDay(newPerDay);
    setPracticeRevision((revision) => revision + 1);
  }

  function selectTab(next: Tab) {
    if (next === "practice" && tab !== "practice") applyNewPerDay();
    setTab(next);
    if (next !== tab) onTabChange?.(next);
  }

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{t.heroTitle}</h2>
        <LevelChip kind="all" lang={lang} />
        <p className="hero-date">{t.heroDesc}</p>
      </div>
      <div className="filter-row sentences-toolbar">
        <button className={`filter-chip${tab === "practice" ? " is-active" : ""}`} aria-pressed={tab === "practice"} onClick={() => selectTab("practice")}>
          {t.tabPractice}
        </button>
        <button className={`filter-chip${tab === "browse" ? " is-active" : ""}`} aria-pressed={tab === "browse"} onClick={() => selectTab("browse")}>
          {t.tabBrowse}
        </button>
        {tab === "practice" && (
          <>
            <div className="sentence-setting sentence-setting--hints" data-apply-timing={SENTENCE_SETTING_TIMING.hideNote}>
              <label className="hide-note-toggle text-sm text-muted">
                <input type="checkbox" checked={hideNote} onChange={toggleHideNote} />
                {t.hideNoteLabel}
              </label>
              <p className="sentence-setting-timing text-sm text-muted">{t.hideNoteTiming}</p>
            </div>
            <div className="sentence-setting" data-apply-timing={SENTENCE_SETTING_TIMING.audioFirst}>
              <label className="hide-note-toggle text-sm text-muted">
                <input type="checkbox" checked={audioFirst} onChange={toggleAudioFirst} />
                {t.audioFirstLabel}
              </label>
              <p className="sentence-setting-timing text-sm text-muted">{t.audioFirstTiming}</p>
            </div>
            <div className="sentence-setting" data-apply-timing={SENTENCE_SETTING_TIMING.newPerDay}>
              <label className="hide-note-toggle text-sm text-muted">
                {t.newPerDayLabel}
                <select
                  value={newPerDay}
                  onChange={(e) => { const v = Number(e.target.value); saveNewPerDay(v); setNewPerDay(v); }}
                >
                  {NEW_PER_DAY_OPTIONS.map((n) => (<option key={n} value={n}>{n}</option>))}
                </select>
              </label>
              <p className="sentence-setting-timing text-sm text-muted">{t.newPerDayTiming}</p>
              {newPerDayNeedsReload && <Button variant="secondary" onClick={applyNewPerDay}>{t.newPerDayApply}</Button>}
            </div>
          </>
        )}
      </div>
      {tab === "practice" ? <PracticeTab key={practiceRevision} lang={lang} hideNote={hideNote} clozeDefault={clozeDefault} audioFirst={audioFirst} newPerDay={queueNewPerDay} /> : <BrowseTab lang={lang} />}
    </div>
  );
}
