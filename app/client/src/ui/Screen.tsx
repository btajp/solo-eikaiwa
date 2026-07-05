import type { ReactNode } from "react";

/** ブロック進捗ドット（情報表示のみ） */
export function ProgressDots({ current, total }: { current: number; total: number }) {
  return (
    <span className="progress-dots" aria-label={`ブロック ${current + 1}/${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`dot${i < current ? " is-done" : i === current ? " is-active" : ""}`} />
      ))}
    </span>
  );
}

/** 画面シェル: タイトル行 + 右側 meta スロット（進捗ドット・タイマーチップ等） */
export function Screen({ title, meta, children }: { title?: ReactNode; meta?: ReactNode; children: ReactNode }) {
  return (
    <div>
      {(title || meta) && (
        <div className="screen-header">
          {title && <h2 className="screen-title">{title}</h2>}
          {meta && <span className="screen-meta">{meta}</span>}
        </div>
      )}
      {children}
    </div>
  );
}
