import { useMemo, useState } from "react";
import {
  fetchChunks, fetchFixExplanation, fetchSentences, setChunkVisibility,
  type ChunkListItem, type SentenceItem, type SentenceSrs,
} from "../api";
import { formatYmdShort } from "../dates";
import { STR, type Lang } from "../i18n";
import { filterBrowseChunks, filterBrowseSentences, paginateBrowseItems, type BrowseFilters } from "../lib/browse-filter";
import { formatClientError } from "../lib/user-error";
import { useExplain } from "../useExplain";
import { useLoad } from "../useLoad";
import { usePlayRow } from "../usePlayRow";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ExplainBox } from "../ui/ExplainBox";
import { PlaybackButton } from "../ui/PlaybackButton";

/** 行キー: 例文は no、チャンクは id。種別を混ぜないよう kind でタグ付けする */
type RowKey = { kind: "sentence"; no: number } | { kind: "chunk"; id: number };

const INITIAL_FILTERS: BrowseFilters = { query: "", domain: "all", category: "all", study: "all" };

/** 一覧タブ: 検索・カテゴリ・学習状態を組み合わせ、例文は1ページずつ描画する。 */
export function BrowseTab({ lang }: { lang: Lang }) {
  const t = STR[lang].sentences;
  const playback = STR[lang].playback;
  const load = useLoad(async () => {
    const all = await fetchSentences();
    // チャンクは補助セクション — 一方の取得失敗でも例文一覧と取得できた側は表示する
    const [visible, hidden] = await Promise.allSettled([fetchChunks(), fetchChunks("hidden")]);
    return {
      items: all,
      chunks: visible.status === "fulfilled" ? visible.value : [],
      hiddenChunks: hidden.status === "fulfilled" ? hidden.value : [],
      chunkLoadFailed: visible.status === "rejected" || hidden.status === "rejected",
    };
  });
  const [filters, setFilters] = useState<BrowseFilters>(INITIAL_FILTERS);
  const [page, setPage] = useState(1);
  const [showHidden, setShowHidden] = useState(false);
  const [changingId, setChangingId] = useState<number | null>(null);
  const [visibilityError, setVisibilityError] = useState("");
  const [visibilityOverrides, setVisibilityOverrides] = useState<Record<number, boolean>>({});
  const row = usePlayRow<RowKey>();
  const anyPlaying = row.playingKey !== null;

  const items = load.state.status === "ready" ? load.state.data.items : [];
  const loadedVisible = load.state.status === "ready" ? load.state.data.chunks : [];
  const loadedHidden = load.state.status === "ready" ? load.state.data.hiddenChunks : [];
  const allChunks = useMemo(
    () => [...new Map([...loadedVisible, ...loadedHidden].map((chunk) => [chunk.id, chunk])).values()],
    [loadedVisible, loadedHidden],
  );
  const originallyHidden = new Set(loadedHidden.map((chunk) => chunk.id));
  const isHidden = (id: number) => visibilityOverrides[id] ?? originallyHidden.has(id);
  const visibleChunks = allChunks.filter((chunk) => !isHidden(chunk.id));
  const hiddenChunks = allChunks.filter((chunk) => isHidden(chunk.id));
  const matchedVisibleChunks = filterBrowseChunks(visibleChunks, filters);
  const matchedHiddenChunks = filterBrowseChunks(hiddenChunks, filters);
  const filteredSentences = filterBrowseSentences(items, filters);
  const pagedSentences = paginateBrowseItems(filteredSentences, page);
  const categories = groupSentencesByCategory(pagedSentences.items);
  const categoryOptions = [...new Map(items.map((item) => [item.category_no, item.category])).entries()]
    .sort(([a], [b]) => a - b);
  const hasFilters = Boolean(filters.query.trim()) || filters.domain !== "all" || filters.category !== "all" || filters.study !== "all";
  const noResults = hasFilters
    && filteredSentences.length === 0
    && matchedVisibleChunks.length === 0
    && (!showHidden || matchedHiddenChunks.length === 0);

  function updateFilters(next: Partial<BrowseFilters>) {
    setFilters((current) => ({ ...current, ...next }));
    setPage(1);
  }

  async function onSetChunkHidden(id: number, hidden: boolean) {
    setChangingId(id);
    setVisibilityError("");
    try {
      await setChunkVisibility(id, hidden);
      setVisibilityOverrides((prev) => ({ ...prev, [id]: hidden }));
    } catch (err) {
      setVisibilityError(formatClientError(lang, err, "save"));
    } finally {
      setChangingId(null);
    }
  }

  if (load.state.status === "loading") return <p className="text-muted">{t.loading}</p>;
  if (load.state.status === "error") {
    return <Banner kind="error" action={<Button onClick={load.reload}>{t.retry}</Button>}>{formatClientError(lang, load.state.error, "load")}</Banner>;
  }

  return (
    <div className="stack">
      <div className="filter-row">
        {(["all", "daily", "business", "it"] as const).map((domain) => (
          <button
            key={domain}
            className={`filter-chip${filters.domain === domain ? " is-active" : ""}`}
            aria-pressed={filters.domain === domain}
            onClick={() => updateFilters({ domain })}
          >
            {domain === "all" ? t.filterAll : t.domain[domain]}
          </button>
        ))}
      </div>
      <div className="browse-controls">
        <label className="browse-control">
          <span className="text-sm text-muted">{t.searchLabel}</span>
          <input
            type="search"
            value={filters.query}
            placeholder={t.searchPlaceholder}
            onChange={(event) => updateFilters({ query: event.target.value })}
          />
        </label>
        <label className="browse-control">
          <span className="text-sm text-muted">{t.categoryLabel}</span>
          <select
            value={filters.category}
            onChange={(event) => updateFilters({ category: event.target.value === "all" ? "all" : Number(event.target.value) })}
          >
            <option value="all">{t.categoryAll}</option>
            {categoryOptions.map(([number, name]) => <option key={number} value={number}>{`${number}. ${name}`}</option>)}
          </select>
        </label>
        <label className="browse-control">
          <span className="text-sm text-muted">{t.studyLabel}</span>
          <select
            value={filters.study}
            onChange={(event) => updateFilters({ study: event.target.value as BrowseFilters["study"] })}
          >
            <option value="all">{t.studyAll}</option>
            <option value="new">{t.studyNew}</option>
            <option value="scheduled">{t.studyScheduled}</option>
          </select>
        </label>
      </div>
      {(row.error || visibilityError) && <Banner kind="error">{visibilityError || formatClientError(lang, row.error, "play")}</Banner>}
      {load.state.data.chunkLoadFailed && (
        <Banner kind="error" action={<Button onClick={load.reload}>{t.retry}</Button>}>{t.chunkLoadError}</Banner>
      )}
      {allChunks.length === 0 && !load.state.data.chunkLoadFailed && (
        <Card header={t.myChunks}><p className="text-muted">{t.noChunks}</p></Card>
      )}
      {matchedVisibleChunks.length > 0 && (
        <Card header={t.myChunks}>
          <PhraseRows
            chunks={matchedVisibleChunks} lang={lang} playingKey={row.playingKey} anyPlaying={anyPlaying}
            onPlay={(chunk) => row.play({ kind: "chunk", id: chunk.id }, chunk.en)} onStop={row.stop}
            changingId={changingId} onSetHidden={onSetChunkHidden}
          />
        </Card>
      )}
      {hiddenChunks.length > 0 && (
        <div>
          <Button variant="ghost" onClick={() => setShowHidden((current) => !current)}>
            {showHidden ? t.hideHiddenChunks : t.showHiddenChunks(hiddenChunks.length)}
          </Button>
        </div>
      )}
      {showHidden && matchedHiddenChunks.length > 0 && (
        <Card header={t.hiddenChunks}>
          <PhraseRows
            chunks={matchedHiddenChunks} lang={lang} playingKey={row.playingKey} anyPlaying={anyPlaying}
            onPlay={(chunk) => row.play({ kind: "chunk", id: chunk.id }, chunk.en)} onStop={row.stop}
            changingId={changingId} onSetHidden={onSetChunkHidden} hidden
          />
        </Card>
      )}
      {noResults && <p className="text-muted">{t.noResults}</p>}
      {filteredSentences.length > 0 && (
        <nav className="browse-pagination" aria-label={t.tabBrowse}>
          <Button variant="secondary" onClick={() => setPage(pagedSentences.page - 1)} disabled={pagedSentences.page === 1}>
            {t.previousPage}
          </Button>
          <span className="text-sm text-muted">{t.pageOf(pagedSentences.page, pagedSentences.pageCount, filteredSentences.length)}</span>
          <Button variant="secondary" onClick={() => setPage(pagedSentences.page + 1)} disabled={pagedSentences.page === pagedSentences.pageCount}>
            {t.nextPage}
          </Button>
        </nav>
      )}
      {categories.map(([number, category]) => (
        <Card key={number} header={`${number}. ${category.name}`}>
          {category.items.map((sentence) => (
            <div key={sentence.no} className="sentence-row">
              <PlaybackButton
                playing={row.playingKey?.kind === "sentence" && row.playingKey.no === sentence.no}
                onPlay={() => row.play({ kind: "sentence", no: sentence.no }, sentence.en)}
                onStop={row.stop}
                disabled={anyPlaying}
                playLabel="▶"
                stopLabel={playback.stop}
                playAriaLabel={t.playAria(sentence.no)}
              />
              <div className="sentence-body">
                <span className="sentence-en">{sentence.en}</span>
                <span className="sentence-ja-sub">{sentence.ja}</span>
                <span className="text-sm text-muted">{sentence.note}</span>
              </div>
              <SrsStatus srs={sentence.srs} lang={lang} />
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

function groupSentencesByCategory(items: SentenceItem[]): Array<[number, { name: string; items: SentenceItem[] }]> {
  const categories = new Map<number, { name: string; items: SentenceItem[] }>();
  for (const item of items) {
    const category = categories.get(item.category_no) ?? { name: item.category, items: [] };
    category.items.push(item);
    categories.set(item.category_no, category);
  }
  return [...categories.entries()].sort(([a], [b]) => a - b);
}

function PhraseRows({
  chunks, lang, playingKey, anyPlaying, onPlay, onStop, changingId, onSetHidden, hidden = false,
}: {
  chunks: ChunkListItem[];
  lang: Lang;
  playingKey: RowKey | null;
  anyPlaying: boolean;
  onPlay: (chunk: ChunkListItem) => void;
  onStop: () => void;
  changingId: number | null;
  onSetHidden: (id: number, hidden: boolean) => void;
  hidden?: boolean;
}) {
  const t = STR[lang].sentences;
  const playback = STR[lang].playback;
  return chunks.map((chunk) => (
    <div key={chunk.id} className="sentence-row">
      <PlaybackButton
        playing={playingKey?.kind === "chunk" && playingKey.id === chunk.id}
        onPlay={() => onPlay(chunk)} onStop={onStop} disabled={anyPlaying}
        playLabel="▶" stopLabel={playback.stop} playAriaLabel={t.playChunkAria(chunk.id)}
      />
      <div className="sentence-body">
        <span className="sentence-en">{chunk.en}</span>
        <span className="sentence-ja-sub">{chunk.promptText}</span>
        {chunk.note && <span className="text-sm text-muted">{chunk.note}</span>}
        <ChunkExplain chunk={chunk} lang={lang} />
      </div>
      <div className="sentence-row-actions">
        <SrsStatus srs={chunk.srs} lang={lang} />
        <Button
          variant="ghost" loading={changingId === chunk.id} disabled={changingId !== null}
          onClick={() => onSetHidden(chunk.id, !hidden)} ariaLabel={hidden ? t.restoreChunkAria(chunk.id) : t.hideChunkAria(chunk.id)}
        >
          {hidden ? t.restoreChunk : t.hideChunk}
        </Button>
      </div>
    </div>
  ));
}

function SrsStatus({ srs, lang }: { srs: SentenceSrs | null; lang: Lang }) {
  const t = STR[lang].sentences;
  return <span className="sentence-srs text-sm text-muted">{
    srs ? t.srsScheduled(srs.stage, formatYmdShort(srs.due, lang)) : t.srsNew
  }</span>;
}

/** マイフレーズ1件の「もっと詳しく」。チャンクは (元の言い方→自然な言い方, 理由) なので fix-explain を流用する。 */
function ChunkExplain({ chunk, lang }: { chunk: ChunkListItem; lang: Lang }) {
  const t = STR[lang].sentences;
  const { state, request } = useExplain(() => fetchFixExplanation(chunk.promptText, chunk.en, chunk.note));
  return (
    <ExplainBox
      state={state} request={request}
      labels={{ more: t.explainMore, loading: t.explainLoading, error: t.explainError, retry: t.retry }}
    />
  );
}
