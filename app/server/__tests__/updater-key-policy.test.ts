import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const POLICY_SCRIPT = path.join(REPO_ROOT, "scripts", "check-updater-key-policy.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function output(result: ReturnType<typeof Bun.spawnSync>) {
  return `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
}

function makeFixture(currentKey: string, signingKey: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "solo-updater-key-policy-"));
  tempDirs.push(dir);
  const configDir = path.join(dir, "desktop", "src-tauri");
  const keyPath = path.join(dir, "updater.key");
  const fakeBin = path.join(dir, "bin");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    path.join(configDir, "tauri.conf.json"),
    JSON.stringify({ plugins: { updater: { pubkey: currentKey } } }),
  );
  writeFileSync(keyPath, "private key is not inspected by the policy checker");
  writeFileSync(`${keyPath}.pub`, `${signingKey}\n`);
  writeFileSync(
    path.join(fakeBin, "git"),
    `#!/bin/sh
case "$3" in
  tag) printf '%s\\n' "\${FAKE_TAGS:-}" ;;
  show) printf '%s' "\${FAKE_PREVIOUS_CONFIG:-}" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(path.join(fakeBin, "git"), 0o755);
  return { dir, fakeBin, keyPath };
}

function runPolicy(
  currentKey: string,
  signingKey: string,
  previousKey?: string | null,
  allowRotation = false,
) {
  const fixture = makeFixture(currentKey, signingKey);
  return Bun.spawnSync({
    cmd: [
      "/bin/bash",
      POLICY_SCRIPT,
      "--repo",
      fixture.dir,
      "--private-key",
      fixture.keyPath,
      ...(allowRotation ? ["--allow-pubkey-rotation"] : []),
    ],
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      FAKE_TAGS: previousKey === undefined ? "" : "v0.29.0",
      FAKE_PREVIOUS_CONFIG:
        previousKey === undefined
          ? ""
          : JSON.stringify({ plugins: { updater: previousKey === null ? {} : { pubkey: previousKey } } }),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("updater signing-key policy", () => {
  test("初回リリースは設定鍵と署名鍵の一致を必須にする", () => {
    const result = runPolicy("first-key", "first-key");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("first-key");
  });

  test("通常リリースは直前リリースと同じ鍵を使う", () => {
    const result = runPolicy("stable-key", "stable-key", "stable-key");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("stable-key");
  });

  test("updater導入前の直前リリースは初回鍵として扱う", () => {
    const result = runPolicy("first-key", "first-key", null);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("first-key");
    expect(output(result)).toContain("初回鍵");
  });

  test("鍵変更は明示フラグなしでは中断する", () => {
    const result = runPolicy("new-key", "old-key", "old-key");
    expect(result.exitCode).not.toBe(0);
    expect(output(result)).toContain("--allow-pubkey-rotation");
  });

  test("明示フラグ付きの橋渡しリリースは直前の鍵で検証する", () => {
    const result = runPolicy("new-key", "old-key", "old-key", true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe("old-key");
    expect(output(result)).toContain("橋渡しリリース");
  });

  test("橋渡しリリースを新鍵で署名する誤りを拒否する", () => {
    const result = runPolicy("new-key", "new-key", "old-key", true);
    expect(result.exitCode).not.toBe(0);
    expect(output(result)).toContain("直前リリースの署名鍵");
  });

  test("リリーススクリプトは鍵ポリシーと生成物の実証を呼ぶ", () => {
    const releaseScript = readFileSync(path.join(REPO_ROOT, "scripts", "release-desktop.sh"), "utf8");
    expect(releaseScript).toContain("check-updater-key-policy.sh");
    expect(releaseScript).toContain("verify-updater-signature");
    expect(releaseScript).toContain("--allow-pubkey-rotation");
  });
});
