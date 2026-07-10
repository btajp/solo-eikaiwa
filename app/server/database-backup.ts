import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { openDb } from "./db";
import { restoreLockPath } from "./database-lock";

export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_DATABASE_FILE = "database.sqlite";
export const BACKUP_MANIFEST_FILE = "manifest.json";

export type DatabaseBackupManifest = {
  formatVersion: number;
  createdAt: string;
  sourceDatabaseName: string;
  database: {
    file: typeof BACKUP_DATABASE_FILE;
    sizeBytes: number;
    sha256: string;
    schemaSha256: string;
    integrityCheck: "ok";
  };
};

export type VerifiedDatabaseBackup = {
  manifest: DatabaseBackupManifest;
  databasePath: string;
};

export type RestoreResult = {
  targetDbPath: string;
  rollbackSnapshotDir: string | null;
};

type IntegrityRow = { integrity_check: string };
type SchemaRow = { type: string; name: string; tableName: string; sql: string | null };
type CheckpointRow = { busy: number; log: number; checkpointed: number };
type JournalModeRow = { journal_mode: string };

export class BackupValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BackupValidationError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function schemaSha256(filePath: string): string {
  const db = new Database(filePath, { readonly: true });
  try {
    const rows = db.query<SchemaRow, []>(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema
      WHERE name NOT LIKE 'sqlite_%'
      ORDER BY type, name
    `).all();
    return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  } finally {
    db.close();
  }
}

function assertIntegrity(filePath: string, label: string): void {
  let db: Database | undefined;
  try {
    db = new Database(filePath, { readonly: true });
    const rows = db.query<IntegrityRow, []>("PRAGMA integrity_check").all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      const details = rows.map((row) => row.integrity_check).join("; ") || "no result";
      throw new BackupValidationError(`${label}: integrity_check failed: ${details}`);
    }
  } catch (error) {
    if (error instanceof BackupValidationError) throw error;
    throw new BackupValidationError(`${label}: integrity_checkを実行できません: ${errorText(error)}`, {
      cause: error,
    });
  } finally {
    db?.close();
  }
}

function syncPath(filePath: string): void {
  const fd = openSync(filePath, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function acquireRestoreLock(targetDbPath: string): { fd: number; lockPath: string } {
  const lockPath = restoreLockPath(targetDbPath);
  let fd: number;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (error) {
    throw new BackupValidationError(
      `restore lockを取得できません。別のrestoreが無いことを確認してください: ${lockPath}: ${errorText(error)}`,
      { cause: error },
    );
  }
  writeSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
  fsyncSync(fd);
  syncPath(path.dirname(lockPath));
  return { fd, lockPath };
}

function releaseRestoreLock(lock: { fd: number; lockPath: string }): void {
  closeSync(lock.fd);
  rmSync(lock.lockPath, { force: true });
  syncPath(path.dirname(lock.lockPath));
}

function assertRegularFile(filePath: string, label: string): void {
  if (!existsSync(filePath)) throw new BackupValidationError(`${label}がありません: ${filePath}`);
  const stat = lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new BackupValidationError(`${label}は通常ファイルである必要があります: ${filePath}`);
  }
}

function parseManifest(snapshotDir: string): DatabaseBackupManifest {
  const manifestPath = path.join(snapshotDir, BACKUP_MANIFEST_FILE);
  assertRegularFile(manifestPath, "backup manifest");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new BackupValidationError(`backup manifestを解析できません: ${errorText(error)}`, { cause: error });
  }
  if (!raw || typeof raw !== "object") throw new BackupValidationError("backup manifestの形式が不正です");
  const manifest = raw as Partial<DatabaseBackupManifest>;
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupValidationError(
      `未対応のbackup formatVersionです: expected=${BACKUP_FORMAT_VERSION}, actual=${String(manifest.formatVersion)}`,
    );
  }
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) {
    throw new BackupValidationError("backup manifest.createdAtが不正です");
  }
  if (typeof manifest.sourceDatabaseName !== "string" || !manifest.sourceDatabaseName) {
    throw new BackupValidationError("backup manifest.sourceDatabaseNameが不正です");
  }
  const database = manifest.database;
  const hashPattern = /^[0-9a-f]{64}$/;
  if (
    !database
    || database.file !== BACKUP_DATABASE_FILE
    || !Number.isSafeInteger(database.sizeBytes)
    || database.sizeBytes < 0
    || !hashPattern.test(database.sha256 ?? "")
    || !hashPattern.test(database.schemaSha256 ?? "")
    || database.integrityCheck !== "ok"
  ) {
    throw new BackupValidationError("backup manifest.databaseの形式が不正です");
  }
  return manifest as DatabaseBackupManifest;
}

export async function createDatabaseBackup(options: {
  sourceDbPath: string;
  destinationDir: string;
  now?: Date;
}): Promise<VerifiedDatabaseBackup> {
  const sourceDbPath = path.resolve(options.sourceDbPath);
  const destinationDir = path.resolve(options.destinationDir);
  assertRegularFile(sourceDbPath, "source database");
  if (existsSync(destinationDir)) {
    throw new BackupValidationError(`backup先は既に存在します: ${destinationDir}`);
  }

  const parentDir = path.dirname(destinationDir);
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const stagingDir = path.join(parentDir, `.${path.basename(destinationDir)}.partial-${randomUUID()}`);
  mkdirSync(stagingDir, { mode: 0o700 });
  const stagingDatabasePath = path.join(stagingDir, BACKUP_DATABASE_FILE);
  try {
    const source = new Database(sourceDbPath, { readonly: true });
    try {
      source.run("PRAGMA busy_timeout = 5000");
      source.run("VACUUM INTO ?", [stagingDatabasePath]);
    } finally {
      source.close();
    }
    chmodSync(stagingDatabasePath, 0o600);
    syncPath(stagingDatabasePath);
    assertIntegrity(stagingDatabasePath, "作成したsnapshot");

    const manifest: DatabaseBackupManifest = {
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: (options.now ?? new Date()).toISOString(),
      sourceDatabaseName: path.basename(sourceDbPath),
      database: {
        file: BACKUP_DATABASE_FILE,
        sizeBytes: statSync(stagingDatabasePath).size,
        sha256: await sha256File(stagingDatabasePath),
        schemaSha256: schemaSha256(stagingDatabasePath),
        integrityCheck: "ok",
      },
    };
    const manifestPath = path.join(stagingDir, BACKUP_MANIFEST_FILE);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    syncPath(manifestPath);
    syncPath(stagingDir);
    renameSync(stagingDir, destinationDir);
    syncPath(parentDir);
    return { manifest, databasePath: path.join(destinationDir, BACKUP_DATABASE_FILE) };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyDatabaseBackup(snapshotDir: string): Promise<VerifiedDatabaseBackup> {
  const resolvedDir = path.resolve(snapshotDir);
  const manifest = parseManifest(resolvedDir);
  const databasePath = path.join(resolvedDir, BACKUP_DATABASE_FILE);
  assertRegularFile(databasePath, "backup database");
  const actualSize = statSync(databasePath).size;
  if (actualSize !== manifest.database.sizeBytes) {
    throw new BackupValidationError(
      `backup database size mismatch: expected=${manifest.database.sizeBytes}, actual=${actualSize}`,
    );
  }
  const actualChecksum = await sha256File(databasePath);
  if (actualChecksum !== manifest.database.sha256) {
    throw new BackupValidationError(
      `backup database checksum mismatch: expected=${manifest.database.sha256}, actual=${actualChecksum}`,
    );
  }
  assertIntegrity(databasePath, "backup database");
  const actualSchemaChecksum = schemaSha256(databasePath);
  if (actualSchemaChecksum !== manifest.database.schemaSha256) {
    throw new BackupValidationError(
      `backup database schema checksum mismatch: expected=${manifest.database.schemaSha256}, actual=${actualSchemaChecksum}`,
    );
  }
  return { manifest, databasePath };
}

function uniqueSnapshotDir(root: string, prefix: string, now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(root, `${prefix}-${stamp}-${randomUUID().slice(0, 8)}`);
}

function removeCandidateFiles(candidatePath: string): void {
  for (const filePath of [candidatePath, `${candidatePath}-wal`, `${candidatePath}-shm`]) {
    rmSync(filePath, { force: true });
  }
}

function prepareRestoreCandidate(snapshotPath: string, candidatePath: string): void {
  copyFileSync(snapshotPath, candidatePath, constants.COPYFILE_EXCL);
  chmodSync(candidatePath, 0o600);
  const candidate = openDb(candidatePath);
  try {
    const checkpoint = candidate.query<CheckpointRow, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (!checkpoint || checkpoint.busy !== 0 || checkpoint.log !== checkpoint.checkpointed) {
      throw new BackupValidationError(
        `restore候補のWAL checkpointに失敗しました: ${JSON.stringify(checkpoint ?? null)}`,
      );
    }
    const journalMode = candidate.query<JournalModeRow, []>("PRAGMA journal_mode = DELETE").get();
    if (journalMode?.journal_mode !== "delete") {
      throw new BackupValidationError(`restore候補を単一DBへ確定できません: ${JSON.stringify(journalMode ?? null)}`);
    }
  } finally {
    candidate.close();
  }
  const walPath = `${candidatePath}-wal`;
  if (existsSync(walPath) && statSync(walPath).size > 0) {
    throw new BackupValidationError("restore候補のWALがcheckpoint後も残っています");
  }
  rmSync(walPath, { force: true });
  rmSync(`${candidatePath}-shm`, { force: true });
  assertIntegrity(candidatePath, "restore候補");
  syncPath(candidatePath);
}

function archiveOriginalFiles(targetDbPath: string, archiveDir: string): Array<{ from: string; to: string }> {
  mkdirSync(archiveDir, { mode: 0o700 });
  const archived: Array<{ from: string; to: string }> = [];
  try {
    for (const from of [targetDbPath, `${targetDbPath}-wal`, `${targetDbPath}-shm`]) {
      if (!existsSync(from)) continue;
      const to = path.join(archiveDir, path.basename(from));
      renameSync(from, to);
      archived.push({ from, to });
    }
    return archived;
  } catch (error) {
    try {
      for (const entry of archived.toReversed()) renameSync(entry.to, entry.from);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `現DBの退避と巻き戻しに失敗しました: ${archiveDir}`);
    }
    throw error;
  }
}

function rollbackInstalledDatabase(
  targetDbPath: string,
  rollbackSnapshotDir: string,
  archived: Array<{ from: string; to: string }>,
): void {
  if (existsSync(targetDbPath)) renameSync(targetDbPath, path.join(rollbackSnapshotDir, "failed-restore.sqlite"));
  for (const suffix of ["-wal", "-shm"]) {
    const current = `${targetDbPath}${suffix}`;
    if (existsSync(current)) renameSync(current, path.join(rollbackSnapshotDir, `failed-restore.sqlite${suffix}`));
  }
  for (const entry of archived.toReversed()) renameSync(entry.to, entry.from);
}

export async function restoreDatabaseBackup(
  options: {
    snapshotDir: string;
    targetDbPath: string;
    rollbackRoot: string;
    now?: Date;
  },
  deps: {
    assertStopped?: () => void | Promise<void>;
    afterInstall?: (targetDbPath: string) => void | Promise<void>;
  } = {},
): Promise<RestoreResult> {
  const verified = await verifyDatabaseBackup(options.snapshotDir);
  const targetDbPath = path.resolve(options.targetDbPath);
  const rollbackRoot = path.resolve(options.rollbackRoot);
  const targetParent = path.dirname(targetDbPath);
  mkdirSync(targetParent, { recursive: true, mode: 0o700 });
  const restoreLock = acquireRestoreLock(targetDbPath);
  try {
    await deps.assertStopped?.();
    return await restoreVerifiedDatabase(verified, targetDbPath, rollbackRoot, options.now, deps);
  } finally {
    releaseRestoreLock(restoreLock);
  }
}

async function restoreVerifiedDatabase(
  verified: VerifiedDatabaseBackup,
  targetDbPath: string,
  rollbackRoot: string,
  now: Date | undefined,
  deps: { afterInstall?: (targetDbPath: string) => void | Promise<void> },
): Promise<RestoreResult> {
  const targetParent = path.dirname(targetDbPath);
  if (existsSync(targetDbPath) && lstatSync(targetDbPath).isSymbolicLink()) {
    throw new BackupValidationError(`restore先DBにsymbolic linkは使えません: ${targetDbPath}`);
  }
  if (!existsSync(targetDbPath) && (existsSync(`${targetDbPath}-wal`) || existsSync(`${targetDbPath}-shm`))) {
    throw new BackupValidationError("DB本体が無い状態でWAL/SHMだけが存在するためrestoreを中止しました");
  }

  const candidatePath = path.join(targetParent, `.${path.basename(targetDbPath)}.restore-${randomUUID()}`);
  let rollbackSnapshotDir: string | null = null;
  let archived: Array<{ from: string; to: string }> = [];
  let candidateInstalled = false;
  try {
    prepareRestoreCandidate(verified.databasePath, candidatePath);
    const candidateChecksum = await sha256File(candidatePath);

    if (existsSync(targetDbPath)) {
      mkdirSync(rollbackRoot, { recursive: true, mode: 0o700 });
      if (statSync(targetParent).dev !== statSync(rollbackRoot).dev) {
        throw new BackupValidationError("rollbackRootはrestore先DBと同じfilesystem上に置く必要があります");
      }
      rollbackSnapshotDir = uniqueSnapshotDir(rollbackRoot, "pre-restore", now);
      await createDatabaseBackup({
        sourceDbPath: targetDbPath,
        destinationDir: rollbackSnapshotDir,
        now,
      });
      const archiveDir = path.join(rollbackSnapshotDir, "original-files");
      archived = archiveOriginalFiles(targetDbPath, archiveDir);
      syncPath(archiveDir);
      syncPath(targetParent);
    }

    renameSync(candidatePath, targetDbPath);
    candidateInstalled = true;
    syncPath(targetParent);
    await deps.afterInstall?.(targetDbPath);
    const installedChecksum = await sha256File(targetDbPath);
    if (installedChecksum !== candidateChecksum) {
      throw new BackupValidationError(
        `restore後のchecksumが候補と一致しません: expected=${candidateChecksum}, actual=${installedChecksum}`,
      );
    }
    assertIntegrity(targetDbPath, "restore後のdatabase");
    syncPath(targetDbPath);
    syncPath(targetParent);
    return { targetDbPath, rollbackSnapshotDir };
  } catch (error) {
    if ((candidateInstalled || archived.length > 0) && rollbackSnapshotDir) {
      try {
        rollbackInstalledDatabase(targetDbPath, rollbackSnapshotDir, archived);
        syncPath(targetParent);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `復元後の検証と元DBへのrollbackに失敗しました。退避先を保全してください: ${rollbackSnapshotDir}`,
        );
      }
      throw new BackupValidationError(
        `復元後の検証に失敗したため元DBへ戻しました。退避先: ${rollbackSnapshotDir}: ${errorText(error)}`,
        { cause: error },
      );
    }
    if (candidateInstalled) {
      mkdirSync(rollbackRoot, { recursive: true, mode: 0o700 });
      const failedDir = uniqueSnapshotDir(rollbackRoot, "failed-restore", now);
      mkdirSync(failedDir, { mode: 0o700 });
      renameSync(targetDbPath, path.join(failedDir, "failed-restore.sqlite"));
      syncPath(failedDir);
      syncPath(targetParent);
      throw new BackupValidationError(
        `復元後の検証に失敗しました。restore前はDBが無かったため失敗候補だけを退避しました: ${failedDir}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    if (existsSync(candidatePath)) removeCandidateFiles(candidatePath);
  }
}
