import { useEffect, useRef, useState } from "react";
import { fetchPracticeDays, type QuickDrillKind } from "../api";

export type StartSelection =
  | { type: "quick"; drill: QuickDrillKind }
  | { type: "daily"; minutes: 60 | 30 }
  | { type: "free" }
  | { type: "library" };

const QUICK_BUTTONS: Array<{ drill: QuickDrillKind; icon: string; tile: string; title: string; minutes: string; desc: string }> = [
  { drill: "warmup", icon: "🔊", tile: "c-green", title: "Read-Aloud Warm-up", minutes: "6 min", desc: "Read today's phrases out loud" },
  { drill: "ftt-mini", icon: "🗣", tile: "c-purple", title: "4/3/2 Mini", minutes: "8 min", desc: "Tell the same story twice, faster" },
  { drill: "roleplay", icon: "💼", tile: "c-orange", title: "Work Role-play", minutes: "10 min", desc: "Practice meetings and vendor talk" },
  { drill: "shadowing", icon: "🎧", tile: "c-blue", title: "Shadowing", minutes: "5 min", desc: "Listen and repeat in real time" },
];

const WEEKDAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const WEEKDAYS_EN = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS_EN = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** ローカル日付の YYYY-MM-DD（カレンダー表示用） */
function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 直近8週の練習日カレンダー（GitHub風: 列=週・行=曜日）。
 * 実施日の表示のみ — 情報的フィードバックに徹し、連続日数・喪失演出は置かない。
 */
function PracticeCalendar({ days }: { days: string[] }) {
  const set = new Set(days);
  const today = new Date();
  // 横幅に入るだけ週列を表示（セル18px+隙間5px=23px/列、曜日ラベル分を差し引く）
  const calRef = useRef<HTMLDivElement | null>(null);
  const [weekCount, setWeekCount] = useState(8);
  useEffect(() => {
    const el = calRef.current;
    if (!el) return;
    const compute = () => {
      const w = el.clientWidth;
      // 曜日ラベル列(約12px)+マージン+今日セルのoutline分を差し引く
      setWeekCount(Math.max(8, Math.min(52, Math.floor((w - 8) / 23))));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // 今週の月曜（getDay: 日=0..土=6 → 月曜始まりに補正）
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const weeks: Array<Array<{ ymd: string; done: boolean; isToday: boolean; isFuture: boolean }>> = [];
  for (let w = weekCount - 1; w >= 0; w--) {
    const col: (typeof weeks)[number] = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(monday);
      date.setDate(monday.getDate() - w * 7 + d);
      const ymd = localYmd(date);
      col.push({ ymd, done: set.has(ymd), isToday: ymd === localYmd(today), isFuture: date > today });
    }
    weeks.push(col);
  }
  return (
    <div className="card">
      <div className="calendar-head">
        <h3>Practice days</h3>
      </div>
      <div className="cal" ref={calRef}>
        <div className="cal-weekdays">
          {WEEKDAY_LETTERS.map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
        {weeks.map((col, i) => {
          const isLast = i === weeks.length - 1;
          // 右端（今週）を起点に隔週でラベル表示
          const showLabel = (weeks.length - 1 - i) % 2 === 0;
          const mondayLabel = (() => {
            const [, m, d] = col[0].ymd.split("-");
            return `${Number(m)}/${Number(d)}`;
          })();
          return (
            <div key={i} className="cal-week">
              {showLabel && <span className={`cal-week-label${isLast ? " is-last" : ""}`}>{mondayLabel}</span>}
              {col.map((c) => (
                <div
                  key={c.ymd}
                  title={c.isFuture ? undefined : c.ymd}
                  className={`day${c.done ? " is-done" : ""}${c.isToday ? " is-today" : ""}${c.isFuture ? " is-future" : ""}`}
                />
              ))}
            </div>
          );
        })}
      </div>
      <div className="cal-legend text-sm text-muted">
        <span className="day is-done" /> Practiced
        <span className="day" /> Not yet
      </div>
    </div>
  );
}

export function StartScreen(props: { onSelect: (sel: StartSelection) => void }) {
  const [days, setDays] = useState<string[]>([]);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      // カレンダーは補助情報 — 取得失敗でスタート画面を壊さない
      fetchPracticeDays().then((d) => { if (aliveRef.current) setDays(d); }).catch(() => {});
    }
    return () => { aliveRef.current = false; };
  }, []);

  const today = new Date();
  const dateLabel = `${WEEKDAYS_EN[today.getDay()]}, ${MONTHS_EN[today.getMonth()]} ${today.getDate()}`;
  // 今日のおすすめ: 日付で決まる決定的ローテーション（クイックドリル4種）
  const dayOfYear = Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000);
  const pick = QUICK_BUTTONS[dayOfYear % QUICK_BUTTONS.length];

  return (
    <div className="stack">
      <div className="hero">
        <p className="hero-greet">👋 {dateLabel}</p>
        <h2 className="hero-title">Ready to practice your English?</h2>
      </div>

      <div>
        <p className="section-label">Quick drills (5–10 min) <span className="section-note">short but daily wins</span></p>
        <div className="drill-grid">
          {QUICK_BUTTONS.map((q) => (
            <button key={q.drill} className="drill-card" onClick={() => props.onSelect({ type: "quick", drill: q.drill })}>
              <span className={`drill-icon ${q.tile}`} aria-hidden="true">{q.icon}</span>
              <span className="drill-body">
                <span className="drill-title">{q.title} <span className="drill-min">{q.minutes}</span></span>
                <span className="drill-desc">{q.desc}</span>
              </span>
              <span className="drill-arrow" aria-hidden="true">→</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="section-label">Intensive sessions <span className="section-note">1–2 times a week</span></p>
        <div className="drill-grid">
          <button className="drill-card" onClick={() => props.onSelect({ type: "daily", minutes: 60 })}>
            <span className="drill-icon c-green" aria-hidden="true">📋</span>
            <span className="drill-body">
              <span className="drill-title">Full Session <span className="drill-min">60 min</span></span>
              <span className="drill-desc">Five blocks of solid practice</span>
            </span>
            <span className="drill-arrow" aria-hidden="true">→</span>
          </button>
          <button className="drill-card" onClick={() => props.onSelect({ type: "daily", minutes: 30 })}>
            <span className="drill-icon c-blue" aria-hidden="true">⏱</span>
            <span className="drill-body">
              <span className="drill-title">Short Session <span className="drill-min">30 min</span></span>
              <span className="drill-desc">Focused training when you have time</span>
            </span>
            <span className="drill-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <PracticeCalendar days={days} />

      <button className="cta" onClick={() => props.onSelect({ type: "quick", drill: pick.drill })}>
        Start today's practice — {pick.title} ({pick.minutes})
      </button>
    </div>
  );
}
