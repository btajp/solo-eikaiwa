import type { ReactNode } from "react";
import { Button } from "./Button";

/** 全画面で共通に使う録音トグル。録音中だけ既存の脈動表示を付ける。 */
export function RecordButton({
  children,
  recording,
  disabled,
  onClick,
}: {
  children: ReactNode;
  recording: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      variant="primary"
      size="lg"
      className={`record-btn${recording ? " is-recording" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
