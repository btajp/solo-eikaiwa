import type { ReactNode } from "react";

/** ブロック進捗ドット（情報表示のみ）。aria ラベルは呼び出し側が i18n 済み文字列を渡す */
export function ProgressDots({ current, total, label }: { current: number; total: number; label: string }) {
  return (
    <span className="progress-dots" aria-label={label}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`dot${i < current ? " is-done" : i === current ? " is-active" : ""}`} />
      ))}
    </span>
  );
}

/** 画面シェル: タイトル行 + 右側 meta スロット（進捗ドット・タイマーチップ等）。読み物系は幅を絞る */
export function Screen({ title, meta, children }: { title?: ReactNode; meta?: ReactNode; children: ReactNode }) {
  return (
    <div className="screen">
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
