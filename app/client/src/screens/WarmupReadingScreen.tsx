import { useEffect, useRef, useState } from "react";
import { fetchPrepPack, type ContentItem } from "../api";
import { STR, type Lang } from "../i18n";
import { useLoad } from "../useLoad";
import { usePlayRow } from "../usePlayRow";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ChunkList } from "../ui/ChunkList";
import { LevelChip } from "../ui/LevelChip";
import { canRevealJaFromHintDefault, canRevealJaFromPrep, useSupport } from "../support";
import { clozeText } from "../cloze";
import { isDisclosureOpen, splitBilingualHint, toggleDisclosure } from "../support-disclosure";

/**
 * セッション冒頭の低負荷な音読ウォームアップ。今日のトピックの表現チャンクと骨組みを
 * 声に出して読むだけ（録音・採点なし）。この後の4/3/2で同じ素材を使う下地作り。
 */
export function WarmupReadingScreen(props: {
  topic: ContentItem; sessionId: string; hintMode?: "ja" | "en"; lang: Lang;
  onReady?: () => void; onValidAttempt?: () => void;
}) {
  const t = STR[props.lang].warmup;
  const load = useLoad(() => fetchPrepPack(props.topic.id));
  const playRow = usePlayRow<number>();
  const [clozeStep, setClozeStep] = useState(false);
  const [jaRevealedFor, setJaRevealedFor] = useState<string | null>(null);
  const [readingConfirmed, setReadingConfirmed] = useState(false);
  const readyNotifiedRef = useRef(false);
  const validAttemptNotifiedRef = useRef(false);

  const support = useSupport();
  const disclosureKey = `${props.sessionId}:${props.topic.id}`;
  const prep = load.state.status === "ready" ? load.state.data : null;
  const chunks = prep?.chunks.filter((c) => typeof c.en === "string" && c.en) ?? [];
  const canRevealJa = prep ? canRevealJaFromPrep(support, prep) : false;
  const showJa = canRevealJa && isDisclosureOpen(jaRevealedFor, disclosureKey);
  const hasJapaneseHints = chunks.some((chunk) => Boolean(chunk.ja));
  const fallbackHints = props.topic.hints.map(splitBilingualHint);
  const canRevealFallbackJa = canRevealJaFromHintDefault(support, props.hintMode ?? "ja");
  const showFallbackJa = canRevealFallbackJa && isDisclosureOpen(jaRevealedFor, disclosureKey);
  const hasFallbackJapaneseHints = fallbackHints.some((hint) => Boolean(hint.ja));
  const hasFallbackPracticeMaterial = fallbackHints.some((hint) => Boolean(hint.en));
  const hasPreparedPracticeMaterial = chunks.length > 0 || Boolean(prep?.outline.length);

  useEffect(() => {
    const materialReady = (load.state.status === "ready" && hasPreparedPracticeMaterial)
      || (load.state.status === "error" && hasFallbackPracticeMaterial);
    if (readyNotifiedRef.current || !materialReady) return;
    readyNotifiedRef.current = true;
    props.onReady?.();
  }, [hasFallbackPracticeMaterial, hasPreparedPracticeMaterial, load.state.status, props.onReady]);

  function confirmReading() {
    setReadingConfirmed(true);
    if (validAttemptNotifiedRef.current) return;
    validAttemptNotifiedRef.current = true;
    props.onValidAttempt?.();
  }

  return (
    <div className="stack">
      <LevelChip kind="auto" lang={props.lang} />
      <p className="text-muted">
        {t.intro}
      </p>
      {load.state.status === "loading" && <p className="text-muted">{t.loading}</p>}
      {load.state.status === "error" && (
        <div>
          <Banner kind="error" action={<Button onClick={load.reload}>{t.retry}</Button>}>
            {load.state.error}
          </Banner>
          {props.topic.hints.length > 0 && (
            <div>
              <h4>{t.fallbackTitle}</h4>
              {canRevealFallbackJa && hasFallbackJapaneseHints && (
                <Button
                  variant="secondary"
                  onClick={() => setJaRevealedFor((current) => toggleDisclosure(current, disclosureKey))}
                >
                  {showFallbackJa ? t.hideJaHints : t.showJaHints}
                </Button>
              )}
              <ChunkList chunks={fallbackHints} playingIdx={null} showJa={showFallbackJa} />
              {hasFallbackPracticeMaterial && (
                <Button variant="secondary" onClick={confirmReading} disabled={readingConfirmed}>
                  {readingConfirmed ? t.readingConfirmed : t.confirmReading}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {load.state.status === "ready" && prep && (
        <div className="stack">
          {chunks.length > 0 && (
            <>
              {canRevealJa && hasJapaneseHints && (
                <Button
                  variant="secondary"
                  onClick={() => setJaRevealedFor((current) => toggleDisclosure(current, disclosureKey))}
                >
                  {showJa ? t.hideJaHints : t.showJaHints}
                </Button>
              )}
              <ChunkList
                chunks={chunks} playingIdx={playRow.playingKey} onPlay={(i, text) => playRow.play(i, text)} showJa={showJa}
                onStop={playRow.stop} stopLabel={STR[props.lang].playback.stop}
                playAria={(en) => STR[props.lang].chunkList.playAria(en)}
              />
            </>
          )}
          {playRow.error && <Banner kind="error">{playRow.error}</Banner>}
          {chunks.length > 0 && !clozeStep && (
            <Button variant="secondary" onClick={() => setClozeStep(true)}>{t.clozeStepButton}</Button>
          )}
          {clozeStep && (
            <Card header={t.clozeStepTitle}>
              <p className="text-muted">{t.clozeStepBody}</p>
              <ul className="chunk-list no-audio">
                {chunks.map((c, i) => (
                  <li key={i}><span className="chunk-en">{clozeText(c.en, i + 1)}</span></li>
                ))}
              </ul>
            </Card>
          )}
          {prep.outline.length > 0 && (
            <Card header={t.outlineTitle}>
              <ol>
                {prep.outline.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ol>
            </Card>
          )}
          {hasPreparedPracticeMaterial && (
            <Button variant="secondary" onClick={confirmReading} disabled={readingConfirmed}>
              {readingConfirmed ? t.readingConfirmed : t.confirmReading}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
