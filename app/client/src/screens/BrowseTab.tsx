import { useState } from "react";
import {
  fetchChunks, fetchFixExplanation, fetchSentences, setChunkVisibility, type ChunkListItem, type SentenceItem,
} from "../api";
import { STR, type Lang } from "../i18n";
import { useLoad } from "../useLoad";
import { usePlayRow } from "../usePlayRow";
import { useExplain } from "../useExplain";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ExplainBox } from "../ui/ExplainBox";

/** 行キー: 例文は no、チャンクは id。種別を混ぜないよう kind でタグ付けする */
type RowKey = { kind: "sentence"; no: number } | { kind: "chunk"; id: number };

/** 一覧タブ: domainフィルタ + カテゴリ見出しでのブラウズ。SRS状態は情報表示のみ */
export function BrowseTab({ lang }: { lang: Lang }) {
  const t = STR[lang].sentences;
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
  const [filter, setFilter] = useState<"all" | SentenceItem["domain"]>("all");
  const [showHidden, setShowHidden] = useState(false);
  const [changingId, setChangingId] = useState<number | null>(null);
  const [visibilityError, setVisibilityError] = useState("");
  const [visibilityOverrides, setVisibilityOverrides] = useState<Record<number, boolean>>({});
  const row = usePlayRow<RowKey>();
  const anyPlaying = row.playingKey !== null;

  const items = load.state.status === "ready" ? load.state.data.items : [];
  const loadedVisible = load.state.status === "ready" ? load.state.data.chunks : [];
  const loadedHidden = load.state.status === "ready" ? load.state.data.hiddenChunks : [];
  const originallyHidden = new Set(loadedHidden.map((chunk) => chunk.id));
  const allChunks = [...new Map([...loadedVisible, ...loadedHidden].map((chunk) => [chunk.id, chunk])).values()];
  const isHidden = (id: number) => visibilityOverrides[id] ?? originallyHidden.has(id);
  const chunks = allChunks.filter((chunk) => !isHidden(chunk.id));
  const hiddenChunks = allChunks.filter((chunk) => isHidden(chunk.id));

  async function onSetChunkHidden(id: number, hidden: boolean) {
    setChangingId(id);
    setVisibilityError("");
    try {
      await setChunkVisibility(id, hidden);
      setVisibilityOverrides((prev) => ({ ...prev, [id]: hidden }));
    } catch (err) {
      setVisibilityError(err instanceof Error ? err.message : String(err));
    } finally {
      setChangingId(null);
    }
  }

  if (load.state.status === "loading") return <p className="text-muted">{t.loading}</p>;
  if (load.state.status === "error") {
    return <Banner kind="error" action={<Button onClick={load.reload}>{t.retry}</Button>}>{load.state.error}</Banner>;
  }
  const shown = filter === "all" ? items : items.filter((s) => s.domain === filter);
  const categories = [...new Map(shown.map((s) => [s.category_no, s.category])).entries()]
    .sort((a, b) => a[0] - b[0]);
  return (
    <div className="stack">
      <div className="filter-row">
        {(["all", "daily", "business", "it"] as const).map((f) => (
          <button
            key={f}
            className={`filter-chip${filter === f ? " is-active" : ""}`}
            onClick={() => setFilter(f)}
          >
            {f === "all" ? t.filterAll : t.domain[f]}
          </button>
        ))}
      </div>
      {(row.error || visibilityError) && <Banner kind="error">{row.error || visibilityError}</Banner>}
      {load.state.data.chunkLoadFailed && (
        <Banner kind="error" action={<Button onClick={load.reload}>{t.retry}</Button>}>{t.chunkLoadError}</Banner>
      )}
      {chunks.length > 0 && (
        <Card header={t.myChunks}>
          {chunks.map((c) => (
            <div key={c.id} className="sentence-row">
              <Button
                variant="ghost"
                onClick={() => row.play({ kind: "chunk", id: c.id }, c.en)}
                disabled={anyPlaying}
                ariaLabel={t.playChunkAria(c.id)}
              >
                {row.playingKey?.kind === "chunk" && row.playingKey.id === c.id ? "🔊" : "▶"}
              </Button>
              <div className="sentence-body">
                <span className="sentence-en">{c.en}</span>
                <span className="sentence-ja-sub">{c.promptText}</span>
                {c.note && <span className="text-sm text-muted">{c.note}</span>}
                <ChunkExplain chunk={c} lang={lang} />
              </div>
              <div className="sentence-row-actions">
                <span className="sentence-srs text-sm text-muted">{`st${c.srs.stage} ・ ${c.srs.due.slice(5)}`}</span>
                <Button
                  variant="ghost" loading={changingId === c.id} disabled={changingId !== null}
                  onClick={() => onSetChunkHidden(c.id, true)} ariaLabel={t.hideChunkAria(c.id)}
                >
                  {t.hideChunk}
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {hiddenChunks.length > 0 && (
        <div>
          <Button variant="ghost" onClick={() => setShowHidden((current) => !current)}>
            {showHidden ? t.hideHiddenChunks : t.showHiddenChunks(hiddenChunks.length)}
          </Button>
        </div>
      )}
      {showHidden && hiddenChunks.length > 0 && (
        <Card header={t.hiddenChunks}>
          {hiddenChunks.map((c) => (
            <div key={c.id} className="sentence-row">
              <Button
                variant="ghost"
                onClick={() => row.play({ kind: "chunk", id: c.id }, c.en)}
                disabled={anyPlaying}
                ariaLabel={t.playChunkAria(c.id)}
              >
                {row.playingKey?.kind === "chunk" && row.playingKey.id === c.id ? "🔊" : "▶"}
              </Button>
              <div className="sentence-body">
                <span className="sentence-en">{c.en}</span>
                <span className="sentence-ja-sub">{c.promptText}</span>
                {c.note && <span className="text-sm text-muted">{c.note}</span>}
                <ChunkExplain chunk={c} lang={lang} />
              </div>
              <div className="sentence-row-actions">
                <span className="sentence-srs text-sm text-muted">{`st${c.srs.stage} ・ ${c.srs.due.slice(5)}`}</span>
                <Button
                  variant="ghost" loading={changingId === c.id} disabled={changingId !== null}
                  onClick={() => onSetChunkHidden(c.id, false)} ariaLabel={t.restoreChunkAria(c.id)}
                >
                  {t.restoreChunk}
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {categories.map(([catNo, catName]) => (
        <Card key={catNo} header={`${catNo}. ${catName}`}>
          {shown.filter((s) => s.category_no === catNo).map((s) => (
            <div key={s.no} className="sentence-row">
              <Button
                variant="ghost"
                onClick={() => row.play({ kind: "sentence", no: s.no }, s.en)}
                disabled={anyPlaying}
                ariaLabel={t.playAria(s.no)}
              >
                {row.playingKey?.kind === "sentence" && row.playingKey.no === s.no ? "🔊" : "▶"}
              </Button>
              <div className="sentence-body">
                <span className="sentence-en">{s.en}</span>
                <span className="sentence-ja-sub">{s.ja}</span>
                <span className="text-sm text-muted">{s.note}</span>
              </div>
              <span className="sentence-srs text-sm text-muted">
                {s.srs ? `st${s.srs.stage} ・ ${s.srs.due.slice(5)}` : t.srsNew}
              </span>
            </div>
          ))}
        </Card>
      ))}
    </div>
  );
}

/** マイチャンク1件の「もっと詳しく」。チャンクは (元の言い方→自然な言い方, 理由) なので fix-explain を流用する。 */
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
