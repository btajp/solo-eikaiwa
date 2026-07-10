import { useEffect, useRef, useState } from "react";
import { fetchFixExplanation, fetchReflection } from "../api";
import { useExplain } from "../useExplain";
import { useLoad } from "../useLoad";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { CollectedPhrasesNotice } from "../ui/CollectedPhrasesNotice";
import { ExplainBox } from "../ui/ExplainBox";

/** 直したい表現1件。「もっと詳しく」で fetchFixExplanation を呼び、解説を自分の state に保持する */
function FixItem({ fix, lang }: { fix: { original: string; better: string }; lang: Lang }) {
  const t = STR[lang].reflection;
  const { state, request } = useExplain(() => fetchFixExplanation(fix.original, fix.better));
  return (
    <li>
      <s>{fix.original}</s> → <strong>{fix.better}</strong>
      <ExplainBox
        state={state} request={request}
        labels={{ more: t.explainMore, loading: t.explainLoading, error: t.explainError, retry: t.retry }}
      />
    </li>
  );
}

export function ReflectionScreen({
  sessionId, lang, onReady, onValidAttempt, onOpenCollectedPhrases,
}: {
  sessionId: string; lang: Lang; onReady?: () => void; onValidAttempt?: () => void;
  onOpenCollectedPhrases?: () => void;
}) {
  const t = STR[lang].reflection;
  const { state, reload } = useLoad(() => fetchReflection(sessionId));
  const readyNotifiedRef = useRef(false);
  const validAttemptNotifiedRef = useRef(false);
  const [reviewed, setReviewed] = useState(false);

  useEffect(() => {
    if (state.status !== "ready" || readyNotifiedRef.current) return;
    readyNotifiedRef.current = true;
    onReady?.();
  }, [state.status, onReady]);

  function confirmReview() {
    setReviewed(true);
    if (validAttemptNotifiedRef.current) return;
    validAttemptNotifiedRef.current = true;
    onValidAttempt?.();
  }

  if (state.status === "error") {
    return (
      <div>
        <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{formatClientError(lang, state.error, "load")}</Banner>
      </div>
    );
  }
  if (state.status === "loading") return <p className="text-muted">{t.loading}</p>;

  const reflection = state.data;
  return (
    <div className="stack">
      {reflection.goodPhrases.length > 0 && (
        <Card header={t.goodPhrases}>
          <ul>{reflection.goodPhrases.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </Card>
      )}
      {reflection.fixes.length > 0 && (
        <Card header={t.fixes}>
          <ul>
            {reflection.fixes.map((f, i) => (
              <FixItem key={i} fix={f} lang={lang} />
            ))}
          </ul>
        </Card>
      )}
      <Card header={t.tomorrow}>
        <p>{reflection.noteForTomorrow_ja}</p>
      </Card>
      <CollectedPhrasesNotice summary={reflection} lang={lang} onOpen={onOpenCollectedPhrases} />
      <Button variant="secondary" onClick={confirmReview} disabled={reviewed}>
        {reviewed ? t.reviewed : t.confirmReview}
      </Button>
    </div>
  );
}
