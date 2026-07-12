import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");
const AUDIT_SCRIPT = path.join(REPO_ROOT, "scripts", "audit-dependencies.sh");
const VERIFY_SCRIPT = path.join(REPO_ROOT, "scripts", "verify.sh");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeAuditTools() {
  const dir = mkdtempSync(path.join(tmpdir(), "solo-audit-tools-"));
  tempDirs.push(dir);
  writeFileSync(
    path.join(dir, "bun"),
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo 1.3.14; exit 0; fi\nif [ "$1" = "audit" ]; then exit "${FAKE_BUN_AUDIT_EXIT:-0}"; fi\nexit 2\n',
  );
  writeFileSync(
    path.join(dir, "cargo"),
    '#!/bin/sh\n[ "$1" = "audit" ] || exit 2\nshift\nif [ "$1" = "--version" ]; then echo "cargo-audit 0.22.2"; exit 0; fi\nstatus="${FAKE_CARGO_AUDIT_EXIT:-0}"\nif [ "$status" = "1" ]; then echo "{\\"vulnerabilities\\":{\\"found\\":true}}"; fi\nif [ "$status" = "2" ]; then echo "failed to fetch advisory database" >&2; fi\nexit "$status"\n',
  );
  chmodSync(path.join(dir, "bun"), 0o755);
  chmodSync(path.join(dir, "cargo"), 0o755);
  return dir;
}

function runAudit(env: Record<string, string> = {}) {
  const fakeBin = makeAuditTools();
  return Bun.spawnSync({
    cmd: ["/bin/bash", AUDIT_SCRIPT],
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function output(result: ReturnType<typeof Bun.spawnSync>) {
  return `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`;
}

describe("dependency audit status", () => {
  test("全監査が成功すれば0", () => {
    const result = runAudit();
    expect(result.exitCode).toBe(0);
  });

  test("Bunの脆弱性検出は専用code 10", () => {
    const result = runAudit({ FAKE_BUN_AUDIT_EXIT: "1" });
    expect(result.exitCode).toBe(10);
    expect(output(result)).toContain("AUDIT_VULNERABILITIES source=bun-app");
  });

  test("Bun監査の通信・tool障害は専用code 20", () => {
    const result = runAudit({ FAKE_BUN_AUDIT_EXIT: "2" });
    expect(result.exitCode).toBe(20);
    expect(output(result)).toContain("AUDIT_INFRA_FAILURE source=bun-app");
  });

  test("RustSec DB取得失敗は専用code 20", () => {
    const result = runAudit({ FAKE_CARGO_AUDIT_EXIT: "2" });
    expect(result.exitCode).toBe(20);
    expect(output(result)).toContain("AUDIT_INFRA_FAILURE source=cargo-db");
  });

  test("Cargoの脆弱性検出は専用code 10", () => {
    const result = runAudit({ FAKE_CARGO_AUDIT_EXIT: "1" });
    expect(result.exitCode).toBe(10);
    expect(output(result)).toContain("AUDIT_VULNERABILITIES source=cargo");
  });
});

describe("verification workflow contract", () => {
  test("verify scriptがpr/desktop/audit/releaseの正本を提供する", () => {
    const text = readFileSync(VERIFY_SCRIPT, "utf8");
    for (const mode of ["pr", "desktop", "audit", "release"]) expect(text).toContain(`${mode})`);
    expect(text).toContain("bun test");
    expect(text).toContain("bun run typecheck");
    expect(text).toContain("bun run build");
    expect(text).toContain("cargo test");
    expect(text).toContain("cargo clippy");
    expect(text).toContain("check-content-coverage.ts");
    expect(text).toContain("check-spoken-register.ts");
  });

  test("ShellCheckはTauriがtarget配下へ生成したscriptを対象にしない", () => {
    const text = readFileSync(VERIFY_SCRIPT, "utf8");
    expect(text).toContain("-name target -prune");
  });

  test("releaseは個別ゲートでなく共通release modeを呼ぶ", () => {
    const text = readFileSync(path.join(REPO_ROOT, "scripts", "release-desktop.sh"), "utf8");
    expect(text).toContain('verify.sh" release');
    expect(text).not.toContain("bun test && bun run typecheck");
  });

  test("releaseのDMG生成はFinder AppleScriptに依存しないCI経路を使う", () => {
    const text = readFileSync(path.join(REPO_ROOT, "scripts", "release-desktop.sh"), "utf8");
    expect(text).toContain("CI=true cargo tauri build");
  });

  test("PR workflowはread-only pull_requestでcore/desktopを実行する", () => {
    const text = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "verify.yml"), "utf8");
    expect(text).toContain("pull_request:");
    expect(text).not.toContain("pull_request_target:");
    expect(text).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(text).toContain("./scripts/verify.sh pr");
    expect(text).toContain("./scripts/verify.sh desktop");
  });

  test("依存監査workflowはscheduleと手動実行から共通audit modeを呼ぶ", () => {
    const text = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "audit.yml"), "utf8");
    expect(text).toContain("schedule:");
    expect(text).toContain("workflow_dispatch:");
    expect(text).toContain('cargo install cargo-audit --locked --version "${{ steps.toolchain.outputs.cargo_audit }}"');
    expect(text).toContain("./scripts/verify.sh audit");
  });

  test("全workflow actionをcommit SHAへ固定する", () => {
    const dir = path.join(REPO_ROOT, ".github", "workflows");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".yml"))) {
      const text = readFileSync(path.join(dir, file), "utf8");
      for (const match of text.matchAll(/uses:\s*[^@\s]+@([^\s#]+)/g)) {
        expect(match[1], `${file}: ${match[0]}`).toMatch(/^[0-9a-f]{40}$/);
      }
    }
  });
});
