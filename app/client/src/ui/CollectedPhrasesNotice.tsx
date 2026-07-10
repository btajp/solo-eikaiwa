import type { CollectedChunks } from "../api/coach";
import { STR, type Lang } from "../i18n";
import { collectedPhrasesNoticeKind } from "../lib/collected-phrases";
import { Banner } from "./Banner";
import { Button } from "./Button";
import { Card } from "./Card";

/** 添削・振り返りで自動収集した表現の結果を、保存済み・追加なし・失敗で区別して示す。 */
export function CollectedPhrasesNotice({
  summary, lang, onOpen,
}: {
  summary: CollectedChunks;
  lang: Lang;
  onOpen?: () => void;
}) {
  const t = STR[lang].collectedPhrases;
  const kind = collectedPhrasesNoticeKind(summary);
  if (kind === "failed") return <Banner kind="error">{t.failed}</Banner>;
  if (kind === "none") return <Banner kind="info">{t.none}</Banner>;

  return (
    <Card header={t.savedTitle(summary.collectedChunkItems.length)}>
      <p className="text-muted">{t.savedBody}</p>
      <ul>
        {summary.collectedChunkItems.map((phrase) => <li key={phrase.id}>{phrase.en}</li>)}
      </ul>
      {onOpen && <Button variant="secondary" onClick={onOpen}>{t.open}</Button>}
    </Card>
  );
}
