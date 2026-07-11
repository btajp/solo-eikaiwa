import { useEffect, useRef, useState } from "react";
import {
  fetchPlacementLatest, fetchPracticeDays, fetchProgressSummary, progressLevelAction,
  type LevelProposal, type PracticeDaysView, type ProgressSummary, type QuickDrillKind, type RoleplayDomain,
} from "../api";
import { STR, type DrillKey, type Lang } from "../i18n";
import { formatYmdLong, formatYmdShort, localYmd } from "../dates";
import { useLoad, type LoadState } from "../useLoad";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { type MenuSource } from "./SessionRunner";
import { calendarLevel } from "../lib/calendar-level";
import {
  placementCalloutKind,
  reservesInitialPlacementSpace,
  type PlacementLatestState,
} from "./placement-callout-state";

export type StartSelection =
  | { type: "session"; source: MenuSource }
  | { type: "free" }
  | { type: "library" }
  | { type: "placement" };

/** クイックドリルカード。ロールプレイはドメイン別に3枚（i18nキーは drillKey で引く） */
const QUICK_DRILLS: Array<{ drill: QuickDrillKind; domain?: RoleplayDomain; drillKey: DrillKey; icon: string; tile: string }> = [
  { drill: "warmup", drillKey: "warmup", icon: "🔊", tile: "c-green" },
  { drill: "ftt-mini", drillKey: "ftt-mini", icon: "🗣", tile: "c-purple" },
  { drill: "shadowing", drillKey: "shadowing", icon: "🎧", tile: "c-blue" },
  { drill: "roleplay", domain: "daily", drillKey: "roleplay-daily", icon: "☕", tile: "c-orange" },
  { drill: "roleplay", domain: "business", drillKey: "roleplay-business", icon: "💼", tile: "c-purple" },
  { drill: "roleplay", domain: "it", drillKey: "roleplay-it", icon: "💻", tile: "c-blue" },
];

const WEEKDAY_LETTERS: Record<Lang, string[]> = {
  en: ["M", "T", "W", "T", "F", "S", "S"],
  ja: ["月", "火", "水", "木", "金", "土", "日"],
};

/**
 * 練習日カレンダー（GitHub風: 列=週・行=曜日、横幅に入るだけ週列を表示）。
 * 実施日の表示のみ — 情報的フィードバックに徹し、連続日数・喪失演出は置かない。
 */
function PracticeCalendar({ state, lang, onRetry }: {
  state: LoadState<PracticeDaysView>; lang: Lang; onRetry: () => void;
}) {
  const t = STR[lang];
  // 横幅に入るだけ週列を表示（セル18px+隙間5px=23px/列、曜日ラベル分を差し引く）
  const calRef = useRef<HTMLDivElement | null>(null);
  const [weekCount, setWeekCount] = useState(8);
  useEffect(() => {
    if (state.status !== "ready") return;
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
  }, [state.status]);

  if (state.status === "loading") {
    return <Card header={t.calendar.title}><p className="text-muted">{t.calendar.loading}</p></Card>;
  }
  if (state.status === "error") {
    return (
      <Card header={t.calendar.title}>
        <Banner kind="error" action={<Button onClick={onRetry}>{t.calendar.retry}</Button>}>
          {t.calendar.loadError}
        </Banner>
      </Card>
    );
  }

  const set = new Set(state.data.days);
  const xpByDay = state.data.xpByDay;
  const today = new Date();
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
    <Card header={t.calendar.title}>
      <p className="visually-hidden">{t.calendar.summary(state.data.days.length)}</p>
      <ul className="visually-hidden">
        {state.data.days.map((ymd) => (
          <li key={ymd}>{t.calendar.dayLabel(formatYmdLong(ymd, lang), xpByDay[ymd] ?? 0)}</li>
        ))}
      </ul>
      <div className="cal" ref={calRef} aria-hidden="true">
        <div className="cal-weekdays">
          {WEEKDAY_LETTERS[lang].map((w, i) => (
            <span key={i}>{w}</span>
          ))}
        </div>
        {weeks.map((col, i) => {
          const isLast = i === weeks.length - 1;
          // 右端（今週）を起点に隔週でラベル表示
          const showLabel = (weeks.length - 1 - i) % 2 === 0;
          const mondayLabel = formatYmdShort(col[0].ymd, lang);
          return (
            <div key={i} className="cal-week">
              {showLabel && <span className={`cal-week-label${isLast ? " is-last" : ""}`}>{mondayLabel}</span>}
              {col.map((c) => {
                const level = calendarLevel(c.done, xpByDay[c.ymd]);
                const xp = xpByDay[c.ymd] ?? 0;
                return (
                  <div
                    key={c.ymd}
                    title={c.isFuture ? undefined : t.calendar.dayLabel(formatYmdLong(c.ymd, lang), xp)}
                    data-level={level > 0 ? level : undefined}
                    className={`day${c.isToday ? " is-today" : ""}${c.isFuture ? " is-future" : ""}`}
                  />
                );
              })}
            </div>
          );
        })}
      </div>
      <div className="cal-legend text-sm text-muted" aria-hidden="true">
        {t.calendar.legendLess}
        {[1, 2, 3, 4].map((lv) => (<span key={lv} className="day" data-level={lv} />))}
        {t.calendar.legendMore}
      </div>
    </Card>
  );
}

export function StartScreen(props: { onSelect: (sel: StartSelection) => void; lang: Lang }) {
  const t = STR[props.lang];
  const tp = STR[props.lang].placement;
  const practiceDays = useLoad(fetchPracticeDays);
  const [summary, setSummary] = useState<ProgressSummary | null>(null);
  const [proposalError, setProposalError] = useState(false);
  const [placementLatest, setPlacementLatest] = useState<PlacementLatestState>("loading");
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  function loadPlacementLatest() {
    setPlacementLatest("loading");
    void fetchPlacementLatest()
      .then((r) => { if (aliveRef.current) setPlacementLatest(r); })
      .catch(() => { if (aliveRef.current) setPlacementLatest("unavailable"); });
  }

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      fetchProgressSummary().then((s) => { if (aliveRef.current) setSummary(s); }).catch(() => {});
      loadPlacementLatest();
    }
    return () => { aliveRef.current = false; };
  }, []);

  // プレースメント導線: 未測定→初回測定 / 前回から30日以上→月次測定 / それ以外は出さない（スペック§6.3, §9）
  const placementCard = placementCalloutKind(placementLatest, Date.now());
  const reservePlacementSpace = reservesInitialPlacementSpace(placementLatest);
  const placementLoading = placementLatest === "loading";
  const showPlacementSlot = reservePlacementSpace || placementCard !== "none";

  const today = new Date();
  const dateLabel = t.hero.date(today);
  // 就寝前レビュー案内（P6-4）: ローカル20時以降のみ・情報的な一言。通知/強制/未達表示はしない
  const showBedtime = today.getHours() >= 20;

  return (
    <div className="stack">
      <div className="hero">
        <p className="hero-greet">👋 {dateLabel}</p>
        <h2 className="hero-title">{t.hero.title}</h2>
      </div>

      {showBedtime && <p className="hero-bedtime text-sm text-muted">{t.hero.bedtime}</p>}

      {/* 結果待ちの枠を先に置き、初回・月次の導線を同じ位置へ描くため、練習カードを後から動かさない。 */}
      {showPlacementSlot && (
        <div
          className={`placement-slot${placementLoading ? " is-loading" : ""}${placementLatest === "unavailable" ? " is-unavailable" : ""}`}
          aria-busy={placementLoading || undefined}
        >
          {placementLoading
            ? <>
                <PlacementCallout kind="new" tp={tp} level={summary?.level ?? 1} onGo={() => {}} hidden />
                <p className="text-muted">{tp.loading}</p>
              </>
            : placementLatest === "unavailable"
              ? <>
                  <PlacementCallout kind="new" tp={tp} level={summary?.level ?? 1} onGo={() => {}} hidden />
                  <p className="text-muted" role="status">
                    {tp.homeLoadError} <Button variant="ghost" onClick={loadPlacementLatest}>{tp.loadRetry}</Button>
                  </p>
                </>
              : placementCard === "new"
                ? <PlacementCallout kind="new" tp={tp} level={summary?.level} onGo={() => props.onSelect({ type: "placement" })} />
                : <PlacementCallout kind="monthly" tp={tp} onGo={() => props.onSelect({ type: "placement" })} />}
        </div>
      )}

      <HomeChoiceGuide
        quick={t.quick}
        warmup={t.drills.warmup}
        onChoose={() => props.onSelect({ type: "session", source: { type: "quick", drill: "warmup" } })}
      />

      <div>
        <p className="section-label">{t.quick.label} <span className="section-note">{t.quick.note}</span></p>
        <div className="drill-grid">
          {QUICK_DRILLS.map((q) => {
            const d = t.drills[q.drillKey];
            return (
              <button key={q.drillKey} className="drill-card" onClick={() => props.onSelect({ type: "session", source: { type: "quick", drill: q.drill, domain: q.domain } })}>
                <span className={`drill-icon ${q.tile}`} aria-hidden="true">{q.icon}</span>
                <span className="drill-body">
                  <span className="drill-title">{d.title} <span className="drill-min">{d.minutes}</span></span>
                  <span className="drill-desc">{d.desc}</span>
                  <span className="drill-meta">{d.requires}</span>
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
          {/* 負荷の軽い順（クイックドリル→30分→60分の流れに合わせる） */}
          <button className="drill-card" onClick={() => props.onSelect({ type: "session", source: { type: "daily", minutes: 30 } })}>
            <span className="drill-icon c-blue" aria-hidden="true">⏱</span>
            <span className="drill-body">
              <span className="drill-title">{t.shortSession.title} <span className="drill-min">{t.shortSession.minutes}</span></span>
              <span className="drill-desc">{t.shortSession.desc}</span>
              <span className="drill-meta">{t.shortSession.requires}</span>
            </span>
            <span className="drill-arrow" aria-hidden="true">→</span>
          </button>
          <button className="drill-card" onClick={() => props.onSelect({ type: "session", source: { type: "daily", minutes: 60 } })}>
            <span className="drill-icon c-green" aria-hidden="true">📋</span>
            <span className="drill-body">
              <span className="drill-title">{t.fullSession.title} <span className="drill-min">{t.fullSession.minutes}</span></span>
              <span className="drill-desc">{t.fullSession.desc}</span>
              <span className="drill-meta">{t.fullSession.requires}</span>
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
              setSummary(await progressLevelAction(action, undefined, summary.proposal!));
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

      <PracticeCalendar state={practiceDays.state} lang={props.lang} onRetry={practiceDays.reload} />
    </div>
  );
}

/** 迷った利用者へ任意の最初の一歩を提示する。選ばなくても通常のカードから自由に始められる。 */
function HomeChoiceGuide(props: {
  quick: (typeof STR)["en"]["quick"];
  warmup: (typeof STR)["en"]["drills"]["warmup"];
  onChoose: () => void;
}) {
  const { quick, warmup } = props;
  return (
    <div className="home-choice" role="note">
      <p className="text-sm text-muted">{quick.oneEnough}</p>
      <button className="home-choice-action" onClick={props.onChoose}>
        <span className="home-choice-label">{quick.suggestionLabel}</span>
        <span className="home-choice-title">{warmup.title} <span className="drill-min">{warmup.minutes}</span></span>
        <span className="home-choice-reason">{quick.suggestionReason}</span>
      </button>
    </div>
  );
}

/** レベル測定への導線。練習メニューではなく「測定」なので drill-card とは別の見た目にする */
function PlacementCallout(props: {
  kind: "new" | "monthly";
  tp: (typeof STR)["en"]["placement"];
  onGo: () => void;
  /** kind==="new"の既定Lv表示に使う現在値（summary未取得の間は表示を見送る） */
  level?: number;
  /** 読込中の高さ確保に使う、支援技術・操作から外したプレースホルダー。 */
  hidden?: boolean;
}) {
  const { kind, tp, level, hidden } = props;
  return (
    <button className="placement-callout" onClick={props.onGo} aria-hidden={hidden || undefined} tabIndex={hidden ? -1 : undefined}>
      <span className="placement-callout-icon" aria-hidden="true">📐</span>
      <span className="drill-body">
        <span className="drill-title">{kind === "new" ? tp.cardTitleNew : tp.cardTitleMonthly}</span>
        <span className="drill-desc">{kind === "new" ? tp.cardBodyNew : tp.cardBodyMonthly}</span>
        {kind === "new" && typeof level === "number" && (
          <span className="drill-desc text-sm text-muted">{tp.startDefaultNote(level)}</span>
        )}
      </span>
      <span className="drill-arrow" aria-hidden="true">→</span>
    </button>
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
  if (proposal.kind === "up") {
    if (typeof r.completionRate === "number") lines.push(t.completionRate(Math.round(r.completionRate * 100)));
  } else {
    // triggers があれば実際に発火した行だけを表示（例: lowOutput起因の降格でcompletionRateがほぼ100%でも
    // 紛らわしい行を出さない）。triggers が無い場合（型上optional）は従来表示にフォールバックする。
    const triggers = r.triggers;
    const fires = (key: "lowCompletion" | "fttAborts" | "lowOutput", fallback: boolean) =>
      triggers ? triggers.includes(key) : fallback;
    if (typeof r.completionRate === "number" && fires("lowCompletion", true)) {
      lines.push(t.completionRate(Math.round(r.completionRate * 100)));
    }
    // 0回中断は根拠として提示する意味がないため、フォールバック時は1回以上のときだけ表示する
    if (typeof r.fttAborts === "number" && fires("fttAborts", r.fttAborts > 0)) lines.push(t.fttAborts(r.fttAborts));
    if (typeof r.lowOutputRounds === "number" && fires("lowOutput", r.lowOutputRounds > 0)) lines.push(t.lowOutput(r.lowOutputRounds));
  }
  return (
    <Card className="ring-primary" header={proposal.kind === "up" ? t.upTitle : t.downTitle}>
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
    </Card>
  );
}
