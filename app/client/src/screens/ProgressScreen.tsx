import { useEffect, useRef, useState } from "react";
import {
  fetchLatestMonthlyReport, fetchMetricsSummary, fetchMonthlyReportList, requestMonthlyReport,
  type MonthlyReport, type MonthlyReportPreview,
} from "../api";
import { STR, type Lang } from "../i18n";
import { useLoad } from "../useLoad";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

function fmtMin(sec: number): string {
  return (sec / 60).toFixed(1);
}

/** 前週比の中立矢印（情報表示のみ — 良し悪しの色付けはしない） */
function trendArrow(cur: number, prev: number): string {
  if (prev === 0 || cur === 0) return "→";
  const diff = (cur - prev) / prev;
  if (diff > 0.05) return "↑";
  if (diff < -0.05) return "↓";
  return "→";
}

export function ProgressScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].progress;
  const { state, reload } = useLoad(() => fetchMetricsSummary(14));

  if (state.status === "loading") return <p className="text-muted">{t.loading}</p>;
  if (state.status === "error") {
    return <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{state.error}</Banner>;
  }
  const summary = state.data;

  const days = summary.days;
  const hasData = days.some((d) => d.utterances > 0);
  if (!hasData) {
    return (
      <div className="stack">
        <h2 className="screen-title">{t.title}</h2>
        <Card><p className="text-muted">{t.empty}</p></Card>
        <MonthlyReview lang={lang} />
      </div>
    );
  }

  const maxSec = Math.max(...days.map((d) => d.speakingSec), 1);
  const maxWpm = Math.max(...days.map((d) => d.avgArticulationWpm), 1);
  const spoken = days.filter((d) => d.utterances > 0);
  const lastWeek = spoken.filter((d) => d.ymd >= days[days.length - 7].ymd);
  const prevWeek = spoken.filter((d) => d.ymd < days[days.length - 7].ymd);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const pauseCur = avg(lastWeek.map((d) => d.avgPauseRatio));
  const pausePrev = avg(prevWeek.map((d) => d.avgPauseRatio));
  const repCur = avg(lastWeek.map((d) => d.repetitionRatio));
  const repPrev = avg(prevWeek.map((d) => d.repetitionRatio));

  return (
    <div className="stack">
      <h2 className="screen-title">{t.title}</h2>

      <Card>
        <div className="card-header"><h3>{t.speakingTime}</h3></div>
        <div className="metric-bars">
          {days.map((d) => (
            <div key={d.ymd} className="metric-bar-col" title={`${d.ymd}: ${fmtMin(d.speakingSec)}${t.speakingMinUnit}`}>
              <div className="metric-bar" style={{ height: `${Math.round((d.speakingSec / maxSec) * 100)}%` }} />
              <span className="metric-bar-label">{Number(d.ymd.slice(8, 10))}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <div className="card-header"><h3>{t.articulation}</h3></div>
        <div className="stack-sm">
          {days.filter((d) => d.utterances > 0).map((d) => (
            <div key={d.ymd} className="hbar-row">
              <span className="hbar-label">{d.ymd.slice(5)}</span>
              <div className="hbar-track">
                <div className="hbar" style={{ width: `${Math.round((d.avgArticulationWpm / maxWpm) * 100)}%` }} />
              </div>
              <span className="hbar-value">{d.avgArticulationWpm} {t.articulationUnit}</span>
            </div>
          ))}
        </div>
      </Card>

      <div className="metric-cards">
        <Card>
          <div className="stat-title">{t.pauseCard}</div>
          <div className="stat-main">{(pauseCur * 100).toFixed(1)}<span className="stat-unit">%</span></div>
          <div className="stat-sub">{trendArrow(pauseCur, pausePrev)} {t.weekOverWeek}</div>
        </Card>
        <Card>
          <div className="stat-title">{t.repetitionCard}</div>
          <div className="stat-main">{(repCur * 100).toFixed(1)}<span className="stat-unit">%</span></div>
          <div className="stat-sub">{trendArrow(repCur, repPrev)} {t.weekOverWeek}</div>
        </Card>
      </div>

      <Card>
        <div className="card-header"><h3>{t.levelHistory}</h3></div>
        <p className="text-sm text-muted">{t.currentLevel(summary.level.current)}</p>
        {summary.level.history.length > 0 && (
          <ul className="level-history">
            {summary.level.history.map((h) => (
              <li key={h.ymd}><span className="text-muted">{h.ymd}</span> → Lv {h.level}</li>
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
  const [report, setReport] = useState<MonthlyReport | null>(null);
  const [past, setPast] = useState<MonthlyReportPreview[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      load();
    }
    return () => { aliveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    try {
      const [latest, list] = await Promise.all([fetchLatestMonthlyReport(), fetchMonthlyReportList()]);
      if (!aliveRef.current) return;
      setReport(latest);
      setPast(list.filter((r) => r.id !== latest?.id));
    } catch (err) {
      console.warn("monthly review load failed:", err);
    }
  }

  async function generate() {
    setGenerating(true);
    setError(false);
    try {
      const { report: r } = await requestMonthlyReport();
      if (!aliveRef.current) return;
      setReport(r);
      // 一覧は次回表示時に更新されれば十分だが、その場で整合させる
      setPast((p) => p.filter((x) => x.id !== r.id));
    } catch (err) {
      console.warn("monthly review generate failed:", err);
      if (aliveRef.current) setError(true);
    } finally {
      if (aliveRef.current) setGenerating(false);
    }
  }

  const THIRTY_DAYS_MS = 30 * 86400000;
  const canGenerate = !report || Date.now() - Date.parse(report.ts) >= THIRTY_DAYS_MS;

  return (
    <Card>
      <div className="card-header"><h3>{t.monthlyReview}</h3></div>
      {report ? (
        <>
          <p className="text-sm text-muted">{t.mrDate(report.ymd)}</p>
          <p className="report-text">{report.text}</p>
        </>
      ) : (
        <p className="text-muted">{t.mrEmpty}</p>
      )}
      {canGenerate && (
        <Button variant="secondary" onClick={generate} loading={generating} disabled={generating}>
          {generating ? t.mrGenerating : t.mrGenerate}
        </Button>
      )}
      {error && <Banner kind="error">{t.mrError}</Banner>}
      {past.length > 0 && (
        <div className="mr-past">
          <p className="text-sm text-muted">{t.mrPast}</p>
          <ul className="mr-past-list">
            {past.map((r) => (
              <li key={r.id}>
                <button className="mr-past-item" onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}>
                  <span className="text-muted">{r.ymd}</span> {expandedId === r.id ? "" : `${r.preview}…`}
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
