import { useEffect, useRef, useState } from "react";
import { fetchReflection, type Reflection } from "../api";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { CollectedPhrasesNotice } from "../ui/CollectedPhrasesNotice";
import { FixItem } from "./ReflectionScreen";
import { limitDelayedReflectionFixes } from "./delayed-reflection";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; error: unknown }
  | { status: "ready"; data: Reflection };

/**
 * クイック・ロールプレイと自由会話の任意の遅延訂正ループ (#179)。
 * 通しセッションの振り返りブロックと違い、明示のボタン操作があるまで何も取得・表示しない。
 * 取得は既存の /api/coach/reflection（訂正は最大3件・collected_chunks への収集込み）を使う。
 * 未実施でも警告・減点・未完了扱いにしない（この部品は導線と結果表示のみで、完了状態に関与しない）。
 */
export function DelayedReflection({ sessionId, lang, onOpenCollectedPhrases }: {
  sessionId: string; lang: Lang; onOpenCollectedPhrases?: () => void;
}) {
  const t = STR[lang].reflection;
  const [state, setState] = useState<State>({ status: "idle" });
  const aliveRef = useRef(true);
  // setState は非同期反映のため、同一レンダー内の連打で LLM 要求が重複しないよう同期ガードを持つ
  const inFlightRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);

  async function request() {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setState({ status: "loading" });
    try {
      const data = await fetchReflection(sessionId);
      if (!aliveRef.current) return;
      setState({ status: "ready", data });
    } catch (error) {
      if (!aliveRef.current) return;
      setState({ status: "error", error });
    } finally {
      inFlightRef.current = false;
    }
  }

  if (state.status === "idle") {
    return (
      <div className="stack">
        <p className="text-sm text-muted">{t.offerNote}</p>
        <Button variant="secondary" onClick={() => void request()}>{t.offerButton}</Button>
      </div>
    );
  }
  if (state.status === "loading") return <p className="text-muted">{t.loading}</p>;
  if (state.status === "error") {
    return (
      <Banner kind="error" action={<Button onClick={() => void request()}>{t.retry}</Button>}>
        {formatClientError(lang, state.error, "load")}
      </Banner>
    );
  }

  const reflection = state.data;
  const fixes = limitDelayedReflectionFixes(reflection.fixes);
  return (
    <div className="stack">
      {reflection.goodPhrases.length > 0 && (
        <Card header={t.goodPhrases}>
          <ul>{reflection.goodPhrases.map((p, i) => <li key={i}>{p}</li>)}</ul>
        </Card>
      )}
      {fixes.length > 0 && (
        <Card header={t.fixes}>
          <ul>
            {fixes.map((f, i) => (
              <FixItem key={i} fix={f} lang={lang} />
            ))}
          </ul>
        </Card>
      )}
      {reflection.noteForTomorrow_ja && (
        <Card header={t.tomorrow}>
          <p>{reflection.noteForTomorrow_ja}</p>
        </Card>
      )}
      <CollectedPhrasesNotice summary={reflection} lang={lang} onOpen={onOpenCollectedPhrases} />
    </div>
  );
}
