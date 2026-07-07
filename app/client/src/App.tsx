import { useEffect, useRef, useState } from "react";
import {
  fetchPracticeDays, fetchProgressSummary, getHealth, onProgressUpdate, progressLevelAction, sessionEnd,
  sessionEndKeepalive, sessionStart, type Health, type ProgressSummary,
} from "./api";
import { loadLang, saveLang, STR, type Lang } from "./i18n";
import { FreeTalkScreen } from "./screens/FreeTalkScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { PlacementScreen } from "./screens/PlacementScreen";
import { ProgressScreen } from "./screens/ProgressScreen";
import { SentencesScreen } from "./screens/SentencesScreen";
import { SessionRunner, type MenuSource } from "./screens/SessionRunner";
import { StartScreen, type StartSelection } from "./screens/StartScreen";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { localYmd } from "./dates";
import { saveSupport, useSupport, type SupportToggle } from "./support";

type Mode = { kind: "start" } | { kind: "free" } | { kind: "session"; source: MenuSource } | { kind: "library" } | { kind: "sentences" } | { kind: "placement" } | { kind: "progress" };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "start" });
  const [lang, setLang] = useState<Lang>(() => loadLang());
  const t = STR[lang];
  function switchLang(next: Lang) {
    setLang(next);
    saveLang(next);
  }
  // 文字サイズ（小/中/大）。tokens.css の :root[data-ui-scale] が --fs-* を切り替える
  const [uiScale, setUiScale] = useState<"small" | "medium" | "large" | "xlarge">(() => {
    const v = localStorage.getItem("ui.scale");
    return v === "small" || v === "large" || v === "xlarge" ? v : "medium";
  });
  useEffect(() => {
    document.documentElement.dataset.uiScale = uiScale;
    localStorage.setItem("ui.scale", uiScale);
  }, [uiScale]);
  // このタブのセッションを識別するUUID。ライフサイクル/ブロック/ラウンドイベントは
  // モードに関わらずすべてこのIDで記録する（converse() が返す会話用sessionIdとは別概念。そちらは変更しない）
  const [sessionId] = useState(() => crypto.randomUUID());
  // StrictMode の開発時二重マウントで session_start が重複記録されないようにする冪等ガード
  const startedRef = useRef(false);

  useEffect(() => {
    getHealth()
      .then((h) => { setHealth(h); setServerDown(false); })
      .catch(() => { setHealth(null); setServerDown(true); });
    if (!startedRef.current) {
      startedRef.current = true;
      sessionStart(sessionId);
    }
    const onPageHide = () => sessionEndKeepalive(sessionId);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      sessionEnd(sessionId);
    };
  }, [sessionId]);

  function onSelect(sel: StartSelection) {
    if (sel.type === "free") setMode({ kind: "free" });
    else if (sel.type === "library") setMode({ kind: "library" });
    else if (sel.type === "placement") setMode({ kind: "placement" });
    else setMode({ kind: "session", source: sel.source });
  }

  const navItems: Array<{ key: string; icon: string; label: string; active: boolean; go: () => void }> = [
    { key: "home", icon: "🏠", label: t.nav.home, active: mode.kind === "start", go: () => setMode({ kind: "start" }) },
    { key: "placement", icon: "📐", label: t.nav.placement, active: mode.kind === "placement", go: () => setMode({ kind: "placement" }) },
    { key: "free", icon: "💬", label: t.nav.free, active: mode.kind === "free", go: () => setMode({ kind: "free" }) },
    { key: "library", icon: "📚", label: t.nav.library, active: mode.kind === "library", go: () => setMode({ kind: "library" }) },
    { key: "sentences", icon: "📖", label: t.nav.sentences, active: mode.kind === "sentences", go: () => setMode({ kind: "sentences" }) },
    { key: "progress", icon: "📈", label: t.nav.progress, active: mode.kind === "progress", go: () => setMode({ kind: "progress" }) },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1 className="app-brand"><span className="brand-mark" aria-hidden="true" />learn-english</h1>
        <nav className="side-nav">
          {navItems.map((n) => (
            <button key={n.key} className={`side-item${n.active ? " is-active" : ""}`} onClick={n.go}>
              <span className="side-icon" aria-hidden="true">{n.icon}</span>
              {n.label}
            </button>
          ))}
        </nav>
        {mode.kind === "session" && (
          <Button variant="secondary" onClick={() => setMode({ kind: "start" })}>{t.appShell.backToMenu}</Button>
        )}
        <div className="sidebar-spacer" />
        <SupportPanel lang={lang} />
        <div className="lang-toggle" role="group" aria-label={t.appShell.textSize}>
          <button className={uiScale === "small" ? "is-active" : ""} onClick={() => setUiScale("small")}>{t.uiScale.small}</button>
          <button className={uiScale === "medium" ? "is-active" : ""} onClick={() => setUiScale("medium")}>{t.uiScale.medium}</button>
          <button className={uiScale === "large" ? "is-active" : ""} onClick={() => setUiScale("large")}>{t.uiScale.large}</button>
          <button className={uiScale === "xlarge" ? "is-active" : ""} onClick={() => setUiScale("xlarge")}>{t.uiScale.xlarge}</button>
        </div>
        <div className="lang-toggle" role="group" aria-label={t.appShell.language}>
          <button className={lang === "en" ? "is-active" : ""} onClick={() => switchLang("en")}>EN</button>
          <button className={lang === "ja" ? "is-active" : ""} onClick={() => switchLang("ja")}>日本語</button>
        </div>
        <PracticeStat lang={lang} />
      </aside>
      <main className="app">
      {serverDown && (
        <Banner kind="error">APIサーバに接続できません — `cd app && bun run dev` で起動してください</Banner>
      )}
      {!serverDown && health && !health.ok && (
        <Banner kind="error">依存が不足しています: {JSON.stringify(health)} — `scripts/setup.sh` を実行してください</Banner>
      )}
      {!serverDown && health && health.ok && !health.ttsKey && (
        <Banner kind="warn">OPENAI_API_KEY 未設定のため TTS は say フォールバックです</Banner>
      )}
      {mode.kind === "start" && <StartScreen onSelect={onSelect} lang={lang} />}
      {mode.kind === "session" && (
        <SessionRunner source={mode.source} sessionId={sessionId} lang={lang} onExit={() => setMode({ kind: "start" })} />
      )}
      {mode.kind === "free" && (
        <div className="stack">
          <div className="hero">
            <h2 className="hero-title">{t.freeTalk.title}</h2>
            <p className="hero-date">{t.freeTalk.desc}</p>
          </div>
          <FreeTalkScreen lang={lang} />
        </div>
      )}
      {mode.kind === "library" && <LibraryScreen lang={lang} />}
      {mode.kind === "sentences" && <SentencesScreen lang={lang} />}
      {mode.kind === "placement" && <PlacementScreen lang={lang} onExit={() => setMode({ kind: "start" })} />}
      {mode.kind === "progress" && <ProgressScreen lang={lang} />}
      </main>
    </div>
  );
}

/** サイドバー常設の学習サポート設定（個別トグル3つ）。設定は support.ts が localStorage に永続化する */
function SupportPanel({ lang }: { lang: Lang }) {
  const s = useSupport();
  const t = STR[lang].support;
  // ⓘ ボタンで開くヘルプの吹き出し。開いているキーは1つだけ（別の ⓘ を押すか、同じものをもう一度押すと閉じる）
  const [openHelp, setOpenHelp] = useState<string | null>(null);
  function setToggle(key: "jaHint" | "modelTalk" | "cloze", value: SupportToggle) {
    saveSupport({ ...s, [key]: value });
  }
  function toggleHelp(key: string) {
    setOpenHelp((cur) => (cur === key ? null : key));
  }
  const toggles: Array<{ key: "jaHint" | "modelTalk" | "cloze"; label: string; help: string }> = [
    { key: "jaHint", label: t.jaHint, help: t.helpJaHint },
    { key: "modelTalk", label: t.modelTalk, help: t.helpModelTalk },
    { key: "cloze", label: t.cloze, help: t.helpCloze },
  ];
  return (
    <div className="support-panel stack">
      <div className="stat-title">{t.title}</div>
      {toggles.map((tg) => (
        <div key={tg.key}>
          <div className="support-label-row">
            <div className="text-sm text-muted">{tg.label}</div>
            <button className="info-btn" aria-label={tg.help} title={tg.help} onClick={() => toggleHelp(tg.key)}>ⓘ</button>
          </div>
          {openHelp === tg.key && <div className="info-pop">{tg.help}</div>}
          <div className="lang-toggle" role="group" aria-label={tg.label}>
            <button className={s[tg.key] === null ? "is-active" : ""} onClick={() => setToggle(tg.key, null)}>{t.optAuto}</button>
            <button className={s[tg.key] === true ? "is-active" : ""} onClick={() => setToggle(tg.key, true)}>{t.optOn}</button>
            <button className={s[tg.key] === false ? "is-active" : ""} onClick={() => setToggle(tg.key, false)}>{t.optOff}</button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** サイドバー下部の練習実績＋レベル（情報表示のみ — 連続日数・喪失演出は置かない） */
function PracticeStat({ lang }: { lang: Lang }) {
  const [days, setDays] = useState<string[]>([]);
  const [summary, setSummary] = useState<ProgressSummary | null>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [editError, setEditError] = useState("");
  const fetchedRef = useRef(false);
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchPracticeDays().then(setDays).catch(() => {});
    fetchProgressSummary().then(setSummary).catch(() => {});
  }, []);
  // 他画面でのXP付与・レベル操作（提案の承認等）を購読し、再取得なしで最新値に追従する
  useEffect(() => onProgressUpdate(setSummary), []);
  const t = STR[lang];
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 6);
  const thisWeek = days.filter((d) => d >= localYmd(weekAgo) && d <= localYmd(now)).length;

  async function saveLevel() {
    const n = Number(editValue);
    if (!Number.isInteger(n) || n < 1 || n > 999) {
      setEditError(t.progress.editError);
      return;
    }
    try {
      const s = await progressLevelAction("set", n);
      setSummary(s);
      setEditError("");
      setEditing(false);
    } catch (err) {
      console.warn("level set failed:", err);
      setEditError(t.progress.editError);
    }
  }

  function cancelEdit() {
    setEditing(false);
    setEditError("");
  }

  const need = summary ? summary.xpIntoLevel + summary.xpToNext : 0;
  const pct = summary && need > 0 ? Math.min(100, Math.round((summary.xpIntoLevel / need) * 100)) : 0;

  return (
    <div className="stat-box">
      {summary && (
        <div className="stat-level-wrap">
          {editing ? (
            <div className="level-edit">
              <input
                className="level-input" type="number" min={1} max={999} value={editValue} autoFocus
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveLevel();
                  else if (e.key === "Escape") cancelEdit();
                }}
                aria-label={t.progress.editTitle}
              />
              <button className="level-edit-btn" onClick={saveLevel}>{t.progress.editSave}</button>
              <button className="level-edit-btn" onClick={cancelEdit}>{t.progress.editCancel}</button>
            </div>
          ) : (
            <button
              className="stat-level" title={t.progress.editTitle}
              onClick={() => { setEditValue(String(summary.level)); setEditError(""); setEditing(true); }}
            >
              {t.progress.levelLabel(summary.level)}
            </button>
          )}
          {editing && editError && <div className="level-edit-error">{editError}</div>}
          <div
            className="gauge" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
            aria-label={t.progress.gaugeLabel}
          >
            <div className="gauge-fill" style={{ width: `${pct}%` }} />
          </div>
          <div className="stat-sub">{summary.difficultyMaxed ? t.progress.maxed : t.progress.toNext(summary.xpToNext)}</div>
        </div>
      )}
      <div className="stat-title">{t.stat.title}</div>
      <div className="stat-main">{thisWeek}<span className="stat-unit">{t.stat.thisWeekUnit}</span></div>
      <div className="stat-sub">{t.stat.total(days.length)}</div>
    </div>
  );
}
