import { useEffect, useRef, useState } from "react";
import {
  fetchPracticeDays, fetchProgressSummary, progressLevelAction,
  type LevelProposal, type ProgressSummary, type QuickDrillKind,
} from "../api";
import { STR, type Lang } from "../i18n";
import { Button } from "../ui/Button";

export type StartSelection =
  | { type: "quick"; drill: QuickDrillKind }
  | { type: "daily"; minutes: 60 | 30 }
  | { type: "free" }
  | { type: "library" };

const QUICK_DRILLS: Array<{ drill: QuickDrillKind; icon: string; tile: string }> = [
  { drill: "warmup", icon: "🔊", tile: "c-green" },
  { drill: "ftt-mini", icon: "🗣", tile: "c-purple" },
  { drill: "roleplay", icon: "💼", tile: "c-orange" },
  { drill: "shadowing", icon: "🎧", tile: "c-blue" },
];

const WEEKDAY_LETTERS: Record<Lang, string[]> = {
  en: ["M", "T", "W", "T", "F", "S", "S"],
  ja: ["月", "火", "水", "木", "金", "土", "日"],
};

/** ローカル日付の YYYY-MM-DD（カレンダー表示用） */
function localYmd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 練習日カレンダー（GitHub風: 列=週・行=曜日、横幅に入るだけ週列を表示）。
 * 実施日の表示のみ — 情報的フィードバックに徹し、連続日数・喪失演出は置かない。
 */
function PracticeCalendar({ days, lang }: { days: string[]; lang: Lang }) {
  const t = STR[lang];
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
        <h3>{t.calendar.title}</h3>
      </div>
      <div className="cal" ref={calRef}>
        <div className="cal-weekdays">
          {WEEKDAY_LETTERS[lang].map((w, i) => (
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
        <span className="day is-done" /> {t.calendar.practiced}
        <span className="day" /> {t.calendar.notYet}
      </div>
    </div>
  );
}

export function StartScreen(props: { onSelect: (sel: StartSelection) => void; lang: Lang }) {
  const t = STR[props.lang];
  const [days, setDays] = useState<string[]>([]);
  const [summary, setSummary] = useState<ProgressSummary | null>(null);
  const [proposalError, setProposalError] = useState(false);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      // カレンダーは補助情報 — 取得失敗でスタート画面を壊さない
      fetchPracticeDays().then((d) => { if (aliveRef.current) setDays(d); }).catch(() => {});
      fetchProgressSummary().then((s) => { if (aliveRef.current) setSummary(s); }).catch(() => {});
    }
    return () => { aliveRef.current = false; };
  }, []);

  const today = new Date();
  const dateLabel = t.hero.date(today);
  // 今日のおすすめ: 日付で決まる決定的ローテーション（クイックドリル4種）
  const dayOfYear = Math.floor((today.getTime() - new Date(today.getFullYear(), 0, 0).getTime()) / 86400000);
  const pick = QUICK_DRILLS[dayOfYear % QUICK_DRILLS.length];
  const pickText = t.drills[pick.drill];

  return (
    <div className="stack">
      <div className="hero">
        <p className="hero-greet">👋 {dateLabel}</p>
        <h2 className="hero-title">{t.hero.title}</h2>
      </div>

      <div>
        <p className="section-label">{t.quick.label} <span className="section-note">{t.quick.note}</span></p>
        <div className="drill-grid">
          {QUICK_DRILLS.map((q) => {
            const d = t.drills[q.drill];
            return (
              <button key={q.drill} className="drill-card" onClick={() => props.onSelect({ type: "quick", drill: q.drill })}>
                <span className={`drill-icon ${q.tile}`} aria-hidden="true">{q.icon}</span>
                <span className="drill-body">
                  <span className="drill-title">{d.title} <span className="drill-min">{d.minutes}</span></span>
                  <span className="drill-desc">{d.desc}</span>
                </span>
                <span className="drill-arrow" aria-hidden="true">→</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <p className="section-label">{t.intensive.label} <span className="section-note">{t.intensive.note}</span></p>
        <div className="drill-grid">
          <button className="drill-card" onClick={() => props.onSelect({ type: "daily", minutes: 60 })}>
            <span className="drill-icon c-green" aria-hidden="true">📋</span>
            <span className="drill-body">
              <span className="drill-title">{t.fullSession.title} <span className="drill-min">{t.fullSession.minutes}</span></span>
              <span className="drill-desc">{t.fullSession.desc}</span>
            </span>
            <span className="drill-arrow" aria-hidden="true">→</span>
          </button>
          <button className="drill-card" onClick={() => props.onSelect({ type: "daily", minutes: 30 })}>
            <span className="drill-icon c-blue" aria-hidden="true">⏱</span>
            <span className="drill-body">
              <span className="drill-title">{t.shortSession.title} <span className="drill-min">{t.shortSession.minutes}</span></span>
              <span className="drill-desc">{t.shortSession.desc}</span>
            </span>
            <span className="drill-arrow" aria-hidden="true">→</span>
          </button>
        </div>
      </div>

      {summary?.proposal && (
        <ProposalCard
          proposal={summary.proposal} lang={props.lang} error={proposalError}
          onAction={async (action) => {
            setProposalError(false);
            try {
              setSummary(await progressLevelAction(action));
            } catch (err) {
              console.warn("level action failed:", err);
              setProposalError(true);
              // 提案カードが実状態と食い違わないよう、最新のsummaryに同期する（提案が消えていればカードも消える）
              try {
                setSummary(await fetchProgressSummary());
              } catch (refetchErr) {
                console.warn("progress summary refetch failed:", refetchErr);
              }
            }
          }}
        />
      )}

      <PracticeCalendar days={days} lang={props.lang} />

      <button className="cta" onClick={() => props.onSelect({ type: "quick", drill: pick.drill })}>
        {t.cta(pickText.title, pickText.minutes)}
      </button>
    </div>
  );
}

/** 昇格/降格の提案カード。根拠を実値で開示する（研究制約: 情報的フィードバック・中立トーン） */
function ProposalCard(props: {
  proposal: LevelProposal; lang: Lang; error: boolean;
  onAction: (action: "accept" | "decline") => void;
}) {
  const t = STR[props.lang].progress;
  const { proposal } = props;
  const r = proposal.rationale;
  const lines: string[] = [];
  if (r.xpReached) lines.push(t.xpReached);
  if (typeof r.practicedDays14 === "number") lines.push(t.practicedDays(r.practicedDays14));
  if (typeof r.completionRate === "number") lines.push(t.completionRate(Math.round(r.completionRate * 100)));
  // 0回中断は根拠として提示する意味がないため、1回以上のときだけ表示する
  if (typeof r.fttAborts === "number" && r.fttAborts > 0 && proposal.kind === "down") lines.push(t.fttAborts(r.fttAborts));
  return (
    <div className="card proposal-card">
      <h3>{proposal.kind === "up" ? t.upTitle : t.downTitle}</h3>
      <p>{proposal.kind === "up" ? t.upBody(proposal.toLevel) : t.downBody(proposal.toLevel)}</p>
      <ul className="text-sm text-muted">
        {lines.map((l, i) => (<li key={i}>{l}</li>))}
      </ul>
      {props.error && <div className="level-edit-error">{t.actionError}</div>}
      <div className="proposal-actions">
        <Button variant="primary" onClick={() => props.onAction("accept")}>
          {proposal.kind === "up" ? t.acceptUp : t.acceptDown}
        </Button>
        <Button variant="secondary" onClick={() => props.onAction("decline")}>{t.decline}</Button>
      </div>
    </div>
  );
}
