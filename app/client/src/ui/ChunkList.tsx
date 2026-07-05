import { Button } from "./Button";

type Chunk = { en: string; ja?: string };

/** 英文太字＋日本語gloss＋🔊スロット。onPlay 省略時は再生ボタンなし */
export function ChunkList({ chunks, playingIdx, onPlay }: { chunks: Chunk[]; playingIdx: number | null; onPlay?: (i: number, en: string) => void }) {
  return (
    <ul className={`chunk-list${onPlay ? "" : " no-audio"}`}>
      {chunks.map((c, i) => (
        <li key={i}>
          {onPlay && (
            <Button variant="ghost" onClick={() => onPlay(i, c.en)} disabled={playingIdx !== null} ariaLabel={`「${c.en}」を再生`}>
              {playingIdx === i ? "…" : "🔊"}
            </Button>
          )}
          <span className="chunk-en">{c.en}</span>
          {c.ja && <span className="chunk-ja">{c.ja}</span>}
        </li>
      ))}
    </ul>
  );
}
