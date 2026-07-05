import { useEffect, useState } from "react";
import { fetchReflection, type Reflection } from "../api";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

export function ReflectionScreen() {
  const [reflection, setReflection] = useState<Reflection | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  function loadReflection() {
    setErrorMsg("");
    fetchReflection()
      .then(setReflection)
      .catch((err) => setErrorMsg(err instanceof Error ? err.message : String(err)));
  }

  useEffect(() => {
    loadReflection();
  }, []);

  if (errorMsg) {
    return (
      <div>
        <Banner kind="error" action={<Button onClick={loadReflection}>再試行</Button>}>{errorMsg}</Banner>
      </div>
    );
  }
  if (!reflection) return <p className="text-muted">コーチが今日のセッションを振り返っています…</p>;

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
