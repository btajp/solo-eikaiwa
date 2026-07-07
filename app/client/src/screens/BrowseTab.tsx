import { useState } from "react";
import {
  deleteChunk, fetchChunks, fetchFixExplanation, fetchSentences, type ChunkListItem, type SentenceItem,
} from "../api";
import { STR, type Lang } from "../i18n";
import { useLoad } from "../useLoad";
import { usePlayRow } from "../usePlayRow";
import { useExplain } from "../useExplain";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";

/** 行キー: 例文は no、チャンクは id。種別を混ぜないよう kind でタグ付けする */
type RowKey = { kind: "sentence"; no: number } | { kind: "chunk"; id: number };

/** 一覧タブ: domainフィルタ + カテゴリ見出しでのブラウズ。SRS状態は情報表示のみ */
export function BrowseTab({ lang }: { lang: Lang }) {
  const t = STR[lang].sentences;
  const load = useLoad(async () => {
    const all = await fetchSentences();
    // チャンクは補助セクション — 取得失敗でも例文一覧は表示する
    let cs: ChunkListItem[] = [];
    try { cs = await fetchChunks(); } catch { /* ignore */ }
    return { items: all, chunks: cs };
  });
  const [filter, setFilter] = useState<"all" | SentenceItem["domain"]>("all");
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [removedIds, setRemovedIds] = useState<number[]>([]);
  const row = usePlayRow<RowKey>();
  const anyPlaying = row.playingKey !== null;

  const items = load.state.status === "ready" ? load.state.data.items : [];
  const chunks = (load.state.status === "ready" ? load.state.data.chunks : []).filter((c) => !removedIds.includes(c.id));

  /** 削除は2タップ式: 1タップ目でボタンが「削除する?」に変わり、2タップ目で確定 */
  async function onDeleteChunk(id: number) {
    if (deletingId !== id) {
      setDeletingId(id);
      return;
    }
    try {
      await deleteChunk(id);
      setRemovedIds((prev) => [...prev, id]);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingId(null);
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
      {(row.error || deleteError) && <Banner kind="error">{row.error || deleteError}</Banner>}
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
              <span className="sentence-srs text-sm text-muted">{`st${c.srs.stage} ・ ${c.srs.due.slice(5)}`}</span>
              <Button variant={deletingId === c.id ? "danger" : "ghost"} onClick={() => onDeleteChunk(c.id)} ariaLabel={t.deleteAria(c.id)}>
                {deletingId === c.id ? t.deleteConfirm : "🗑"}
              </Button>
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
    <>
      {state.status === "idle" && (
        <Button variant="ghost" onClick={request}>{t.explainMore}</Button>
      )}
      {state.status === "loading" && <p className="text-sm text-muted">{t.explainLoading}</p>}
      {state.status === "error" && (
        <p className="text-sm text-muted">{t.explainError}<Button variant="ghost" onClick={request}>{t.retry}</Button></p>
      )}
      {state.status === "done" && <p className="sentence-explain text-sm">{state.text}</p>}
    </>
  );
}
