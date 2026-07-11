import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildSpdxDocument,
  hashTree,
  parseBunLock,
  parseCargoLock,
} from "../desktop-provenance";

test("Bun lock の trailing comma を含む package integrity を読む", () => {
  const packages = parseBunLock(`{
    "packages": {
      "@scope/example": ["@scope/example@1.2.3", "", {}, "sha512-YWJj"],
    },
  }`);
  expect(packages).toEqual([{
    name: "@scope/example",
    version: "1.2.3",
    integrity: "sha512-YWJj",
  }]);
});

test("Cargo.lock から source と checksum を含む package を読む", () => {
  const packages = parseCargoLock(`version = 3

[[package]]
name = "example"
version = "2.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc123"
`);
  expect(packages).toEqual([{
    name: "example",
    version: "2.0.0",
    source: "registry+https://github.com/rust-lang/crates.io-index",
    checksum: "abc123",
  }]);
});

test("tree hash はファイル作成順に依存しない", () => {
  const root = mkdtempSync("/private/tmp/solo-provenance-test-");
  try {
    writeFileSync(join(root, "b.txt"), "b");
    writeFileSync(join(root, "a.txt"), "a");
    const first = hashTree(root);
    const second = hashTree(root);
    expect(first).toEqual(second);
    expect(first.files).toBe(2);
    expect(first.bytes).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SPDX は Bun、Cargo、native、content と artifact を product に関連付ける", () => {
  const document = buildSpdxDocument({
    sourceDateEpoch: 1_781_842_357,
    namespaceSeed: "fixture",
    components: [
      { ecosystem: "bun", name: "react", version: "18.3.0", license: "MIT", declaredLicense: "MIT", licenseTexts: [] },
      { ecosystem: "cargo", name: "tauri", version: "2.11.5", license: "MIT OR Apache-2.0", declaredLicense: "MIT OR Apache-2.0", licenseTexts: [] },
      { ecosystem: "native", name: "whisper.cpp", version: "1.9.1", license: "MIT", declaredLicense: "MIT", licenseTexts: [] },
      { ecosystem: "asset", name: "solo-eikaiwa-content", version: "1", license: "MIT", declaredLicense: "MIT", licenseTexts: [] },
      { ecosystem: "toolchain", name: "bun", version: "1.3.14", license: "MIT", declaredLicense: "MIT", licenseTexts: [] },
      { ecosystem: "toolchain", name: "rust", version: "1.96.0", license: "MIT OR Apache-2.0", declaredLicense: "MIT OR Apache-2.0", licenseTexts: [] },
    ],
    artifacts: [{ path: "whisper-bin/whisper-cli", sha256: "a".repeat(64), bytes: 123 }],
  });
  const packages = document.packages as Array<{ name: string }>;
  expect(packages.map((pkg) => pkg.name)).toEqual([
    "solo-eikaiwa-desktop",
    "solo-eikaiwa-content",
    "react",
    "tauri",
    "whisper.cpp",
    "bun",
    "rust",
  ]);
  const relationships = document.relationships as Array<{ relationshipType: string }>;
  expect(relationships.filter((relationship) => relationship.relationshipType === "CONTAINS")).toHaveLength(7);
});

test("Tauri bundle は配布provenanceをResourcesへ配置する", () => {
  const config = JSON.parse(readFileSync(resolve(import.meta.dir, "..", "..", "desktop", "src-tauri", "tauri.conf.json"), "utf8")) as {
    bundle: { resources: Record<string, string> };
  };
  expect(config.bundle.resources["resources/provenance"]).toBe("provenance");
});

test("native build は cache の source hash 不一致で build 前に停止する", () => {
  const root = mkdtempSync("/private/tmp/solo-native-lock-test-");
  try {
    const sourceHash = "a".repeat(64);
    const cache = join(root, "cache");
    const bin = join(root, "bin");
    const lock = join(root, "native-deps.lock.json");
    mkdirSync(cache);
    mkdirSync(bin);
    writeFileSync(join(cache, `${sourceHash}.tar.gz`), "tampered archive");
    writeFileSync(join(bin, "cmake"), "#!/bin/sh\necho 'cmake version 4.0.0'\n");
    chmodSync(join(bin, "cmake"), 0o755);
    writeFileSync(lock, JSON.stringify({
      schemaVersion: 1,
      target: { os: "darwin", arch: "arm64", triple: "aarch64-apple-darwin", deploymentTarget: "13.3" },
      sourceDateEpoch: 1_781_842_357,
      components: [{
        name: "whisper.cpp",
        version: "1.9.1",
        commit: "f049fff95a089aa9969deb009cdd4892b3e74916",
        url: "https://example.test/f049fff95a089aa9969deb009cdd4892b3e74916/whisper.tar.gz",
        sha256: sourceHash,
        license: "MIT",
        licensePath: "LICENSE",
      }],
      build: { cmakeMinimumVersion: "3.25.0", cmakeArgs: ["-DCMAKE_BUILD_TYPE=Release"] },
    }));
    const result = Bun.spawnSync({
      cmd: ["bash", resolve(import.meta.dir, "..", "build-native-whisper.sh"), "--lock", lock, "--output", join(root, "output")],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        SOLO_EIKAIWA_NATIVE_CACHE_DIR: cache,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(result.stderr)).toContain("SHA-256 が lock と一致しません");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release署名後のnative manifestは配布用whisper-cliのhashへ更新される", () => {
  const root = mkdtempSync("/private/tmp/solo-native-manifest-test-");
  try {
    const output = join(root, "whisper-bin");
    const lock = resolve(import.meta.dir, "..", "..", "desktop", "native-deps.lock.json");
    const binary = "signed whisper binary\n";
    mkdirSync(output);
    writeFileSync(join(output, "whisper-cli"), binary);
    writeFileSync(join(output, "native-dependencies.json"), JSON.stringify({
      schemaVersion: 1,
      lockSha256: createHash("sha256").update(readFileSync(lock)).digest("hex"),
      artifacts: [{ path: "whisper-cli", sha256: "0".repeat(64), bytes: 0 }],
    }));
    const result = Bun.spawnSync({
      cmd: [
        "bash",
        resolve(import.meta.dir, "..", "refresh-native-manifest.sh"),
        "--lock", lock,
        "--output", output,
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(readFileSync(join(output, "native-dependencies.json"), "utf8"));
    expect(manifest.artifacts).toEqual([{
      path: "whisper-cli",
      sha256: createHash("sha256").update(binary).digest("hex"),
      bytes: Buffer.byteLength(binary),
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("release provenance は .app 内のSBOMと監査結果をchecksum付きで出力する", () => {
  const root = mkdtempSync("/private/tmp/solo-release-provenance-test-");
  try {
    const app = join(root, "solo-eikaiwa.app");
    const resources = join(app, "Contents", "Resources");
    const provenance = join(resources, "provenance");
    const bin = join(root, "bin");
    mkdirSync(join(provenance, "licenses"), { recursive: true });
    mkdirSync(join(resources, "whisper-bin", "licenses"), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(provenance, "sbom.spdx.json"), JSON.stringify({
      packages: ["bun", "rust", "whisper.cpp", "solo-eikaiwa-content"].map((name) => ({ name })),
    }));
    writeFileSync(join(provenance, "THIRD_PARTY_NOTICES.md"), "notice\n");
    writeFileSync(join(provenance, "licenses", "MIT.txt"), "license\n");
    const nativeBinary = "cli\n";
    writeFileSync(join(resources, "whisper-bin", "whisper-cli"), nativeBinary);
    writeFileSync(join(resources, "whisper-bin", "licenses", "whisper.cpp-MIT.txt"), "native license\n");
    writeFileSync(join(resources, "whisper-bin", "native-dependencies.json"), JSON.stringify({
      lockSha256: createHash("sha256").update(readFileSync(resolve(import.meta.dir, "..", "..", "desktop", "native-deps.lock.json")).toString()).digest("hex"),
      artifacts: [{
        path: "whisper-cli",
        sha256: createHash("sha256").update(nativeBinary).digest("hex"),
      }],
    }));
    writeFileSync(join(root, "release.dmg"), "dmg\n");
    writeFileSync(join(root, "update.tar.gz"), "archive\n");
    writeFileSync(join(root, "update.tar.gz.sig"), "signature\n");
    writeFileSync(join(root, "latest.json"), "{}\n");
    writeFileSync(join(bin, "cargo"), "#!/bin/sh\n[ \"$1\" = audit ] && exit 0\nexit 1\n");
    chmodSync(join(bin, "cargo"), 0o755);

    const result = Bun.spawnSync({
      cmd: [
        "bash",
        resolve(import.meta.dir, "..", "create-release-provenance.sh"),
        "--version", "0.29.0",
        "--bundle-dir", root,
        "--app", app,
        "--dmg", join(root, "release.dmg"),
        "--tarball", join(root, "update.tar.gz"),
        "--signature", join(root, "update.tar.gz.sig"),
        "--latest-json", join(root, "latest.json"),
      ],
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    const output = join(root, "provenance");
    const checksumPath = join(output, "solo-eikaiwa-0.29.0.checksums.txt");
    const provenancePath = join(output, "solo-eikaiwa-0.29.0.provenance.json");
    expect(existsSync(checksumPath)).toBe(true);
    expect(existsSync(provenancePath)).toBe(true);
    expect(readFileSync(checksumPath, "utf8").trim().split("\n")).toHaveLength(11);
    expect(JSON.parse(readFileSync(provenancePath, "utf8")).assets).toHaveLength(11);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
