import { fetchModelTalkLibrary, fetchTalkExplanation, type ModelTalkEntry } from "../api";
import { STR, type Lang } from "../i18n";
import { localizedTitle } from "../localized-title";
import { formatClientError } from "../lib/user-error";
import { formatYmdShort, localYmdFromTimestamp } from "../dates";
import { useLoad } from "../useLoad";
import { usePlayRow } from "../usePlayRow";
import { useExplain } from "../useExplain";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ExplainBox } from "../ui/ExplainBox";
import { PlaybackButton } from "../ui/PlaybackButton";

/** 生成済みモデルトークの一覧（情報表示のみ）。スクリプト確認・再再生・訳解説ができる。 */
export function LibraryScreen({ lang }: { lang: Lang }) {
  const t = STR[lang].library;
  const { state, reload } = useLoad(fetchModelTalkLibrary);
  const row = usePlayRow<number>();

  return (
    <div className="stack">
      <div className="hero"><h2 className="hero-title">{t.title}</h2></div>
      {state.status === "loading" && <p className="text-muted">{t.loading}</p>}
      {state.status === "error" && (
        <Banner kind="error" action={<Button onClick={reload}>{t.retry}</Button>}>{formatClientError(lang, state.error, "load")}</Banner>
      )}
      {state.status === "ready" && state.data.length === 0 && (
        <p className="text-muted">{t.empty}</p>
      )}
      {state.status === "ready" &&
        state.data.map((e) => (
          <LibraryEntry key={e.id} entry={e} lang={lang} row={row} />
        ))}
      {state.status === "ready" && row.error && <Banner kind="error">{formatClientError(lang, row.error, "play")}</Banner>}
    </div>
  );
}

/** 1エントリ: 再生（共有 row）＋スクリプト折りたたみ＋訳解説（talk-explain 流用・エントリ単位の useExplain）。 */
function LibraryEntry({ entry, lang, row }: {
  entry: ModelTalkEntry; lang: Lang; row: ReturnType<typeof usePlayRow<number>>;
}) {
  const t = STR[lang].library;
  const playback = STR[lang].playback;
  const explainer = useExplain(() => fetchTalkExplanation(entry.text));
  const title = localizedTitle({ title: entry.topicTitle, titleJa: entry.topicTitleJa }, lang) || entry.topicId;
  return (
    <Card
      header={
        <>
          <PlaybackButton
            playing={row.playingKey === entry.id}
            onPlay={() => row.play(entry.id, entry.text)}
            onStop={row.stop}
            disabled={row.playingKey !== null}
            playLabel="▶"
            stopLabel={playback.stop}
            playAriaLabel={t.playAria(title)}
          />{" "}
          {title}{" "}
          <span className="text-sm text-muted">{formatYmdShort(localYmdFromTimestamp(entry.createdAt), lang)}</span>
        </>
      }
    >
      <details>
        <summary className="text-muted">{t.transcript}</summary>
        <p className="reading-text">{entry.text}</p>
      </details>
      <ExplainBox
        state={explainer.state} request={explainer.request}
        labels={{ more: t.explainMore, loading: t.explainLoading, error: t.explainError, retry: t.retry }}
      />
    </Card>
  );
}
