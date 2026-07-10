export type ClipboardCopyStatus = "idle" | "copying" | "copied" | "error";

export type ClipboardCopyEvent = "start" | "succeeded" | "failed" | "reset";

/** コピー操作は1件ずつ扱い、完了・失敗のあとだけ次の操作を受け付ける。 */
export function transitionClipboardCopyStatus(
  _status: ClipboardCopyStatus,
  event: ClipboardCopyEvent,
): ClipboardCopyStatus {
  switch (event) {
    case "start": return "copying";
    case "succeeded": return "copied";
    case "failed": return "error";
    case "reset": return "idle";
  }
}

export function canStartClipboardCopy(status: ClipboardCopyStatus): boolean {
  return status !== "copying";
}
