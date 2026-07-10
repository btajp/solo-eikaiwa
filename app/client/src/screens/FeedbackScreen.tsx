import { useEffect, useRef, useState } from "react";
import { fetchFeedback, type FeedbackEntry } from "../api";
import {
  canStartClipboardCopy,
  transitionClipboardCopyStatus,
  type ClipboardCopyStatus,
} from "../clipboard-copy";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { useLoad } from "../useLoad";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { feedbackToMarkdown } from "./feedbackMarkdown";

/** サイドバーの「練習の感想」画面。日付降順の一覧とMarkdownコピーを提供する。 */
export function FeedbackScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].feedbackScreen;
  const { state, reload } = useLoad(fetchFeedback);
  const [copyStatus, setCopyStatus] = useState<ClipboardCopyStatus>("idle");
  const copyStatusRef = useRef<ClipboardCopyStatus>("idle");
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (resetTimerRef.current !== null) clearTimeout(resetTimerRef.current);
    };
  }, []);

  function clearResetTimer() {
    if (resetTimerRef.current === null) return;
    clearTimeout(resetTimerRef.current);
    resetTimerRef.current = null;
  }

  function moveCopyStatus(event: "start" | "succeeded" | "failed" | "reset") {
    const next = transitionClipboardCopyStatus(copyStatusRef.current, event);
    copyStatusRef.current = next;
    setCopyStatus(next);
  }

  async function copyAll(entries: FeedbackEntry[]) {
    if (!canStartClipboardCopy(copyStatusRef.current)) return;
    const md = feedbackToMarkdown(entries, {
      heading: (n) => `# ${t.title}（${n}）`,
      rating: (r) => t.rating[r],
    });
    clearResetTimer();
    moveCopyStatus("start");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(md);
      if (!aliveRef.current) return;
      moveCopyStatus("succeeded");
      resetTimerRef.current = setTimeout(() => {
        if (aliveRef.current) moveCopyStatus("reset");
      }, 2000);
    } catch (err) {
      console.warn("clipboard write failed:", err);
      if (aliveRef.current) moveCopyStatus("failed");
    }
  }

  return (
    <div className="stack">
      <div className="hero">
        <h2 className="hero-title">{t.title}</h2>
        <p className="hero-date">{t.desc}</p>
      </div>
      {state.status === "loading" && <p className="text-muted">{t.loading}</p>}
      {state.status === "error" && (
        <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{formatClientError(lang, state.error, "load")}</Banner>
      )}
      {state.status === "ready" && (
        state.data.length === 0 ? (
          <p className="text-muted">{t.empty}</p>
        ) : (
          <>
            <Button variant="secondary" onClick={() => copyAll(state.data)} loading={copyStatus === "copying"}>
              {copyStatus === "copying" ? t.copying : t.copy}
            </Button>
            {copyStatus === "copied" && <p className="text-sm text-muted" role="status">{t.copied}</p>}
            {copyStatus === "error" && <Banner kind="error">{t.copyFailed}</Banner>}
            {state.data.map((e) => {
              const blockLabel = (t.block as Record<string, string>)[e.blockKind] ?? e.blockKind;
              return (
                <Card
                  key={e.id}
                  header={<>{t.at(e.ymd)}{" "}<span className="text-sm text-muted">{blockLabel} · {t.rating[e.rating]}</span></>}
                >
                  <p className="text-sm text-muted">
                    {t.levelStage(e.level, e.stage)}{e.refId ? ` · ${e.refId}` : ""}
                  </p>
                  {e.note && <p className="sentence-explain text-sm">{e.note}</p>}
                </Card>
              );
            })}
          </>
        )
      )}
    </div>
  );
}
