export type ClipboardCopyStatus = "idle" | "copying" | "copied" | "error";

export type ClipboardCopyEvent = "start" | "succeeded" | "failed" | "reset";

/** コピー操作は1件ずつ扱い、完了・失敗のあとだけ次の操作を受け付ける。 */
export function transitionClipboardCopyStatus(
  status: ClipboardCopyStatus,
  event: ClipboardCopyEvent,
): ClipboardCopyStatus {
  switch (event) {
    case "start": return status === "copying" ? status : "copying";
    case "succeeded": return status === "copying" ? "copied" : status;
    case "failed": return status === "copying" ? "error" : status;
    case "reset": return status === "copied" || status === "error" ? "idle" : status;
  }
}

export function canStartClipboardCopy(status: ClipboardCopyStatus): boolean {
  return status !== "copying";
}
