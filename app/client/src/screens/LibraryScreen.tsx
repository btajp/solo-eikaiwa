import { fetchModelTalkLibrary, fetchTalkExplanation, type ModelTalkEntry } from "../api";
import { STR, type Lang } from "../i18n";
import { useLoad } from "../useLoad";
import { usePlayRow } from "../usePlayRow";
import { useExplain } from "../useExplain";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

/** 生成済みモデルトークの一覧（情報表示のみ）。本文確認・再再生・訳解説ができる。 */
export function LibraryScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].library;
  const { state, reload } = useLoad(fetchModelTalkLibrary);
  const row = usePlayRow<number>();

  return (
    <div>
      <h3>{t.title}</h3>
      {state.status === "loading" && <p className="text-muted">{t.loading}</p>}
      {state.status === "error" && (
        <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{state.error}</Banner>
      )}
      {state.status === "ready" && state.data.length === 0 && (
        <p className="text-muted">{t.empty}</p>
      )}
      {state.status === "ready" &&
        state.data.map((e) => (
          <LibraryEntry key={e.id} entry={e} lang={lang} row={row} />
        ))}
      {state.status === "ready" && row.error && <Banner kind="error">{row.error}</Banner>}
    </div>
  );
}

/** 1エントリ: 再生（共有 row）＋本文折りたたみ＋訳解説（talk-explain 流用・エントリ単位の useExplain）。 */
function LibraryEntry({ entry, lang, row }: {
  entry: ModelTalkEntry; lang: Lang; row: ReturnType<typeof usePlayRow<number>>;
}) {
  const t = STR[lang].library;
  const explainer = useExplain(() => fetchTalkExplanation(entry.text));
  return (
    <Card
      header={
        <>
          <Button
            variant="ghost"
            onClick={() => row.play(entry.id, entry.text)}
            disabled={row.playingKey !== null}
            ariaLabel={t.playAria(entry.topicTitle || entry.topicId)}
          >
            {row.playingKey === entry.id ? t.playing : "▶"}
          </Button>{" "}
          {entry.topicTitle || entry.topicId}{" "}
          <span className="text-sm text-muted">{entry.createdAt.slice(0, 10)}</span>
        </>
      }
    >
      <details>
        <summary className="text-muted">{t.transcript}</summary>
        <p className="reading-text">{entry.text}</p>
      </details>
      {explainer.state.status === "idle" && (
        <Button variant="ghost" onClick={explainer.request}>{t.explainMore}</Button>
      )}
      {explainer.state.status === "loading" && <p className="text-sm text-muted">{t.explainLoading}</p>}
      {explainer.state.status === "error" && (
        <p className="text-sm text-muted">{t.explainError}<Button variant="ghost" onClick={explainer.request}>{t.retry}</Button></p>
      )}
      {explainer.state.status === "done" && <p className="sentence-explain text-sm">{explainer.state.text}</p>}
    </Card>
  );
}
