#!/usr/bin/env bun
import path from "node:path";
import {
  createDatabaseBackup,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from "../app/server/database-backup";
import { DEFAULT_DB_PATH } from "../app/server/db";
import { DATA_DIR } from "../app/server/paths";

const USAGE = `使い方:
  bun scripts/data-backup.ts backup [snapshot-dir]
  bun scripts/data-backup.ts verify <snapshot-dir>
  bun scripts/data-backup.ts restore <snapshot-dir> --confirm-stopped

restoreはアプリと常駐サーバを停止してから実行してください。現DBは自動でbackupされます。`;

function defaultSnapshotDir(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(DATA_DIR, "backups", `backup-${stamp}`);
}

async function localServerIsRunning(): Promise<boolean> {
  for (const port of [3111, 3112]) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      // 接続不能なら停止済み。次のportも確認する。
    }
  }
  return false;
}

async function assertLocalServerStopped(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await localServerIsRunning()) {
      throw new Error("127.0.0.1:3111/3112でサーバが応答しています。アプリと常駐サーバを停止してください。");
    }
    if (attempt < 2) await Bun.sleep(250);
  }
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (command === "--help" || command === "-h" || !command) {
    console.log(USAGE);
    return;
  }

  if (command === "backup") {
    if (rest.length > 1) throw new Error(USAGE);
    const destinationDir = path.resolve(rest[0] ?? defaultSnapshotDir());
    const result = await createDatabaseBackup({ sourceDbPath: DEFAULT_DB_PATH, destinationDir });
    console.log(`backupを作成しました: ${path.dirname(result.databasePath)}`);
    console.log(`checksum: ${result.manifest.database.sha256}`);
    return;
  }

  if (command === "verify") {
    if (rest.length !== 1) throw new Error(USAGE);
    const result = await verifyDatabaseBackup(rest[0]);
    console.log(`backupは正常です: ${path.dirname(result.databasePath)}`);
    console.log(`createdAt: ${result.manifest.createdAt}`);
    return;
  }

  if (command === "restore") {
    const confirmed = rest.includes("--confirm-stopped");
    const positional = rest.filter((arg) => arg !== "--confirm-stopped");
    if (!confirmed || positional.length !== 1) {
      throw new Error(`restoreにはsnapshot-dirと--confirm-stoppedが必要です。\n${USAGE}`);
    }
    const restored = await restoreDatabaseBackup({
      snapshotDir: positional[0],
      targetDbPath: DEFAULT_DB_PATH,
      rollbackRoot: path.join(DATA_DIR, "backups"),
    }, { assertStopped: assertLocalServerStopped });
    console.log(`restoreが完了しました: ${restored.targetDbPath}`);
    if (restored.rollbackSnapshotDir) {
      console.log(`restore前のデータは退避済みです: ${restored.rollbackSnapshotDir}`);
    }
    return;
  }

  throw new Error(USAGE);
}

main(Bun.argv.slice(2)).catch((error) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
