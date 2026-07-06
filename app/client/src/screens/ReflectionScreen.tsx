import { fetchReflection } from "../api";
import { useLoad } from "../useLoad";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

export function ReflectionScreen() {
  const { state, reload } = useLoad(fetchReflection);

  if (state.status === "error") {
    return (
      <div>
        <Banner kind="error" action={<Button onClick={reload}>再試行</Button>}>{state.error}</Banner>
      </div>
    );
  }
  if (state.status === "loading") return <p className="text-muted">コーチが今日のセッションを振り返っています…</p>;

  const reflection = state.data;
  return (
    <div className="stack">
      {reflection.goodPhrases.length > 0 && (
        <Card header={<h3>👏 良かった表現</h3>}>
          <ul>{reflection.goodPhrases.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </Card>
      )}
      {reflection.fixes.length > 0 && (
        <Card header={<h3>✏️ 直したい表現</h3>}>
          <ul>
            {reflection.fixes.map((f, i) => (
              <li key={i}><s>{f.original}</s> → <strong>{f.better}</strong></li>
            ))}
          </ul>
        </Card>
      )}
      <Card header={<h3>📝 明日へ</h3>}>
        <p>{reflection.noteForTomorrow_ja}</p>
      </Card>
    </div>
  );
}
