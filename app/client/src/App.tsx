import { useEffect, useRef, useState } from "react";
import { fetchPracticeDays, getHealth, sessionEnd, sessionEndKeepalive, sessionStart, type Health } from "./api";
import { FreeTalkScreen } from "./screens/FreeTalkScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { SessionRunner, type MenuSource } from "./screens/SessionRunner";
import { StartScreen, type StartSelection } from "./screens/StartScreen";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";

type Mode = { kind: "start" } | { kind: "free" } | { kind: "session"; source: MenuSource } | { kind: "library" };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: "start" });
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
    else if (sel.type === "daily") setMode({ kind: "session", source: { type: "daily", minutes: sel.minutes } });
    else setMode({ kind: "session", source: { type: "quick", drill: sel.drill } });
  }

  const navItems: Array<{ key: string; icon: string; label: string; active: boolean; go: () => void }> = [
    { key: "home", icon: "🏠", label: "ホーム", active: mode.kind === "start", go: () => setMode({ kind: "start" }) },
    { key: "free", icon: "💬", label: "自由会話", active: mode.kind === "free", go: () => setMode({ kind: "free" }) },
    { key: "library", icon: "📚", label: "ライブラリ", active: mode.kind === "library", go: () => setMode({ kind: "library" }) },
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
          <Button variant="secondary" onClick={() => setMode({ kind: "start" })}>← メニューに戻る</Button>
        )}
        <div className="sidebar-spacer" />
        <PracticeStat />
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
      {mode.kind === "start" && <StartScreen onSelect={onSelect} />}
      {mode.kind === "session" && (
        <SessionRunner source={mode.source} sessionId={sessionId} onExit={() => setMode({ kind: "start" })} />
      )}
      {mode.kind === "free" && (
        <div className="stack">
          <div className="hero">
            <h2 className="hero-title">自由会話</h2>
            <p className="hero-date">英語でなんでも話しかけてください — 録音ボタンで開始・停止</p>
          </div>
          <FreeTalkScreen />
        </div>
      )}
      {mode.kind === "library" && <LibraryScreen />}
      </main>
    </div>
  );
}

/** サイドバー下部の練習実績（情報表示のみ — 連続日数・喪失演出は置かない） */
function PracticeStat() {
  const [days, setDays] = useState<string[]>([]);
  const fetchedRef = useRef(false);
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    fetchPracticeDays().then(setDays).catch(() => {});
  }, []);
  const now = new Date();
  const weekAgo = new Date(now);
  weekAgo.setDate(weekAgo.getDate() - 6);
  const p = (n: number) => String(n).padStart(2, "0");
  const ymd = (d: Date) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const thisWeek = days.filter((d) => d >= ymd(weekAgo) && d <= ymd(now)).length;
  return (
    <div className="stat-box">
      <div className="stat-title">練習記録</div>
      <div className="stat-main">今週 {thisWeek}<span className="stat-unit">日</span></div>
      <div className="stat-sub">累計 {days.length}日</div>
    </div>
  );
}
