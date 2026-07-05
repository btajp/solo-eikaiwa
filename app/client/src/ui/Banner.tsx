import type { ReactNode } from "react";

/** 情報/警告/エラーの通知帯。crimson テキストの後継 */
export function Banner({ kind, children, action }: { kind: "info" | "warn" | "error"; children: ReactNode; action?: ReactNode }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === "error" ? "alert" : "status"}>
      <span>{children}</span>
      {action}
    </div>
  );
}
