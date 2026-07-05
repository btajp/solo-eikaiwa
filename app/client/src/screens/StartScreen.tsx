import { useEffect, useRef, useState } from "react";
import { fetchPracticeDays, type QuickDrillKind } from "../api";

export type StartSelection =
  | { type: "quick"; drill: QuickDrillKind }
  | { type: "daily"; minutes: 60 | 30 }
  | { type: "free" }
  | { type: "library" };

const QUICK_BUTTONS: Array<{ drill: QuickDrillKind; icon: string; tile: string; title: string; minutes: string; desc: string }> = [
  { drill: "warmup", icon: "🔊", tile: "c-green", title: "音読ウォームアップ", minutes: "6分", desc: "今日の表現を声に出して準備" },
  { drill: "ftt-mini", icon: "🗣", tile: "c-purple", title: "4/3/2ミニ", minutes: "8分", desc: "同じ話を2回、時間圧で流暢に" },
  { drill: "roleplay", icon: "💼", tile: "c-orange", title: "実務ロールプレイ", minutes: "10分", desc: "会議・ベンダー対応を想定した練習" },
  { drill: "shadowing", icon: "🎧", tile: "c-blue", title: "シャドーイング", minutes: "5分", desc: "聞こえた英語に重ねて言う" },
];

const WEEKDAYS_JA = ["月", "火", "水", "木", "金", "土", "日"];

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
      // 曜日ラベル列+マージン+今日セルのoutline分を差し引く（はみ出し防止で保守的に）
      setWeekCount(Math.max(8, Math.min(52, Math.floor((w - 48) / 23))));
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
        <h3>練習日</h3>
      </div>
      <div className="cal" ref={calRef}>
        <div className="cal-weekdays">
          <span className="cal-week-label" aria-hidden="true" />
          {WEEKDAYS_JA.map((w) => (
            <span key={w}>{w}</span>
          ))}
        </div>
        {weeks.map((col, i) => {
          const mondayLabel = (() => {
            const [, m, d] = col[0].ymd.split("-");
            return `${Number(m)}/${Number(d)}`;
          })();
          return (
            <div key={i} className="cal-week">
              {/* 週頭（月曜）の日付は一番右=今週の列にだけ表示 */}
              <span className="cal-week-label">{i === weeks.length - 1 ? mondayLabel : ""}</span>
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
        <span className="day is-done" /> 練習した日
        <span className="day" /> 未実施
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
  const dateLabel = `${today.getMonth() + 1}月${today.getDate()}日（${WEEKDAYS_JA[(today.getDay() + 6) % 7]}）`;
  // 今日のおすすめ: 日付で決まる決定的ローテーション（クイックドリル4種）
  const dayOfYear = Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000);
  const pick = QUICK_BUTTONS[dayOfYear % QUICK_BUTTONS.length];

  return (
    <div className="stack">
      <div className="hero">
        <p className="hero-greet">👋 {dateLabel}</p>
        <h2 className="hero-title">今日も英語を話しましょう</h2>
      </div>

      <div>
        <p className="section-label">クイックドリル（5〜10分） <span className="section-note">短くても毎日が正解</span></p>
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
        <p className="section-label">強化セッション <span className="section-note">週1〜2回おすすめ</span></p>
        <div className="drill-grid">
          <button className="drill-card" onClick={() => props.onSelect({ type: "daily", minutes: 60 })}>
            <span className="drill-icon c-green" aria-hidden="true">📋</span>
            <span className="drill-body">
              <span className="drill-title">通しセッション <span className="drill-min">60分</span></span>
              <span className="drill-desc">5ブロックで総合的にしっかり練習</span>
            </span>
            <span className="drill-arrow" aria-hidden="true">→</span>
          </button>
          <button className="drill-card" onClick={() => props.onSelect({ type: "daily", minutes: 30 })}>
            <span className="drill-icon c-blue" aria-hidden="true">⏱</span>
            <span className="drill-body">
              <span className="drill-title">短縮版 <span className="drill-min">30分</span></span>
              <span className="drill-desc">時間がある日の集中トレーニング</span>
            </span>
            <span className="drill-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      <PracticeCalendar days={days} />

      <button className="cta" onClick={() => props.onSelect({ type: "quick", drill: pick.drill })}>
        今日の学習を始める — {pick.title}（{pick.minutes}）
      </button>
    </div>
  );
}
