import { useEffect, useRef, useState } from "react";
import { fetchFixExplanation, fetchReflection } from "../api";
import { useLoad } from "../useLoad";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

/** 直したい表現1件。「もっと詳しく」で fetchFixExplanation を呼び、解説を自分の state に保持する */
function FixItem({ fix }: { fix: { original: string; better: string } }) {
  const aliveRef = useRef(true);
  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; }; }, []);
  // undefined=未取得, "loading"=生成中, "error"=取得失敗, それ以外=解説テキスト
  const [explain, setExplain] = useState<string | undefined>(undefined);

  async function explainFix() {
    setExplain("loading");
    try {
      const text = await fetchFixExplanation(fix.original, fix.better);
      if (aliveRef.current) setExplain(text);
    } catch {
      if (aliveRef.current) setExplain("error");
    }
  }

  return (
    <li>
      <s>{fix.original}</s> → <strong>{fix.better}</strong>
      {explain === undefined && (
        <Button variant="ghost" onClick={explainFix}>💡 もっと詳しく</Button>
      )}
      {explain === "loading" && <p className="text-sm text-muted">解説を書いています…</p>}
      {explain === "error" && (
        <p className="text-sm text-muted">
          解説を取得できませんでした。
          <Button variant="ghost" onClick={explainFix}>再試行</Button>
        </p>
      )}
      {explain !== undefined && explain !== "loading" && explain !== "error" && (
        <p className="sentence-explain text-sm">{explain}</p>
      )}
    </li>
  );
}

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
              <FixItem key={i} fix={f} />
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
