import { type ContentItem } from "../api";
import { Card } from "../ui/Card";
import { FreeTalkScreen } from "./FreeTalkScreen";

export function RoleplayScreen(props: { scenario: ContentItem }) {
  return (
    <div className="stack">
      <Card>
        <p className="text-muted">{props.scenario.titleJa}</p>
        <ul>
          {props.scenario.hints.map((h, i) => (
            <li key={i}>{h}</li>
          ))}
        </ul>
      </Card>
      <FreeTalkScreen scenarioId={props.scenario.id} />
    </div>
  );
}
