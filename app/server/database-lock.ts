import { existsSync } from "node:fs";

export const RESTORE_LOCK_SUFFIX = ".restore-lock";

export function restoreLockPath(dbPath: string): string {
  return `${dbPath}${RESTORE_LOCK_SUFFIX}`;
}

export function assertDatabaseNotRestoring(dbPath: string): void {
  if (dbPath === ":memory:") return;
  const lockPath = restoreLockPath(dbPath);
  if (existsSync(lockPath)) {
    throw new Error(
      `データベースのrestoreが進行中です: ${lockPath}。完了を待ってください。異常終了後も残る場合は、restoreプロセスが無いことを確認してlockを別名へ退避してください。`,
    );
  }
}
