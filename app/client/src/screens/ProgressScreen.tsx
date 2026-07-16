import { useEffect, useRef, useState } from "react";
import {
  fetchLatestMonthlyReport, fetchMetricsSummary, fetchMonthlyReportList, requestMonthlyReport,
  type MonthlyReport,
} from "../api";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { canGenerateMonthlyReview, formatYmdLong, formatYmdShort } from "../dates";
import { monthlyReviewDisplay } from "../monthly-review-display";
import { weeklyRateView, type WeeklyRateView } from "../metric-reliability";
import { useLoad } from "../useLoad";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

function fmtMin(sec: number): string {
  return (sec / 60).toFixed(1);
}

/** 前週比の中立矢印（情報表示のみ — 良し悪しの色付けはしない） */
const TREND_ARROW = { up: "↑", down: "↓", flat: "→" } as const;

/**
 * ポーズ比率・言い直し率の週次カード。ASR区切り由来の推定値なので、
 * データが疎な週は率や前週比を確定値として見せず「まだ少ない」ことを表示する。
 */
function WeeklyRateCard({ title, ratio, view, note, weekOverWeek, lowSample, noTrendData }: {
  title: string; ratio: number; view: WeeklyRateView; note?: string;
  weekOverWeek: string; lowSample: string; noTrendData: string;
}) {
  return (
    <Card>
      <div className="stat-title">{title}</div>
      {view.kind === "insufficient" ? (
        <>
          <div className="stat-main" aria-hidden="true">—</div>
          <div className="stat-sub">{lowSample}</div>
        </>
      ) : (
        <>
          <div className="stat-main">{(ratio * 100).toFixed(1)}<span className="stat-unit">%</span></div>
          <div className="stat-sub">
            {view.trend === null ? noTrendData : `${TREND_ARROW[view.trend]} ${weekOverWeek}`}
          </div>
        </>
      )}
      {note && <p className="text-sm text-muted stat-note">{note}</p>}
    </Card>
  );
}

export function ProgressScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].progress;
  const { state, reload } = useLoad(() => fetchMetricsSummary(14));
  const pageHero = <div className="hero"><h2 className="hero-title">{t.title}</h2></div>;

  if (state.status === "loading") {
    return <div className="stack">{pageHero}<p className="text-muted">{t.loading}</p></div>;
  }
  if (state.status === "error") {
    return (
      <div className="stack">
        {pageHero}
        <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{formatClientError(lang, state.error, "load")}</Banner>
      </div>
    );
  }
  const summary = state.data;

  const days = summary.days;
  const hasData = days.some((d) => d.utterances > 0);
  if (!hasData) {
    return (
      <div className="stack">
        {pageHero}
        <Card><p className="text-muted">{t.empty}</p></Card>
        <MonthlyReview lang={lang} />
      </div>
    );
  }

  const maxSec = Math.max(...days.map((d) => d.speakingSec), 1);
  const maxWpm = Math.max(...days.map((d) => d.avgArticulationWpm), 1);
  const { current: week, previous: prevWeek } = summary.weekly;
  const pauseView = weeklyRateView(week, prevWeek, week.avgPauseRatio, prevWeek.avgPauseRatio);
  const repView = weeklyRateView(week, prevWeek, week.repetitionRatio, prevWeek.repetitionRatio);

  return (
    <div className="stack">
      {pageHero}

      <Card header={t.speakingTime}>
        <ul className="visually-hidden">
          {days.map((d) => (
            <li key={d.ymd}>{t.speakingDay(formatYmdLong(d.ymd, lang), fmtMin(d.speakingSec))}</li>
          ))}
        </ul>
        <div className="metric-bars" aria-hidden="true">
          {days.map((d) => (
            <div key={d.ymd} className="metric-bar-col" title={`${formatYmdLong(d.ymd, lang)}: ${fmtMin(d.speakingSec)}${t.speakingMinUnit}`}>
              <div className="metric-bar" style={{ height: `${Math.round((d.speakingSec / maxSec) * 100)}%` }} />
              <span className="metric-bar-label">{formatYmdShort(d.ymd, lang)}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card header={t.articulation}>
        <ul className="visually-hidden">
          {days.filter((d) => d.utterances > 0).map((d) => (
            <li key={d.ymd}>{t.articulationDay(formatYmdLong(d.ymd, lang), d.avgArticulationWpm)}</li>
          ))}
        </ul>
        <div className="stack-sm" aria-hidden="true">
          {days.filter((d) => d.utterances > 0).map((d) => (
            <div key={d.ymd} className="hbar-row">
              <span className="hbar-label">{formatYmdShort(d.ymd, lang)}</span>
              <div className="hbar-track">
                <div className="hbar" style={{ width: `${Math.round((d.avgArticulationWpm / maxWpm) * 100)}%` }} />
              </div>
              <span className="hbar-value">{d.avgArticulationWpm} {t.articulationUnit}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="metric-cards">
        <WeeklyRateCard
          title={t.pauseCard} ratio={week.avgPauseRatio} view={pauseView} note={t.pauseNote}
          weekOverWeek={t.weekOverWeek} lowSample={t.lowSample} noTrendData={t.noTrendData}
        />
        <WeeklyRateCard
          title={t.repetitionCard} ratio={week.repetitionRatio} view={repView}
          weekOverWeek={t.weekOverWeek} lowSample={t.lowSample} noTrendData={t.noTrendData}
        />
      </div>
      <p className="text-sm text-muted">{t.estimateNote}</p>

      <Card header={t.levelHistory}>
        <p className="text-sm text-muted">{t.currentLevel(summary.level.current)}</p>
        {summary.level.history.length > 0 && (
          <ul className="level-history">
            {summary.level.history.map((h) => (
              <li key={h.ymd}><span className="text-muted">{formatYmdLong(h.ymd, lang)}</span> → Lv {h.level}</li>
            ))}
          </ul>
        )}
      </Card>

      <MonthlyReview lang={lang} />
    </div>
  );
}

/** 月次レビュー: 最新の全文 + 生成導線 + 過去一覧。自己完結（メトリクス取得の失敗と独立） */
function MonthlyReview({ lang }: { lang: Lang }) {
  const t = STR[lang].progress;
  const latest = useLoad(fetchLatestMonthlyReport);
  const history = useLoad(fetchMonthlyReportList);
  const [generatedReport, setGeneratedReport] = useState<MonthlyReport | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState(false);
  const [alreadyGenerated, setAlreadyGenerated] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  async function generate() {
    setGenerating(true);
    setGenerateError(false);
    setAlreadyGenerated(false);
    try {
      const { report: r, cached } = await requestMonthlyReport();
      if (!aliveRef.current) return;
      setGeneratedReport(r);
      // 今月分が既にある場合はサーバが既存を返す（cached）。無反応に見えないよう情報表示する
      if (cached) setAlreadyGenerated(true);
    } catch (err) {
      if (!aliveRef.current) return;
      console.warn("monthly review generate failed:", err);
      setGenerateError(true);
    } finally {
      if (aliveRef.current) setGenerating(false);
    }
  }

  const display = monthlyReviewDisplay(latest.state, history.state, generatedReport);
  const canGenerate = display.latestKnown && canGenerateMonthlyReview(display.report?.ymd ?? null);

  return (
    <Card header={t.monthlyReview}>
      {display.latestStatus === "loading" && <p className="text-muted">{t.mrLoading}</p>}
      {display.latestStatus === "error" && (
        <Banner kind="error" action={<Button onClick={latest.reload}>{t.retry}</Button>}>
          {t.mrLoadError}
        </Banner>
      )}
      {display.latestStatus === "ready" && (display.report ? (
        <>
          <p className="text-sm text-muted">{t.mrDate(formatYmdLong(display.report.ymd, lang))}</p>
          <p className="report-text">{display.report.text}</p>
        </>
      ) : (
        <p className="text-muted">{t.mrEmpty}</p>
      ))}
      {canGenerate && (
        <Button variant="secondary" onClick={generate} loading={generating} disabled={generating}>
          {generating ? t.mrGenerating : t.mrGenerate}
        </Button>
      )}
      {generateError && <Banner kind="error">{t.mrError}</Banner>}
      {alreadyGenerated && <Banner kind="info">{t.mrAlreadyThisMonth}</Banner>}
      {display.historyStatus === "loading" && <p className="text-muted">{t.mrHistoryLoading}</p>}
      {display.historyStatus === "error" && (
        <Banner kind="error" action={<Button onClick={history.reload}>{t.retry}</Button>}>
          {t.mrHistoryLoadError}
        </Banner>
      )}
      {display.past.length > 0 && (
        <div className="mr-past">
          <p className="text-sm text-muted">{t.mrPast}</p>
          <ul className="mr-past-list">
            {display.past.map((r) => (
              <li key={r.id}>
                <button className="mr-past-item" onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}>
                  <span className="text-muted">{formatYmdShort(r.ymd, lang)}</span> {expandedId === r.id ? "" : `${r.preview}…`}
                </button>
                {expandedId === r.id && <p className="report-text">{r.text}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
