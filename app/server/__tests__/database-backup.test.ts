import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BACKUP_DATABASE_FILE,
  BACKUP_FORMAT_VERSION,
  BACKUP_MANIFEST_FILE,
  createDatabaseBackup,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from "../database-backup";
import { openDb } from "../db";
import { SERVER_CHECK_PORTS, assertLocalServerStopped } from "../../../scripts/data-backup";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "solo-eikaiwa-backup-"));
  tempDirs.push(dir);
  return dir;
}

function seedDatabase(dbPath: string, value: string): void {
  const db = openDb(dbPath);
  db.run("CREATE TABLE IF NOT EXISTS backup_probe (value TEXT NOT NULL)");
  db.run("DELETE FROM backup_probe");
  db.run("INSERT INTO backup_probe (value) VALUES (?)", [value]);
  db.close();
}

function readProbe(dbPath: string): string {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ value: string }, []>("SELECT value FROM backup_probe").get()!.value;
  } finally {
    db.close();
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rewriteManifest(snapshotDir: string, mutate: (manifest: any) => void): void {
  const manifestPath = path.join(snapshotDir, BACKUP_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mutate(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

describe("database backup", () => {
  test("未checkpointのWALを含む稼働中DBから整合snapshot・manifest・checksumを作る", async () => {
    const root = tempRoot();
    const sourcePath = path.join(root, "source.db");
    const snapshotDir = path.join(root, "snapshot");
    const source = openDb(sourcePath);
    source.run("PRAGMA wal_autocheckpoint = 0");
    source.run("CREATE TABLE backup_probe (value TEXT NOT NULL)");
    source.run("PRAGMA wal_checkpoint(TRUNCATE)");
    source.run("INSERT INTO backup_probe (value) VALUES ('from-wal')");
    expect(statSync(`${sourcePath}-wal`).size).toBeGreaterThan(0);

    const created = await createDatabaseBackup({ sourceDbPath: sourcePath, destinationDir: snapshotDir });

    expect(created.manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    expect(created.manifest.database.integrityCheck).toBe("ok");
    expect(created.manifest.database.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(created.manifest.database.schemaSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(readProbe(created.databasePath)).toBe("from-wal");
    expect(await verifyDatabaseBackup(snapshotDir)).toEqual(created);
    source.close();
  });

  test("snapshotのchecksum不一致をrestore前に拒否する", async () => {
    const root = tempRoot();
    const sourcePath = path.join(root, "source.db");
    const snapshotDir = path.join(root, "snapshot");
    seedDatabase(sourcePath, "valid");
    await createDatabaseBackup({ sourceDbPath: sourcePath, destinationDir: snapshotDir });
    const databasePath = path.join(snapshotDir, BACKUP_DATABASE_FILE);
    const bytes = readFileSync(databasePath);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(databasePath, bytes);

    await expect(verifyDatabaseBackup(snapshotDir)).rejects.toThrow("checksum");
  });

  test("checksumを改ざんに合わせてもintegrity_checkで破損DBを拒否する", async () => {
    const root = tempRoot();
    const sourcePath = path.join(root, "source.db");
    const snapshotDir = path.join(root, "snapshot");
    seedDatabase(sourcePath, "valid");
    await createDatabaseBackup({ sourceDbPath: sourcePath, destinationDir: snapshotDir });
    const databasePath = path.join(snapshotDir, BACKUP_DATABASE_FILE);
    const bytes = readFileSync(databasePath);
    bytes.fill(0, 0, 16);
    writeFileSync(databasePath, bytes);
    rewriteManifest(snapshotDir, (manifest) => {
      manifest.database.sha256 = sha256(bytes);
    });

    await expect(verifyDatabaseBackup(snapshotDir)).rejects.toThrow("integrity_check");
  });

  test("未対応のbackup format versionを拒否する", async () => {
    const root = tempRoot();
    const sourcePath = path.join(root, "source.db");
    const snapshotDir = path.join(root, "snapshot");
    seedDatabase(sourcePath, "valid");
    await createDatabaseBackup({ sourceDbPath: sourcePath, destinationDir: snapshotDir });
    rewriteManifest(snapshotDir, (manifest) => {
      manifest.formatVersion = BACKUP_FORMAT_VERSION + 1;
    });

    await expect(verifyDatabaseBackup(snapshotDir)).rejects.toThrow("formatVersion");
  });
});

describe("database restore", () => {
  test("候補を検証し、現DBを自動backup・生ファイル退避してから切り替える", async () => {
    const root = tempRoot();
    const sourcePath = path.join(root, "source.db");
    const targetPath = path.join(root, "target", "learn-english.db");
    const snapshotDir = path.join(root, "snapshot");
    const rollbackRoot = path.join(root, "rollback");
    seedDatabase(sourcePath, "from-backup");
    seedDatabase(targetPath, "current-data");
    const originalBytes = readFileSync(targetPath);
    await createDatabaseBackup({ sourceDbPath: sourcePath, destinationDir: snapshotDir });

    const restored = await restoreDatabaseBackup({ snapshotDir, targetDbPath: targetPath, rollbackRoot });

    expect(readProbe(targetPath)).toBe("from-backup");
    expect(restored.rollbackSnapshotDir).not.toBeNull();
    expect(readProbe(path.join(restored.rollbackSnapshotDir!, BACKUP_DATABASE_FILE))).toBe("current-data");
    const archivedOriginal = path.join(restored.rollbackSnapshotDir!, "original-files", path.basename(targetPath));
    expect(readFileSync(archivedOriginal)).toEqual(originalBytes);
  });

  test("非互換schemaのsnapshotは現DBとrollback領域に触れる前に拒否する", async () => {
    const root = tempRoot();
    const sourcePath = path.join(root, "incompatible.db");
    const targetPath = path.join(root, "target.db");
    const snapshotDir = path.join(root, "snapshot");
    const rollbackRoot = path.join(root, "rollback");
    const incompatible = new Database(sourcePath, { create: true });
    incompatible.run("CREATE TABLE user_progress (id INTEGER PRIMARY KEY, level TEXT NOT NULL)");
    incompatible.close();
    seedDatabase(targetPath, "current-data");
    const before = readFileSync(targetPath);
    await createDatabaseBackup({ sourceDbPath: sourcePath, destinationDir: snapshotDir });

    await expect(restoreDatabaseBackup({ snapshotDir, targetDbPath: targetPath, rollbackRoot }))
      .rejects.toThrow("互換性がありません");
    expect(readFileSync(targetPath)).toEqual(before);
    expect(existsSync(rollbackRoot) ? readdirSync(rollbackRoot) : []).toEqual([]);
  });

  test("切替後の最終検証に失敗したら元DBをbyte単位で戻し、失敗候補も保存する", async () => {
    const root = tempRoot();
    const sourcePath = path.join(root, "source.db");
    const targetPath = path.join(root, "target.db");
    const snapshotDir = path.join(root, "snapshot");
    const rollbackRoot = path.join(root, "rollback");
    seedDatabase(sourcePath, "from-backup");
    seedDatabase(targetPath, "current-data");
    const before = readFileSync(targetPath);
    await createDatabaseBackup({ sourceDbPath: sourcePath, destinationDir: snapshotDir });
    let sawRestoreLock = false;

    await expect(restoreDatabaseBackup(
      { snapshotDir, targetDbPath: targetPath, rollbackRoot },
      {
        afterInstall(installedPath) {
          sawRestoreLock = existsSync(`${installedPath}.restore-lock`);
          const bytes = readFileSync(installedPath);
          bytes.fill(0, 0, 16);
          writeFileSync(installedPath, bytes);
        },
      },
    )).rejects.toThrow("復元後の検証に失敗");

    expect(readFileSync(targetPath)).toEqual(before);
    expect(sawRestoreLock).toBe(true);
    expect(existsSync(`${targetPath}.restore-lock`)).toBe(false);
    expect(readProbe(targetPath)).toBe("current-data");
    const rollbackDirs = readdirSync(rollbackRoot).map((name) => path.join(rollbackRoot, name));
    expect(rollbackDirs).toHaveLength(1);
    expect(existsSync(path.join(rollbackDirs[0], "failed-restore.sqlite"))).toBe(true);
  });

  test("restore lock中は別プロセス相当のopenDbを拒否する", async () => {
    const root = tempRoot();
    const sourcePath = path.join(root, "source.db");
    const targetPath = path.join(root, "target.db");
    const snapshotDir = path.join(root, "snapshot");
    seedDatabase(sourcePath, "from-backup");
    seedDatabase(targetPath, "current-data");
    await createDatabaseBackup({ sourceDbPath: sourcePath, destinationDir: snapshotDir });

    await restoreDatabaseBackup(
      { snapshotDir, targetDbPath: targetPath, rollbackRoot: path.join(root, "rollback") },
      {
        assertStopped() {
          expect(() => openDb(targetPath)).toThrow("restoreが進行中");
        },
      },
    );
    expect(existsSync(`${targetPath}.restore-lock`)).toBe(false);
  });
});

describe("data-backup CLI", () => {
  const script = path.resolve(import.meta.dir, "../../../scripts/data-backup.ts");

  test("helpは利用可能な3操作とrestoreの停止確認を案内する", () => {
    const result = Bun.spawnSync({ cmd: [Bun.which("bun")!, script, "--help"], stdout: "pipe", stderr: "pipe" });
    const output = `${result.stdout.toString()}${result.stderr.toString()}`;
    expect(result.exitCode).toBe(0);
    expect(output).toContain("backup [snapshot-dir]");
    expect(output).toContain("verify <snapshot-dir>");
    expect(output).toContain("restore <snapshot-dir> --confirm-stopped");
  });

  test("停止確認フラグなしのrestoreはDBへ触れる前に拒否する", () => {
    const result = Bun.spawnSync({
      cmd: [Bun.which("bun")!, script, "restore", "/not-used"],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("--confirm-stoppedが必要");
  });

  test("稼働検知portはdesktopのCANDIDATE_PORTSと同じ3111〜3114を同じ並びで確認する", () => {
    // desktop/src-tauri/src/sidecar.rs の CANDIDATE_PORTS と揃える（v0.29.2の自動fallback対応）
    expect([...SERVER_CHECK_PORTS]).toEqual([3111, 3112, 3113, 3114]);
  });

  test("3113/3114だけで稼働中のサーバも検知してrestoreの停止確認を拒否する", async () => {
    for (const runningPort of [3113, 3114]) {
      const probedPorts: number[] = [];
      const fetchLike = async (url: string) => {
        const port = Number(new URL(url).port);
        probedPorts.push(port);
        if (port === runningPort) return new Response("ok");
        throw new Error("connection refused");
      };
      await expect(assertLocalServerStopped(fetchLike)).rejects.toThrow("3111〜3114");
      expect(probedPorts).toContain(runningPort);
    }
  });

  test("全candidate portが停止していればrestoreの停止確認を通過する", async () => {
    const fetchLike = async () => {
      throw new Error("connection refused");
    };
    await expect(assertLocalServerStopped(fetchLike)).resolves.toBeUndefined();
  });
});
