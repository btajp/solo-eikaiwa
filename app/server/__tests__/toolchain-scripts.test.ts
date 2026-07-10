import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const CHECK_SCRIPT = path.join(REPO_ROOT, "scripts", "check-toolchain.sh");
const INSTALL_SCRIPT = path.join(REPO_ROOT, "scripts", "install-bun-deps.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFakeTools(options: { bun?: string; tauri?: string } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "solo-toolchain-"));
  tempDirs.push(dir);
  const bun = options.bun ?? "1.3.14";
  const tauri = options.tauri ?? "2.11.4";

  writeFileSync(
    path.join(dir, "bun"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${bun}"; exit 0; fi\nprintf '%s|%s\\n' "$PWD" "$*" >> "$BUN_CAPTURE"\n`,
  );
  writeFileSync(
    path.join(dir, "cargo"),
    `#!/bin/sh\nif [ "$1" = "tauri" ] && [ "$2" = "--version" ]; then echo "tauri-cli ${tauri}"; exit 0; fi\nexit 2\n`,
  );
  chmodSync(path.join(dir, "bun"), 0o755);
  chmodSync(path.join(dir, "cargo"), 0o755);
  return dir;
}

function run(script: string, args: string[], fakeBin: string, extraEnv: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: ["/bin/bash", script, ...args],
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(result: ReturnType<typeof Bun.spawnSync>) {
  return `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
}

describe("toolchain contract", () => {
  test("BunとTauri CLIの期待版を単一JSONにexactで保持する", () => {
    const versions = JSON.parse(readFileSync(path.join(REPO_ROOT, "toolchain.json"), "utf8"));
    expect(versions).toEqual({ bun: "1.3.14", tauriCli: "2.11.4" });
  });

  test("期待版ならBunとTauri CLIの検査が通る", () => {
    const result = run(CHECK_SCRIPT, ["all"], makeFakeTools());
    expect(result.exitCode).toBe(0);
    expect(output(result)).toContain("Bun 1.3.14");
    expect(output(result)).toContain("Tauri CLI 2.11.4");
  });

  test("Bun版違いはexpected/actualを表示して失敗する", () => {
    const result = run(CHECK_SCRIPT, ["bun"], makeFakeTools({ bun: "1.3.13" }));
    expect(result.exitCode).not.toBe(0);
    expect(output(result)).toContain("expected=1.3.14");
    expect(output(result)).toContain("actual=1.3.13");
  });

  test("Tauri CLI版違いはexpected/actualを表示して失敗する", () => {
    const result = run(CHECK_SCRIPT, ["tauri"], makeFakeTools({ tauri: "2.11.3" }));
    expect(result.exitCode).not.toBe(0);
    expect(output(result)).toContain("expected=2.11.4");
    expect(output(result)).toContain("actual=2.11.3");
  });

  test("app/client双方をfrozen lockfileから順に準備する", () => {
    const dir = makeFakeTools();
    const capture = path.join(dir, "calls.txt");
    const result = run(INSTALL_SCRIPT, ["all"], dir, { BUN_CAPTURE: capture });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(capture, "utf8").trim().split("\n")).toEqual([
      `${path.join(REPO_ROOT, "app")}|install --frozen-lockfile`,
      `${path.join(REPO_ROOT, "app", "client")}|install --frozen-lockfile`,
    ]);
  });

  test("manifestとlockfileが不整合ならlockfileを変更せず失敗する", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "solo-frozen-lock-"));
    tempDirs.push(dir);
    const packageFile = path.join(dir, "package.json");
    const lockFile = path.join(dir, "bun.lock");
    copyFileSync(path.join(REPO_ROOT, "app", "package.json"), packageFile);
    copyFileSync(path.join(REPO_ROOT, "app", "bun.lock"), lockFile);

    const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
    manifest.devDependencies["@types/bun"] = "1.3.13";
    writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`);
    const lockBefore = readFileSync(lockFile);

    const result = Bun.spawnSync({
      cmd: [Bun.which("bun")!, "install", "--frozen-lockfile"],
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(readFileSync(lockFile)).toEqual(lockBefore);
  });
});

describe("repository guards", () => {
  test("Bun/Viteが読むenv派生ファイルを全階層で除外する", () => {
    for (const candidate of [
      "app/.env.local",
      "app/.env.production",
      "app/.env.development",
      "app/client/.env",
      "app/client/.env.local",
    ]) {
      const result = Bun.spawnSync({ cmd: ["git", "check-ignore", "-q", "--", candidate], cwd: REPO_ROOT });
      expect(result.exitCode, candidate).toBe(0);
    }
    const example = Bun.spawnSync({
      cmd: ["git", "ls-files", "--error-unmatch", "app/.env.example"],
      cwd: REPO_ROOT,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(example.exitCode).toBe(0);
  });

  test("server typecheckの対象に教材scriptsを含める", () => {
    const tsconfig = JSON.parse(readFileSync(path.join(REPO_ROOT, "app", "tsconfig.json"), "utf8"));
    expect(tsconfig.include).toContain("../scripts");
  });

  test("全consumerが共通のfrozen install helperを使う", () => {
    for (const relative of [
      "scripts/setup.sh",
      "scripts/install-daemon.sh",
      "desktop/build-sidecar.sh",
      "scripts/release-desktop.sh",
    ]) {
      const text = readFileSync(path.join(REPO_ROOT, relative), "utf8");
      expect(text, relative).toContain("install-bun-deps.sh");
      expect(text, relative).not.toMatch(/bun install(?! --frozen-lockfile)/);
    }
  });

  test("releaseは依存準備後に検証しbuild後にもcleanを強制する", () => {
    const text = readFileSync(path.join(REPO_ROOT, "scripts", "release-desktop.sh"), "utf8");
    const prepare = text.indexOf('install-bun-deps.sh" all');
    const tests = text.lastIndexOf("bun test");
    const build = text.indexOf('build-sidecar.sh"');
    const finalClean = text.lastIndexOf("assert_clean_worktree");
    expect(prepare).toBeGreaterThan(0);
    expect(tests).toBeGreaterThan(prepare);
    expect(finalClean).toBeGreaterThan(build);
  });
});
