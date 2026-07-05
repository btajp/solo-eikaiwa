import type { ReactNode } from "react";

export function Card({ header, children, className }: { header?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card${className ? ` ${className}` : ""}`}>
      {header && <div className="card-header">{header}</div>}
      {children}
    </section>
  );
}
