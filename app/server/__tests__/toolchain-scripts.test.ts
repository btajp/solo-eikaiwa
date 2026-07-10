import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
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
const DAEMON_SCRIPT = path.join(REPO_ROOT, "scripts", "daemon-server.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeFakeTools(options: { bun?: string; tauri?: string; cargoAudit?: string } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "solo-toolchain-"));
  tempDirs.push(dir);
  const bun = options.bun ?? "1.3.14";
  const tauri = options.tauri ?? "2.11.4";
  const cargoAudit = options.cargoAudit ?? "0.22.2";

  writeFileSync(
    path.join(dir, "bun"),
    `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${bun}"; exit 0; fi\nprintf '%s|%s\\n' "$PWD" "$*" >> "$BUN_CAPTURE"\n`,
  );
  writeFileSync(
    path.join(dir, "cargo"),
    `#!/bin/sh\nif [ "$1" = "tauri" ] && [ "$2" = "--version" ]; then echo "tauri-cli ${tauri}"; exit 0; fi\nif [ "$1" = "audit" ] && [ "$2" = "--version" ]; then echo "cargo-audit ${cargoAudit}"; exit 0; fi\nexit 2\n`,
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

async function runDaemonWithDeadline(env: Record<string, string>) {
  const proc = Bun.spawn({
    cmd: ["/bin/bash", DAEMON_SCRIPT],
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  let killedByTest = false;
  const timer = setTimeout(() => {
    killedByTest = true;
    proc.kill();
  }, 2_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode, killedByTest };
  } finally {
    clearTimeout(timer);
  }
}

function writeExecutable(file: string, contents: string) {
  writeFileSync(file, contents);
  chmodSync(file, 0o755);
}

describe("toolchain contract", () => {
  test("BunとTauri CLIの期待版を単一JSONにexactで保持する", () => {
    const versions = JSON.parse(readFileSync(path.join(REPO_ROOT, "toolchain.json"), "utf8"));
    expect(versions).toEqual({ bun: "1.3.14", tauriCli: "2.11.4", cargoAudit: "0.22.2" });
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

  test("cargo-audit版違いはexpected/actualを表示して失敗する", () => {
    const result = run(CHECK_SCRIPT, ["audit"], makeFakeTools({ cargoAudit: "0.22.1" }));
    expect(result.exitCode).not.toBe(0);
    expect(output(result)).toContain("expected=0.22.2");
    expect(output(result)).toContain("actual=0.22.1");
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

  test("setup/daemon/sidecarと共通verifyがfrozen install helperを使う", () => {
    for (const relative of [
      "scripts/setup.sh",
      "scripts/install-daemon.sh",
      "desktop/build-sidecar.sh",
      "scripts/verify.sh",
    ]) {
      const text = readFileSync(path.join(REPO_ROOT, relative), "utf8");
      expect(text, relative).toContain("install-bun-deps.sh");
      expect(text, relative).not.toMatch(/bun install(?! --frozen-lockfile)/);
    }
  });

  test("LaunchAgent wrapperはログインシェル配下でserver本体を実行せず、PATH取得をtimeoutしてkillする", () => {
    const text = readFileSync(path.join(REPO_ROOT, "scripts", "daemon-server.sh"), "utf8");
    expect(text).not.toContain("exec /bin/zsh -lc");
    expect(text).toContain("LOGIN_SHELL_PATH_TIMEOUT");
    expect(text).toContain("kill -KILL");
    expect(text).toContain("exec \"$BUN_BIN\" server/index.ts");
  });

  test("LaunchAgent wrapperはログインシェルのPATHだけを使いserverを直接execする", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "solo-daemon-path-"));
    tempDirs.push(dir);
    const capturedBin = path.join(dir, "captured-bin");
    mkdirSync(capturedBin);
    const fakeShell = path.join(dir, "fake-zsh");
    writeExecutable(path.join(capturedBin, "bun"), "#!/bin/sh\nprintf 'fake-bun:%s\\n' \"$*\"\n");
    writeExecutable(
      fakeShell,
      "#!/bin/sh\nprintf 'noise\\n<SOLO_EIKAIWA_PATH>%s</SOLO_EIKAIWA_PATH>' \"$FAKE_LOGIN_PATH\"\n",
    );

    const result = await runDaemonWithDeadline({
      PATH: "/usr/bin:/bin",
      HOME: dir,
      FAKE_LOGIN_PATH: `${capturedBin}:/usr/bin:/bin`,
      SOLO_EIKAIWA_LOGIN_SHELL_BIN: fakeShell,
    });

    expect(result.killedByTest).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fake-bun:server/index.ts");
    expect(result.stderr).not.toContain("timeout");
  });

  test("LaunchAgent wrapperはハングしたログインシェルをkillして既知のbunで継続する", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "solo-daemon-timeout-"));
    tempDirs.push(dir);
    const homeBin = path.join(dir, ".bun", "bin");
    mkdirSync(homeBin, { recursive: true });
    const fakeShell = path.join(dir, "hanging-zsh");
    writeExecutable(path.join(homeBin, "bun"), "#!/bin/sh\nprintf 'fallback-bun:%s\\n' \"$*\"\n");
    writeExecutable(fakeShell, "#!/bin/sh\nexec /bin/sleep 10\n");

    const result = await runDaemonWithDeadline({
      PATH: "/usr/bin:/bin",
      HOME: dir,
      SOLO_EIKAIWA_LOGIN_SHELL_BIN: fakeShell,
      SOLO_EIKAIWA_LOGIN_SHELL_PATH_TIMEOUT_ATTEMPTS: "2",
      SOLO_EIKAIWA_LOGIN_SHELL_PATH_POLL_INTERVAL: "0.01",
    });

    expect(result.killedByTest).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("fallback-bun:server/index.ts");
    expect(result.stderr).toContain("PATH取得がtimeout");
  });

  test("releaseは共通verify後にbuildし、その後にもcleanを強制する", () => {
    const text = readFileSync(path.join(REPO_ROOT, "scripts", "release-desktop.sh"), "utf8");
    const verify = text.indexOf('verify.sh" release');
    const build = text.indexOf('build-sidecar.sh"');
    const finalClean = text.lastIndexOf("assert_clean_worktree");
    expect(verify).toBeGreaterThan(0);
    expect(build).toBeGreaterThan(verify);
    expect(finalClean).toBeGreaterThan(build);
  });
});
