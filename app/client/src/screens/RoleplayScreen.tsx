import { type ContentItem } from "../api";
import { Card } from "../ui/Card";
import { FreeTalkScreen } from "./FreeTalkScreen";

export function RoleplayScreen(props: { scenario: ContentItem }) {
  const starters = props.scenario.starters ?? [];
  return (
    <div className="stack">
      <Card>
        <p className="text-muted">{props.scenario.titleJa}</p>
        <ul>
          {props.scenario.hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
        {starters.length > 0 && (
          <div className="stack">
            <p className="text-sm text-muted">こう切り出せます:</p>
            <ul>
              {starters.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </Card>
      <FreeTalkScreen scenarioId={props.scenario.id} />
    </div>
  );
}
