export type PendingListeningLog = { itemId: string; attemptId: string };

/** 保存が未確定の同一聴取ではIDを保持し、別素材・保存確定後の聴取だけ新規発番する。 */
export function resolvePendingListeningLog(
  current: PendingListeningLog | null,
  itemId: string,
  makeId: () => string = () => crypto.randomUUID(),
): PendingListeningLog {
  return current?.itemId === itemId ? current : { itemId, attemptId: makeId() };
}
