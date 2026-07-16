import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const INSTALL_DAEMON_SCRIPT = path.join(REPO_ROOT, "scripts", "install-daemon.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function generatePlist(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "solo-plist-"));
  tempDirs.push(dir);
  const out = path.join(dir, "test.plist");
  const r = Bun.spawnSync({
    cmd: ["/bin/bash", INSTALL_DAEMON_SCRIPT, "--plist-only", out],
    cwd: REPO_ROOT,
  });
  expect(r.exitCode).toBe(0);
  return readFileSync(out, "utf8");
}

describe("install-daemon.sh --plist-only（#208: ポート占有時の無限再起動を防ぐ plist 条件）", () => {
  test("KeepAlive は SuccessfulExit=false（exit 0 の自発退出では再起動しない・クラッシュ時のみ再起動）", () => {
    const plist = generatePlist();
    // 無条件 KeepAlive=true（終了コードに関係なく約10秒間隔で永久再起動）へ戻さない
    expect(plist).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  });

  test("ThrottleInterval で再起動間隔にバックオフを設ける（launchd既定10秒より長い）", () => {
    const plist = generatePlist();
    const m = plist.match(/<key>ThrottleInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(10);
  });

  test("既存の必須キー（Label・RunAtLoad・ログ出力先）は維持される", () => {
    const plist = generatePlist();
    expect(plist).toContain("<string>com.local.solo-eikaiwa.server</string>");
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toContain("server.stdout.log");
    expect(plist).toContain("server.stderr.log");
  });
});
