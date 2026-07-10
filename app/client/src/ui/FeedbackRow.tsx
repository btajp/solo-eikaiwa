import { useEffect, useRef, useState } from "react";
import { fetchProgressSummary, postFeedback, type FeedbackContext, type FeedbackRating } from "../api";
import { STR, type Lang } from "../i18n";
import { Button } from "./Button";

/**
 * 練習完了時の控えめな1タップ評価行。メモ（任意）を先に入力してから3択（難しすぎた/ちょうどよかった/簡単すぎた）を
 * 押すと、その1タップでメモごと送信される。スキップ完全自由・ノルマなし・未入力なら何も起きない
 * （研究制約: 情報的のみ・警告/叱責なし）。level/stage は表示せず、送信時の文脈として進捗サマリから
 * best-effort で付与する（取得失敗時は null）。保存失敗時だけ中立的な再試行ヒントを出す（評価内容への叱責ではない）。
 */
export function FeedbackRow({ context, lang }: { context: FeedbackContext; lang: Lang }) {
  const t = STR[lang].feedbackRow;
  const [phase, setPhase] = useState<"prompt" | "sent">("prompt");
  const [note, setNote] = useState("");
  const [retryHint, setRetryHint] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingRating, setPendingRating] = useState<FeedbackRating | null>(null);
  const enrichRef = useRef<{ level: number | null; stage: number | null }>({ level: null, stage: null });
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    fetchProgressSummary()
      .then((s) => { if (aliveRef.current) enrichRef.current = { level: s.level, stage: s.stage }; })
      .catch(() => {});
    return () => { aliveRef.current = false; };
  }, []);

  async function submit(rating: FeedbackRating) {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setPendingRating(rating);
    setRetryHint(false);
    try {
      await postFeedback({
        blockKind: context.blockKind,
        refId: context.refId ?? null,
        level: enrichRef.current.level,
        stage: enrichRef.current.stage,
        rating,
        note: note.trim(),
      });
      if (aliveRef.current) setPhase("sent");
    } catch (err) {
      console.warn("feedback post failed:", err);
      if (aliveRef.current) {
        setRetryHint(true);
        setIsSubmitting(false);
        setPendingRating(null);
      }
    }
  }

  if (phase === "sent") {
    return <p className="feedback-row-thanks text-sm text-muted">{t.thanks}</p>;
  }

  return (
    <div className="feedback-row stack">
      <div>
        <p className="text-sm">{t.target[context.blockKind as keyof typeof t.target] ?? t.target.default}</p>
        <p className="text-sm text-muted">{t.purpose}</p>
      </div>
      <span className="text-sm text-muted">{t.prompt}</span>
      <input
        className="feedback-note"
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t.notePlaceholder}
        maxLength={300}
        aria-label={t.notePlaceholder}
      />
      <div className="feedback-actions" role="group" aria-label={t.prompt}>
        <Button onClick={() => submit("hard")} loading={pendingRating === "hard"} disabled={isSubmitting}>{t.hard}</Button>
        <Button onClick={() => submit("just-right")} loading={pendingRating === "just-right"} disabled={isSubmitting}>{t.justRight}</Button>
        <Button onClick={() => submit("easy")} loading={pendingRating === "easy"} disabled={isSubmitting}>{t.easy}</Button>
      </div>
      {retryHint && <span className="text-sm text-muted">{t.retryHint}</span>}
    </div>
  );
}
