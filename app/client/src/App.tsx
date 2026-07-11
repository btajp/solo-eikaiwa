import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  fetchPracticeDays, fetchProgressSummary, getHealth, onProgressUpdate, progressLevelAction,
  sessionEnd, sessionEndKeepalive, sessionStart,
  type Health, type ProgressSummary,
} from "./api";
import { isDesktopContext } from "./audio";
import { isHomeNavigationActive } from "./navigation-state";
import { parseRouteHash, routeHash, type ParsedRoute, type RouteMode } from "./route-state";
import { loadLang, saveLang, STR, type Lang } from "./i18n";
import { AboutScreen } from "./screens/AboutScreen";
import { FeedbackScreen } from "./screens/FeedbackScreen";
import { FreeTalkScreen } from "./screens/FreeTalkScreen";
import { LibraryScreen } from "./screens/LibraryScreen";
import { ListeningScreen } from "./screens/ListeningScreen";
import { PlacementScreen } from "./screens/PlacementScreen";
import { ProgressScreen } from "./screens/ProgressScreen";
import { SentencesScreen } from "./screens/SentencesScreen";
import { SessionRunner, type MenuSource } from "./screens/SessionRunner";
import { StartScreen, type StartSelection } from "./screens/StartScreen";
import { SettingsScreen, type UiScale } from "./screens/SettingsScreen";
import { Banner } from "./ui/Banner";
import { Button } from "./ui/Button";
import { SetupBanner } from "./ui/SetupBanner";
import { localYmd } from "./dates";
import { saveSupport, useSupport, type SupportToggle } from "./support";
import { dismissLlmNotice, isLlmNoticeDismissed, shouldShowLlmNotice } from "./lib/llm-notice";
import { missingDeps } from "./lib/dep-banner";
import {
  missingPracticeCapabilities, startSelectionNeedsRecordingReadiness, type PracticeCapability,
} from "./lib/practice-readiness";
import {
  dismissSetupBanner, isSetupBannerDismissed, resumeSetupBanner, shouldShowSetupBanner, shouldShowSetupResume,
} from "./lib/whisper-setup";
import { healthRetryDelay } from "./lib/health-retry";
import { reportClientError } from "./api/http";

type SessionMode = { kind: "session"; source: MenuSource; sessionId: string };
type Mode = RouteMode | SessionMode;
type PendingNavigation = { target: RouteMode; source: "history" | "navigation" };

/** 依存不足バナー（dev文脈）での表示名。health のフィールド名と実際のバイナリ名が異なるもののみ変換する */
const DEP_DISPLAY_NAME: Record<string, string> = { whisper: "whisper-cli" };

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [serverDown, setServerDown] = useState(false);
  const healthAliveRef = useRef(true);
  const healthTimerRef = useRef<number | null>(null);
  const healthRetryAttemptRef = useRef(0);
  const healthGenerationRef = useRef(0);
  // Tauri配布アプリ内かどうか（UAマーカー判定・audio.ts参照）。バナー文言・依存判定の文脈分岐に使う
  const desktop = isDesktopContext();
  const missing = missingDeps(health, desktop);
  // Claude/Codex/ローカルLLM未導入時の一度きりの案内バナー（研究制約: 情報的トーンのみ・ブロックしない）。
  // 既読状態はユーザーが実際に閉じるまで再訪のたびに出る（lib/llm-notice.ts 参照）
  const [llmNoticeDismissed, setLlmNoticeDismissed] = useState(() => isLlmNoticeDismissed());
  // whisperモデル未導入時の一度きりのセットアップ案内（同じく情報的トーン・lib/whisper-setup.ts 参照）
  const [setupBannerDismissed, setSetupBannerDismissed] = useState(() => isSetupBannerDismissed());
  // 録音系の開始を止めた場合だけ表示する、機能固有の準備案内。初期バナーを閉じても消えない。
  const [blockedCapabilities, setBlockedCapabilities] = useState<PracticeCapability[] | null>(null);
  const initialRouteRef = useRef<ParsedRoute>(parseRouteHash(window.location.hash));
  const [mode, setMode] = useState<Mode>(() => initialRouteRef.current.mode);
  const modeRef = useRef<Mode>(initialRouteRef.current.mode);
  const [routeNotice, setRouteNotice] = useState(initialRouteRef.current.notice);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const restoringSessionHistoryRef = useRef(false);
  const allowingSessionHistoryLeaveRef = useRef(false);
  const [lang, setLang] = useState<Lang>(() => {
    const initialLang = loadLang();
    document.documentElement.lang = initialLang;
    return initialLang;
  });
  const t = STR[lang];
  function switchLang(next: Lang) {
    document.documentElement.lang = next;
    setLang(next);
    saveLang(next);
  }
  // 文字サイズ（小/中/大）。tokens.css の :root[data-ui-scale] が --fs-* を切り替える
  const [uiScale, setUiScale] = useState<UiScale>(() => {
    const v = localStorage.getItem("ui.scale");
    return v === "small" || v === "large" || v === "xlarge" ? v : "medium";
  });
  useEffect(() => {
    document.documentElement.dataset.uiScale = uiScale;
    localStorage.setItem("ui.scale", uiScale);
  }, [uiScale]);
  // このタブのライフサイクルを識別するUUID。単独の自由会話にも使う。
  // 通し・クイック練習は開始ごとに別IDを発行し、振り返りとblock/roundイベントをその練習へ束縛する。
  const [sessionId] = useState(() => crypto.randomUUID());
  // StrictMode の開発時二重マウントで session_start が重複記録されないようにする冪等ガード
  const startedRef = useRef(false);
  // サイドバー「自主練」見出し横の ⓘ ポップオーバー開閉
  const [selfHintOpen, setSelfHintOpen] = useState(false);

  const clearHealthRetry = useCallback(() => {
    if (healthTimerRef.current !== null) {
      window.clearTimeout(healthTimerRef.current);
      healthTimerRef.current = null;
    }
  }, []);

  const refetchHealth = useCallback((resetRetry = true) => {
    if (resetRetry) {
      healthRetryAttemptRef.current = 0;
      clearHealthRetry();
    }
    const generation = healthGenerationRef.current + 1;
    healthGenerationRef.current = generation;
    getHealth()
      .then((h) => {
        if (!healthAliveRef.current || healthGenerationRef.current !== generation) return;
        clearHealthRetry();
        healthRetryAttemptRef.current = 0;
        setHealth(h);
        setServerDown(false);
      })
      .catch((error) => {
        if (!healthAliveRef.current || healthGenerationRef.current !== generation) return;
        reportClientError(error);
        setHealth(null);
        setServerDown(true);
        const attempt = healthRetryAttemptRef.current + 1;
        const delay = healthRetryDelay(attempt);
        if (delay === null) return;
        healthRetryAttemptRef.current = attempt;
        healthTimerRef.current = window.setTimeout(() => {
          healthTimerRef.current = null;
          refetchHealth(false);
        }, delay);
      });
  }, [clearHealthRetry]);

  function setCurrentMode(next: Mode) {
    modeRef.current = next;
    setMode(next);
  }

  function modeHash(next: Mode): string {
    return next.kind === "session" ? "#/session" : routeHash(next);
  }

  function transitionTo(next: Mode, options: { replace?: boolean; writeHistory?: boolean } = {}) {
    const current = modeRef.current;
    setBlockedCapabilities(null);
    // 設定でLLMを更新した後、次の画面ではhealthを取り直して録音開始可否を再評価する。
    if (current.kind === "settings" && next.kind !== "settings") refetchHealth();
    setRouteNotice(null);
    setPendingNavigation(null);
    setCurrentMode(next);

    if (options.writeHistory === false) return;
    const nextHash = modeHash(next);
    const currentHash = modeHash(current);
    if (options.replace) {
      window.history.replaceState(null, "", nextHash);
    } else if (nextHash !== currentHash) {
      window.history.pushState(null, "", nextHash);
    }
  }

  function applyRouteFromHistory(parsed: ParsedRoute) {
    const current = modeRef.current;
    setBlockedCapabilities(null);
    if (current.kind === "settings" && parsed.mode.kind !== "settings") refetchHealth();
    setPendingNavigation(null);
    setRouteNotice(parsed.notice);
    setCurrentMode(parsed.mode);
    if (parsed.notice) window.history.replaceState(null, "", routeHash(parsed.mode));
  }

  function requestNavigation(next: RouteMode) {
    if (modeRef.current.kind === "session") {
      setPendingNavigation({ target: next, source: "navigation" });
      return;
    }
    transitionTo(next);
  }

  function leavePendingNavigation() {
    if (!pendingNavigation) return;
    if (pendingNavigation.source === "history") {
      allowingSessionHistoryLeaveRef.current = true;
      setPendingNavigation(null);
      window.history.go(-1);
      return;
    }
    transitionTo(pendingNavigation.target, { replace: true });
  }

  function requestRecordingStart(): boolean {
    const missingCapabilities = missingPracticeCapabilities(health);
    if (missingCapabilities.length > 0) {
      setBlockedCapabilities(missingCapabilities);
      return false;
    }
    setBlockedCapabilities(null);
    return true;
  }

  function reopenSetup() {
    resumeSetupBanner();
    setSetupBannerDismissed(false);
  }

  useEffect(() => {
    // 存在しないURLと直接開いたセッションURLは、説明を残して安定したHome URLへ正規化する。
    if (initialRouteRef.current.notice) {
      window.history.replaceState(null, "", routeHash(initialRouteRef.current.mode));
    }
  }, []);

  useEffect(() => {
    const onPopState = () => {
      if (restoringSessionHistoryRef.current) {
        restoringSessionHistoryRef.current = false;
        return;
      }
      const parsed = parseRouteHash(window.location.hash);
      if (allowingSessionHistoryLeaveRef.current) {
        allowingSessionHistoryLeaveRef.current = false;
        applyRouteFromHistory(parsed);
        return;
      }
      if (modeRef.current.kind === "session") {
        // 戻る操作で進行中フローを即時unmountせず、同じ履歴位置へ戻して選択を求める。
        restoringSessionHistoryRef.current = true;
        window.history.go(1);
        setPendingNavigation({ target: parsed.mode, source: "history" });
        return;
      }
      applyRouteFromHistory(parsed);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [refetchHealth]);

  useEffect(() => {
    healthAliveRef.current = true;
    refetchHealth();
    if (!startedRef.current) {
      startedRef.current = true;
      sessionStart(sessionId);
    }
    const onPageHide = () => sessionEndKeepalive(sessionId);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      healthAliveRef.current = false;
      healthGenerationRef.current += 1;
      clearHealthRetry();
      window.removeEventListener("pagehide", onPageHide);
      sessionEnd(sessionId);
    };
  }, [clearHealthRetry, refetchHealth, sessionId]);

  function onSelect(sel: StartSelection) {
    if (startSelectionNeedsRecordingReadiness(sel) && !requestRecordingStart()) return;
    if (sel.type === "free") requestNavigation({ kind: "free" });
    else if (sel.type === "library") requestNavigation({ kind: "library" });
    else if (sel.type === "placement") requestNavigation({ kind: "placement" });
    else transitionTo({ kind: "session", source: sel.source, sessionId: crypto.randomUUID() });
  }

  type NavSection = "today" | "self" | "records";
  const navItems: Array<{ key: string; icon: string; label: string; active: boolean; go: () => void; section: NavSection }> = [
    { key: "home", icon: "🏠", label: t.nav.home, active: isHomeNavigationActive(mode.kind), go: () => requestNavigation({ kind: "start" }), section: "today" },
    { key: "placement", icon: "📐", label: t.nav.placement, active: mode.kind === "placement", go: () => onSelect({ type: "placement" }), section: "records" },
    { key: "free", icon: "💬", label: t.nav.free, active: mode.kind === "free", go: () => onSelect({ type: "free" }), section: "self" },
    { key: "library", icon: "📚", label: t.nav.library, active: mode.kind === "library", go: () => requestNavigation({ kind: "library" }), section: "records" },
    { key: "sentences", icon: "📖", label: t.nav.sentences, active: mode.kind === "sentences", go: () => requestNavigation({ kind: "sentences" }), section: "self" },
    { key: "listening", icon: "🎧", label: t.nav.listening, active: mode.kind === "listening", go: () => requestNavigation({ kind: "listening" }), section: "self" },
    { key: "progress", icon: "📈", label: t.nav.progress, active: mode.kind === "progress", go: () => requestNavigation({ kind: "progress" }), section: "records" },
    { key: "feedback", icon: "📝", label: t.nav.feedback, active: mode.kind === "feedback", go: () => requestNavigation({ kind: "feedback" }), section: "records" },
    { key: "settings", icon: "⚙️", label: t.nav.settings, active: mode.kind === "settings", go: () => requestNavigation({ kind: "settings" }), section: "records" },
  ];
  const navSections: Array<{ key: NavSection; label: string }> = [
    { key: "today", label: t.nav.sectionToday },
    { key: "self", label: t.nav.sectionSelf },
    { key: "records", label: t.nav.sectionRecords },
  ];

  return (
    <div className="shell">
      <aside className="sidebar">
        <h1 className="app-brand"><span className="brand-mark" aria-hidden="true" />solo-eikaiwa</h1>
        <nav className="side-nav" aria-label={t.nav.navigationLabel}>
          {navSections.map((sec) => (
            <Fragment key={sec.key}>
              <p className="side-section">
                {sec.label}
                {sec.key === "self" && (
                  <button
                    className="info-btn"
                    aria-label={t.support.helpAriaSuffix(sec.label)}
                    title={t.nav.selfStudyHint}
                    aria-expanded={selfHintOpen}
                    aria-controls="self-study-hint"
                    onClick={() => setSelfHintOpen((v) => !v)}
                  >ⓘ</button>
                )}
              </p>
              {sec.key === "self" && selfHintOpen && (
                <div id="self-study-hint" className="info-pop">{t.nav.selfStudyHint}</div>
              )}
              {navItems.filter((n) => n.section === sec.key).map((n) => (
                <button key={n.key} className={`side-item${n.active ? " is-active" : ""}`} aria-current={n.active ? "page" : undefined} onClick={n.go}>
                  <span className="side-icon" aria-hidden="true">{n.icon}</span>
                  <span className="side-label">{n.label}</span>
                </button>
              ))}
            </Fragment>
          ))}
        </nav>
        {mode.kind === "session" && (
          <Button variant="secondary" onClick={() => requestNavigation({ kind: "start" })}>{t.appShell.backToHome}</Button>
        )}
        <div className="sidebar-spacer" />
        <div className="sidebar-quick">
          <div className="lang-toggle" role="group" aria-label={t.appShell.textSize}>
            {(["small", "medium", "large", "xlarge"] as const).map((sc) => (
              <button key={sc} className={uiScale === sc ? "is-active" : ""} aria-pressed={uiScale === sc} onClick={() => setUiScale(sc)}>{t.uiScale[sc]}</button>
            ))}
          </div>
          <div className="lang-toggle" role="group" aria-label={t.appShell.language}>
            <button className={lang === "en" ? "is-active" : ""} aria-pressed={lang === "en"} onClick={() => switchLang("en")}>EN</button>
            <button className={lang === "ja" ? "is-active" : ""} aria-pressed={lang === "ja"} onClick={() => switchLang("ja")}>日本語</button>
          </div>
        </div>
        <SupportPanel lang={lang} />
        <PracticeStat lang={lang} />
        <div className="sidebar-links">
          <a className="side-link" href="https://github.com/btajp/solo-eikaiwa" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
          </a>
          <button className={`side-link${mode.kind === "about" ? " is-active" : ""}`} aria-current={mode.kind === "about" ? "page" : undefined} onClick={() => requestNavigation({ kind: "about" })}>{t.about.title}</button>
        </div>
      </aside>
      <main className="app">
      {routeNotice && (
        <Banner kind="info">{routeNotice === "unknown" ? t.routes.unknown : t.routes.sessionNotRestored}</Banner>
      )}
      {pendingNavigation && (
        <Banner
          kind="info"
          action={
            <>
              <Button variant="secondary" onClick={() => setPendingNavigation(null)}>{t.routes.stay}</Button>
              <Button variant="primary" onClick={leavePendingNavigation}>{t.routes.leave}</Button>
            </>
          }
        >
          {t.routes.leaveSession}
        </Banner>
      )}
      {serverDown && (
        <Banner kind="error" action={<Button variant="secondary" onClick={() => refetchHealth()}>{t.banners.retry}</Button>}>
          {desktop ? t.banners.serverDownDesktop : t.banners.serverDownDev}
        </Banner>
      )}
      {!serverDown && missing.length > 0 && (
        <Banner kind="error">
          {desktop
            ? t.banners.depsMissingDesktop
            : t.banners.depsMissingDev(missing.map((d) => DEP_DISPLAY_NAME[d] ?? d).join(", "))}
        </Banner>
      )}
      {!serverDown && !desktop && health && health.ok && !health.ttsKey && (
        <Banner kind="warn">{t.banners.ttsKeyMissing}</Banner>
      )}
      {!serverDown && shouldShowLlmNotice(health, llmNoticeDismissed) && (
        <Banner
          kind="info"
          action={
            <>
              <a href="https://github.com/btajp/solo-eikaiwa#前提条件" target="_blank" rel="noopener noreferrer">
                {t.llmNotice.linkLabel}
              </a>
              <Button
                variant="ghost"
                ariaLabel={t.llmNotice.dismissAriaLabel}
                onClick={() => { dismissLlmNotice(); setLlmNoticeDismissed(true); }}
              >×</Button>
            </>
          }
        >
          {t.llmNotice.body}
        </Banner>
      )}
      {!serverDown && shouldShowSetupBanner(health, setupBannerDismissed) && (
        <SetupBanner
          lang={lang}
          onDismiss={() => { dismissSetupBanner(); setSetupBannerDismissed(true); }}
          onModelReady={refetchHealth}
        />
      )}
      {!serverDown && shouldShowSetupResume(health, setupBannerDismissed) && (
        <Banner kind="info" action={<Button variant="secondary" onClick={reopenSetup}>{t.setup.resumeBannerAction}</Button>}>
          {t.setup.resumeBannerBody}
        </Banner>
      )}
      {blockedCapabilities && (
        <PracticeReadinessBanner
          lang={lang}
          missing={missingPracticeCapabilities(health, blockedCapabilities)}
          onOpenSetup={reopenSetup}
          onOpenSettings={() => requestNavigation({ kind: "settings" })}
        />
      )}
      {mode.kind === "start" && <StartScreen onSelect={onSelect} lang={lang} />}
      {mode.kind === "session" && (
        <SessionRunner
          source={mode.source} sessionId={mode.sessionId} lang={lang}
          onBeforeRecording={requestRecordingStart} onExit={() => transitionTo({ kind: "start" }, { replace: true })}
          onOpenCollectedPhrases={() => transitionTo({ kind: "sentences", tab: "browse" }, { replace: true })}
        />
      )}
      {mode.kind === "free" && <FreeTalkScreen activitySessionId={sessionId} lang={lang} onBeforeRecord={requestRecordingStart} />}
      {mode.kind === "library" && <LibraryScreen lang={lang} />}
      {mode.kind === "sentences" && (
        <SentencesScreen
          lang={lang}
          initialTab={mode.tab}
          onTabChange={(tab) => transitionTo({ kind: "sentences", tab })}
        />
      )}
      {mode.kind === "listening" && <ListeningScreen lang={lang} />}
      {mode.kind === "placement" && (
        <PlacementScreen lang={lang} onBeforeStart={requestRecordingStart} onExit={() => requestNavigation({ kind: "start" })} />
      )}
      {mode.kind === "progress" && <ProgressScreen lang={lang} />}
      {mode.kind === "feedback" && <FeedbackScreen lang={lang} />}
      {mode.kind === "settings" && (
        <SettingsScreen lang={lang} uiScale={uiScale} setUiScale={setUiScale} switchLang={switchLang} onHealthChanged={refetchHealth} />
      )}
      {mode.kind === "about" && <AboutScreen lang={lang} />}
      </main>
    </div>
  );
}

/** 録音系CTAからの事前確認。設定不足の理由と復旧操作を同じ場所に表示する。 */
function PracticeReadinessBanner({
  lang, missing, onOpenSetup, onOpenSettings,
}: {
  lang: Lang;
  missing: PracticeCapability[];
  onOpenSetup: () => void;
  onOpenSettings: () => void;
}) {
  if (missing.length === 0) return null;
  const t = STR[lang].practiceReadiness;
  const needsStt = missing.includes("stt");
  const needsLlm = missing.includes("llm");
  const body = needsStt && needsLlm ? t.sttAndLlmNeeded : needsStt ? t.sttNeeded : t.llmNeeded;
  return (
    <Banner
      kind="info"
      action={
        <>
          {needsStt && <Button variant="secondary" onClick={onOpenSetup}>{t.openSetup}</Button>}
          {needsLlm && <Button variant="secondary" onClick={onOpenSettings}>{t.openSettings}</Button>}
        </>
      }
    >
      {body}
    </Banner>
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
      {toggles.map((tg) => {
        const popId = `support-help-${tg.key}`;
        return (
          <div key={tg.key}>
            <div className="support-label-row">
              <div className="text-sm text-muted">{tg.label}</div>
              <button
                className="info-btn"
                aria-label={t.helpAriaSuffix(tg.label)}
                title={tg.help}
                aria-expanded={openHelp === tg.key}
                aria-controls={popId}
                onClick={() => toggleHelp(tg.key)}
              >ⓘ</button>
            </div>
            {openHelp === tg.key && <div id={popId} className="info-pop">{tg.help}</div>}
            <div className="lang-toggle" role="group" aria-label={tg.label}>
              <button className={s[tg.key] === null ? "is-active" : ""} aria-pressed={s[tg.key] === null} onClick={() => setToggle(tg.key, null)}>{t.optAuto}</button>
              <button className={s[tg.key] === true ? "is-active" : ""} aria-pressed={s[tg.key] === true} onClick={() => setToggle(tg.key, true)}>{t.optOn}</button>
              <button className={s[tg.key] === false ? "is-active" : ""} aria-pressed={s[tg.key] === false} onClick={() => setToggle(tg.key, false)}>{t.optOff}</button>
            </div>
          </div>
        );
      })}
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
    fetchPracticeDays().then((v) => setDays(v.days)).catch(() => {});
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
