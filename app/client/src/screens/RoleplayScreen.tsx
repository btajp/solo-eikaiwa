import { type ContentItem } from "../api";
import { STR, type Lang } from "../i18n";
import { Card } from "../ui/Card";
import { LevelChip } from "../ui/LevelChip";
import { FreeTalkScreen } from "./FreeTalkScreen";

export function RoleplayScreen(props: { scenario: ContentItem; sessionId: string; lang: Lang }) {
  const t = STR[props.lang].roleplay;
  const starters = props.scenario.starters ?? [];
  // EN 表示ではシナリオの英語タイトル、JA では従来どおり titleJa
  const heading = props.lang === "ja" ? props.scenario.titleJa : props.scenario.title;
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
      <FreeTalkScreen activitySessionId={props.sessionId} scenarioId={props.scenario.id} lang={props.lang} />
    </div>
  );
}
