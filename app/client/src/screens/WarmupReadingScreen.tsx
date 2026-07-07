import { useState } from "react";
import { fetchPrepPack, type ContentItem } from "../api";
import { STR, type Lang } from "../i18n";
import { useLoad } from "../useLoad";
import { usePlayRow } from "../usePlayRow";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ChunkList } from "../ui/ChunkList";
import { LevelChip } from "../ui/LevelChip";
import { showJaFromPrep, useSupport } from "../support";
import { clozeText } from "../cloze";

/**
 * セッション冒頭の低負荷な音読ウォームアップ。今日のトピックの表現チャンクと骨組みを
 * 声に出して読むだけ（録音・採点なし）。この後の4/3/2で同じ素材を使う下地作り。
 */
export function WarmupReadingScreen(props: { topic: ContentItem; lang: Lang }) {
  const t = STR[props.lang].warmup;
  const load = useLoad(() => fetchPrepPack(props.topic.id));
  const playRow = usePlayRow<number>();
  const [clozeStep, setClozeStep] = useState(false);

  const support = useSupport();
  const prep = load.state.status === "ready" ? load.state.data : null;
  const chunks = prep?.chunks.filter((c) => typeof c.en === "string" && c.en) ?? [];
  // ja を表示するか: 個別トグル → サーバの stage 既定（hintDefault）で解決
  const showJa = prep ? showJaFromPrep(support, prep) : true;

  return (
    <div className="stack">
      <LevelChip kind="auto" lang={props.lang} />
      <p className="text-muted">
        {t.intro}
      </p>
      {load.state.status === "loading" && <p>{t.loading}</p>}
      {load.state.status === "error" && (
        <div>
          <Banner kind="error" action={<Button onClick={load.reload}>{t.retry}</Button>}>
            {load.state.error}
          </Banner>
          {props.topic.hints.length > 0 && (
            <div>
              <h4>{t.fallbackTitle}</h4>
              <ChunkList chunks={props.topic.hints.map((h) => ({ en: h }))} playingIdx={null} />
            </div>
          )}
        </div>
      )}
      {load.state.status === "ready" && prep && (
        <div className="stack">
          {chunks.length > 0 && (
            <ChunkList
              chunks={chunks} playingIdx={playRow.playingKey} onPlay={(i, text) => playRow.play(i, text)} showJa={showJa}
              playAria={(en) => STR[props.lang].chunkList.playAria(en)}
            />
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
        </div>
      )}
    </div>
  );
}
