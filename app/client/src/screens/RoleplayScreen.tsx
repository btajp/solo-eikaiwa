import { useEffect, useRef } from "react";
import { type ContentItem } from "../api";
import { STR, type Lang } from "../i18n";
import { localizedTitle } from "../localized-title";
import { Card } from "../ui/Card";
import { LevelChip } from "../ui/LevelChip";
import { FreeTalkScreen } from "./FreeTalkScreen";

export function RoleplayScreen(props: {
  scenario: ContentItem; sessionId: string; lang: Lang; onBeforeRecord?: () => boolean;
  onReady?: () => void; onValidAttempt?: () => void;
}) {
  const t = STR[props.lang].roleplay;
  const starters = props.scenario.starters ?? [];
  const readyNotifiedRef = useRef(false);
  const heading = localizedTitle(props.scenario, props.lang);
  useEffect(() => {
    if (readyNotifiedRef.current) return;
    readyNotifiedRef.current = true;
    props.onReady?.();
  }, [props.onReady]);
  return (
    <div className="stack">
      <Card>
        <p className="text-muted">{heading}</p>
        <LevelChip kind="auto" lang={props.lang} />
        <ul>
          {props.scenario.hints.map((h, i) => (<li key={i}>{h}</li>))}
        </ul>
        {starters.length > 0 && (
          <div className="stack">
            <p className="text-sm text-muted">{t.starters}</p>
            <ul>
              {starters.map((s, i) => (<li key={i}>{s}</li>))}
            </ul>
          </div>
        )}
      </Card>
      <FreeTalkScreen
        activitySessionId={props.sessionId} scenarioId={props.scenario.id} lang={props.lang}
        onBeforeRecord={props.onBeforeRecord} onValidTurn={props.onValidAttempt}
      />
    </div>
  );
}
