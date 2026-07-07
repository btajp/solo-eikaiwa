import { useState } from "react";
import { fetchFeedback, type FeedbackEntry } from "../api";
import { STR, type Lang } from "../i18n";
import { useLoad } from "../useLoad";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { feedbackToMarkdown } from "./feedbackMarkdown";

/** サイドバーの「フィードバック」画面。日付降順の一覧＋Markdownコピー(次サイクルへの貼り付け用)。 */
export function FeedbackScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].feedbackScreen;
  const { state, reload } = useLoad(fetchFeedback);
  const [copied, setCopied] = useState(false);

  async function copyAll(entries: FeedbackEntry[]) {
    const md = feedbackToMarkdown(entries, {
      heading: (n) => `# ${t.title}（${n}）`,
      rating: (r) => t.rating[r],
    });
    try {
      await navigator.clipboard.writeText(md);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.warn("clipboard write failed:", err);
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
        <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{state.error}</Banner>
      )}
      {state.status === "ready" && (
        state.data.length === 0 ? (
          <p className="text-muted">{t.empty}</p>
        ) : (
          <>
            <Button variant="secondary" onClick={() => copyAll(state.data)}>
              {copied ? t.copied : t.copy}
            </Button>
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
