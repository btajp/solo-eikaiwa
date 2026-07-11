import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

type BunLockPackage = {
  name: string;
  version: string;
  integrity?: string;
};

type CargoLockPackage = {
  name: string;
  version: string;
  source?: string;
  checksum?: string;
};

type LicenseText = {
  sourceName: string;
  content: string;
};

type Component = {
  ecosystem: "bun" | "cargo" | "native" | "asset" | "toolchain";
  name: string;
  version: string;
  license: string;
  declaredLicense: string;
  source?: string;
  checksum?: { algorithm: "SHA256" | "SHA512"; value: string };
  licenseTexts: LicenseText[];
};

type Artifact = {
  path: string;
  sha256: string;
  bytes: number;
};

type NativeLock = {
  schemaVersion: number;
  sourceDateEpoch: number;
  components: Array<{
    name: string;
    version: string;
    commit: string;
    url: string;
    sha256: string;
    license: string;
  }>;
};

type NativeManifest = {
  lockSha256: string;
  source: {
    name: string;
    version: string;
    commit: string;
    url: string;
    sha256: string;
    license: string;
  };
  artifacts: Array<{ path: string; sha256: string; bytes: number }>;
};

type CargoMetadataPackage = {
  name: string;
  version: string;
  license?: string | null;
  license_file?: string | null;
  manifest_path: string;
  repository?: string | null;
};

type CargoMetadata = { packages: CargoMetadataPackage[] };

type Toolchain = {
  bun: string;
  tauriCli: string;
  cargoAudit: string;
};

const textDecoder = new TextDecoder();

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function sha512IntegrityToHex(value: string | undefined): string | undefined {
  if (!value?.startsWith("sha512-")) return undefined;
  return Buffer.from(value.slice("sha512-".length), "base64").toString("hex");
}

function stableId(...parts: string[]): string {
  return sha256(parts.join("\u0000")).slice(0, 24);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function parseJsonc(text: string): unknown {
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
}

function parseLockIdentity(value: string): { name: string; version: string } {
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) {
    return { name: value, version: "NOASSERTION" };
  }
  return { name: value.slice(0, at), version: value.slice(at + 1) };
}

export function parseBunLock(text: string): BunLockPackage[] {
  const parsed = parseJsonc(text) as { packages?: Record<string, unknown> };
  const packages = parsed.packages ?? {};
  return Object.entries(packages)
    .map(([key, entry]) => {
      const tuple = Array.isArray(entry) ? entry : [];
      const identity = typeof tuple[0] === "string" ? tuple[0] : key;
      const integrity = [...tuple]
        .reverse()
        .find((item): item is string => typeof item === "string" && item.startsWith("sha512-"));
      return { ...parseLockIdentity(identity), integrity };
    })
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

function tomlValue(block: string, key: string): string | undefined {
  const match = block.match(new RegExp(`^${key} = "([^"]+)"$`, "m"));
  return match?.[1];
}

export function parseCargoLock(text: string): CargoLockPackage[] {
  return text
    .split("[[package]]")
    .slice(1)
    .flatMap((block) => {
      const name = tomlValue(block, "name");
      const version = tomlValue(block, "version");
      if (!name || !version) return [];
      return [{
        name,
        version,
        source: tomlValue(block, "source"),
        checksum: tomlValue(block, "checksum"),
      }];
    })
    .sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
}

function listFiles(root: string, current = root): string[] {
  if (!existsSync(current)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }
  return files.sort();
}

export function hashTree(root: string): { sha256: string; bytes: number; files: number } {
  const digest = createHash("sha256");
  let bytes = 0;
  const files = listFiles(root);
  for (const file of files) {
    const path = join(root, file);
    const content = readFileSync(path);
    bytes += content.byteLength;
    digest.update(file.replaceAll("\\", "/"));
    digest.update("\u0000");
    digest.update(sha256(content));
    digest.update("\u0000");
    digest.update(String(content.byteLength));
    digest.update("\n");
  }
  return { sha256: digest.digest("hex"), bytes, files: files.length };
}

function licenseExpression(value: string | undefined | null): string {
  if (!value || /(?:unlicensed|see license|proprietary|unknown)/i.test(value)) {
    return "NOASSERTION";
  }
  const expression = value.trim();
  return /^[A-Za-z0-9.+\-() ]+$/.test(expression) ? expression : "NOASSERTION";
}

function licenseFiles(directory: string): LicenseText[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(?:LICENSE|COPYING|NOTICE)(?:[._-].*)?$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      sourceName: entry.name,
      content: readFileSync(join(directory, entry.name), "utf8"),
    }));
}

function requiredLicenseFiles(directory: string, names: string[]): LicenseText[] {
  return names.map((name) => {
    const path = join(directory, name);
    if (!existsSync(path)) throw new Error(`必要な第三者license textがありません: ${name}`);
    return { sourceName: name, content: readFileSync(path, "utf8") };
  });
}

function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync({ cmd: command, cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed: ${textDecoder.decode(result.stderr).trim()}`);
  }
  return textDecoder.decode(result.stdout);
}

function cargoMetadata(repoDir: string): Map<string, CargoMetadataPackage> {
  const cargoDir = join(repoDir, "desktop", "src-tauri");
  const metadata = JSON.parse(run(["cargo", "metadata", "--locked", "--format-version", "1"], cargoDir)) as CargoMetadata;
  return new Map(metadata.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
}

function rustVersion(repoDir: string): string {
  const match = run(["rustc", "-Vv"], repoDir).match(/^release:\s*(.+)$/m);
  if (!match?.[1]) throw new Error("rustc の version を判定できません");
  return match[1].trim();
}

function nodePackageMetadata(nodeModules: string): Map<string, { license?: string; repository?: string; licenseTexts: LicenseText[] }> {
  if (!existsSync(nodeModules)) return new Map();
  const result = Bun.spawnSync({
    cmd: ["find", "-L", nodeModules, "-type", "f", "-name", "package.json"],
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`node_modules scan failed: ${textDecoder.decode(result.stderr).trim()}`);
  }
  const metadata = new Map<string, { license?: string; repository?: string; licenseTexts: LicenseText[] }>();
  for (const manifestPath of textDecoder.decode(result.stdout).split("\n").filter(Boolean).sort()) {
    try {
      const manifest = readJson<{ name?: string; version?: string; license?: string; repository?: string | { url?: string } }>(manifestPath);
      if (!manifest.name || !manifest.version) continue;
      const key = `${manifest.name}@${manifest.version}`;
      const current = metadata.get(key);
      const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
      const texts = licenseFiles(dirname(manifestPath));
      metadata.set(key, {
        license: current?.license ?? manifest.license,
        repository: current?.repository ?? repository,
        licenseTexts: [...(current?.licenseTexts ?? []), ...texts],
      });
    } catch {
      // 壊れた依存 metadata は SBOM の NOASSERTION として残し、ビルドを停止させない。
    }
  }
  return metadata;
}

function uniqueTexts(texts: LicenseText[]): LicenseText[] {
  const seen = new Set<string>();
  return texts.filter((text) => {
    const key = `${text.sourceName}\u0000${sha256(text.content)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeComponents(components: Component[]): Component[] {
  const unique = new Map<string, Component>();
  for (const component of components) {
    const key = [component.ecosystem, component.name, component.version, component.checksum?.value ?? ""].join("\u0000");
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, { ...component, licenseTexts: uniqueTexts(component.licenseTexts) });
      continue;
    }
    existing.licenseTexts = uniqueTexts([...existing.licenseTexts, ...component.licenseTexts]);
    existing.source ??= component.source;
    if (existing.declaredLicense === "NOASSERTION") {
      existing.declaredLicense = component.declaredLicense;
      existing.license = component.license;
    }
  }
  return [...unique.values()];
}

function componentId(component: Component): string {
  return `SPDXRef-${component.ecosystem}-${stableId(component.ecosystem, component.name, component.version, component.checksum?.value ?? "")}`;
}

function packagePurl(component: Component): string | undefined {
  if (component.ecosystem === "bun") {
    const name = component.name.startsWith("@")
      ? `%40${component.name.slice(1)}`
      : component.name;
    return `pkg:npm/${name}@${encodeURIComponent(component.version)}`;
  }
  if (component.ecosystem === "cargo") return `pkg:cargo/${encodeURIComponent(component.name)}@${component.version}`;
  return undefined;
}

function SPDXPackage(component: Component): Record<string, unknown> {
  const purl = packagePurl(component);
  return {
    SPDXID: componentId(component),
    name: component.name,
    versionInfo: component.version,
    downloadLocation: component.source ?? "NOASSERTION",
    filesAnalyzed: false,
    licenseConcluded: component.license,
    licenseDeclared: component.license,
    ...(component.checksum ? { checksums: [{ algorithm: component.checksum.algorithm, checksumValue: component.checksum.value }] } : {}),
    ...(purl ? {
      externalRefs: [{
        referenceCategory: "PACKAGE-MANAGER",
        referenceType: "purl",
        referenceLocator: purl,
      }],
    } : {}),
    ...(component.declaredLicense !== component.license ? { comment: `Declared license: ${component.declaredLicense}` } : {}),
  };
}

function SPDXFile(artifact: Artifact): Record<string, unknown> {
  const id = `SPDXRef-File-${stableId(artifact.path, artifact.sha256)}`;
  const fileType = /(?:\.lock|\.json)$/i.test(artifact.path) ? "TEXT" : "BINARY";
  return {
    SPDXID: id,
    fileName: `./${artifact.path}`,
    checksums: [{ algorithm: "SHA256", checksumValue: artifact.sha256 }],
    fileTypes: [fileType],
    licenseConcluded: "NOASSERTION",
    copyrightText: "NOASSERTION",
    comment: `bytes=${artifact.bytes}`,
  };
}

export function buildSpdxDocument(options: {
  sourceDateEpoch: number;
  namespaceSeed: string;
  components: Component[];
  artifacts: Artifact[];
}): Record<string, unknown> {
  const components = [...options.components].sort((a, b) => {
    const left = `${a.ecosystem}:${a.name}@${a.version}`;
    const right = `${b.ecosystem}:${b.name}@${b.version}`;
    return left.localeCompare(right);
  });
  const artifacts = [...options.artifacts].sort((a, b) => a.path.localeCompare(b.path));
  const productId = "SPDXRef-Package-solo-eikaiwa-desktop";
  const files = artifacts.map(SPDXFile);
  const relationships: Array<Record<string, string>> = [
    { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: productId },
  ];
  for (const component of components) {
    relationships.push({ spdxElementId: productId, relationshipType: "CONTAINS", relatedSpdxElement: componentId(component) });
  }
  for (const file of files) {
    relationships.push({ spdxElementId: productId, relationshipType: "CONTAINS", relatedSpdxElement: String(file.SPDXID) });
  }
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: "solo-eikaiwa-desktop-sbom",
    documentNamespace: `https://github.com/btajp/solo-eikaiwa/spdx/${options.namespaceSeed}`,
    creationInfo: {
      created: new Date(options.sourceDateEpoch * 1000).toISOString(),
      creators: ["Tool: solo-eikaiwa desktop provenance generator"],
    },
    packages: [
      {
        SPDXID: productId,
        name: "solo-eikaiwa-desktop",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "MIT",
        licenseDeclared: "MIT",
      },
      ...components.map(SPDXPackage),
    ],
    files,
    relationships,
  };
}

function renderNotices(components: Component[], licensePaths: Map<string, string>): string {
  const rows = [...components]
    .sort((a, b) => `${a.ecosystem}:${a.name}@${a.version}`.localeCompare(`${b.ecosystem}:${b.name}@${b.version}`))
    .map((component) => {
      const textHashes = uniqueTexts(component.licenseTexts)
        .map((text) => licensePaths.get(sha256(text.content)))
        .filter((path): path is string => Boolean(path));
      const texts = textHashes.length ? textHashes.join(", ") : "同梱テキストなし（宣言をSBOMで確認）";
      return `| ${component.ecosystem} | ${component.name} | ${component.version} | ${component.declaredLicense || "NOASSERTION"} | ${texts} |`;
    });
  return [
    "# Third-Party Notices",
    "",
    "このディレクトリはデスクトップ配布物に含まれる依存の宣言と、収集できた license/notice text を記録します。",
    "`NOASSERTION` は依存 metadata に SPDX として使える宣言が無かったことを示します。",
    "",
    "| 種別 | 名前 | 版 | 宣言ライセンス | 同梱テキスト |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

function writeLicenses(outputDir: string, components: Component[]): Map<string, string> {
  const licensesDir = join(outputDir, "licenses");
  mkdirSync(licensesDir, { recursive: true });
  const all = components.flatMap((component) => uniqueTexts(component.licenseTexts));
  const unique = new Map<string, LicenseText>();
  for (const text of all) unique.set(sha256(text.content), text);
  const paths = new Map<string, string>();
  for (const [hash, text] of [...unique.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const path = `licenses/${hash}.txt`;
    writeFileSync(join(outputDir, path), text.content);
    paths.set(hash, path);
  }
  return paths;
}

function artifact(path: string, root: string): Artifact {
  const absolute = join(root, path);
  const content = readFileSync(absolute);
  return { path, sha256: sha256(content), bytes: content.byteLength };
}

function artifactAt(path: string, absolute: string): Artifact {
  const content = readFileSync(absolute);
  return { path, sha256: sha256(content), bytes: content.byteLength };
}

export function generateDesktopProvenance(repoDir: string, resourcesDir: string, outputDir: string): {
  sbomPath: string;
  noticePath: string;
  components: number;
} {
  const nativeLockPath = join(repoDir, "desktop", "native-deps.lock.json");
  const nativeManifestPath = join(resourcesDir, "whisper-bin", "native-dependencies.json");
  const nativeLock = readJson<NativeLock>(nativeLockPath);
  const nativeManifest = readJson<NativeManifest>(nativeManifestPath);
  const lockedNative = nativeLock.components[0];
  const toolchain = readJson<Toolchain>(join(repoDir, "toolchain.json"));
  const actualBun = run(["bun", "--version"], repoDir).trim();
  if (actualBun !== toolchain.bun) {
    throw new Error(`Bun version が toolchain.json と一致しません: expected=${toolchain.bun} actual=${actualBun}`);
  }
  if (
    nativeLock.schemaVersion !== 1
    || !lockedNative
    || nativeManifest.source.name !== lockedNative.name
    || nativeManifest.source.version !== lockedNative.version
    || nativeManifest.source.commit !== lockedNative.commit
    || nativeManifest.source.url !== lockedNative.url
    || nativeManifest.source.sha256 !== lockedNative.sha256
    || nativeManifest.source.license !== lockedNative.license
    || nativeManifest.lockSha256 !== sha256(readFileSync(nativeLockPath))
  ) {
    throw new Error("native lock と manifest の source が一致しません");
  }

  const bunLocks = [
    join(repoDir, "app", "bun.lock"),
    join(repoDir, "app", "client", "bun.lock"),
  ];
  const nodeMetadata = new Map<string, { license?: string; repository?: string; licenseTexts: LicenseText[] }>();
  for (const directory of [join(repoDir, "app", "node_modules"), join(repoDir, "app", "client", "node_modules")]) {
    for (const [key, value] of nodePackageMetadata(directory)) {
      const existing = nodeMetadata.get(key);
      nodeMetadata.set(key, {
        license: existing?.license ?? value.license,
        repository: existing?.repository ?? value.repository,
        licenseTexts: [...(existing?.licenseTexts ?? []), ...value.licenseTexts],
      });
    }
  }
  const bunComponents = bunLocks
    .flatMap((path) => parseBunLock(readFileSync(path, "utf8")))
    .map((pkg): Component => {
      const metadata = nodeMetadata.get(`${pkg.name}@${pkg.version}`);
      const declaredLicense = metadata?.license ?? "NOASSERTION";
      const integrity = sha512IntegrityToHex(pkg.integrity);
      return {
        ecosystem: "bun",
        name: pkg.name,
        version: pkg.version,
        license: licenseExpression(declaredLicense),
        declaredLicense,
        source: metadata?.repository,
        ...(integrity ? { checksum: { algorithm: "SHA512" as const, value: integrity } } : {}),
        licenseTexts: uniqueTexts(metadata?.licenseTexts ?? []),
      };
    });

  const cargoMetadataByPackage = cargoMetadata(repoDir);
  const cargoLockPath = join(repoDir, "desktop", "src-tauri", "Cargo.lock");
  const cargoComponents = parseCargoLock(readFileSync(cargoLockPath, "utf8")).map((pkg): Component => {
    const metadata = cargoMetadataByPackage.get(`${pkg.name}@${pkg.version}`);
    const packageDir = metadata ? dirname(metadata.manifest_path) : "";
    const declaredLicense = metadata?.license ?? (pkg.name === "app" ? "MIT" : "NOASSERTION");
    const configuredLicense = metadata?.license_file && existsSync(metadata.license_file)
      ? [{ sourceName: basename(metadata.license_file), content: readFileSync(metadata.license_file, "utf8") }]
      : licenseFiles(packageDir);
    return {
      ecosystem: "cargo",
      name: pkg.name,
      version: pkg.version,
      license: licenseExpression(declaredLicense),
      declaredLicense,
      source: metadata?.repository ?? pkg.source,
      ...(pkg.checksum ? { checksum: { algorithm: "SHA256" as const, value: pkg.checksum } } : {}),
      licenseTexts: uniqueTexts(configuredLicense),
    };
  });

  const nativeComponent: Component = {
    ecosystem: "native",
    name: nativeManifest.source.name,
    version: nativeManifest.source.version,
    license: licenseExpression(nativeManifest.source.license),
    declaredLicense: nativeManifest.source.license,
    source: nativeManifest.source.url,
    checksum: { algorithm: "SHA256", value: nativeManifest.source.sha256 },
    licenseTexts: requiredLicenseFiles(join(resourcesDir, "whisper-bin", "licenses"), ["whisper.cpp-MIT.txt"]),
  };
  const contentTree = hashTree(join(resourcesDir, "content"));
  const assetComponent: Component = {
    ecosystem: "asset",
    name: "solo-eikaiwa-content",
    version: nativeLock.sourceDateEpoch.toString(),
    license: "MIT",
    declaredLicense: "MIT",
    checksum: { algorithm: "SHA256", value: contentTree.sha256 },
    licenseTexts: [{ sourceName: "solo-eikaiwa-MIT.txt", content: readFileSync(join(repoDir, "LICENSE"), "utf8") }],
  };
  const toolchainComponents: Component[] = [
    {
      ecosystem: "toolchain",
      name: "bun",
      version: toolchain.bun,
      license: "MIT",
      declaredLicense: "MIT",
      source: "https://github.com/oven-sh/bun",
      licenseTexts: requiredLicenseFiles(join(repoDir, "desktop", "third-party-licenses"), ["bun-LICENSE.md"]),
    },
    {
      ecosystem: "toolchain",
      name: "rust",
      version: rustVersion(repoDir),
      license: "MIT OR Apache-2.0",
      declaredLicense: "MIT OR Apache-2.0",
      source: "https://github.com/rust-lang/rust",
      licenseTexts: requiredLicenseFiles(join(repoDir, "desktop", "third-party-licenses"), [
        "rust-LICENSE-MIT.txt",
        "rust-LICENSE-APACHE.txt",
      ]),
    },
  ];
  const components = dedupeComponents([
    ...bunComponents,
    ...cargoComponents,
    nativeComponent,
    assetComponent,
    ...toolchainComponents,
  ]);
  const nativeBinary = artifact("whisper-bin/whisper-cli", resourcesDir);
  if (nativeBinary.sha256 !== nativeManifest.artifacts.find((item) => item.path === "whisper-cli")?.sha256) {
    throw new Error("native manifest と whisper-cli の SHA-256 が一致しません");
  }
  const artifacts = [
    artifact("app/bun.lock", repoDir),
    artifact("app/client/bun.lock", repoDir),
    artifact("desktop/src-tauri/Cargo.lock", repoDir),
    artifact("desktop/native-deps.lock.json", repoDir),
    artifact("toolchain.json", repoDir),
    nativeBinary,
    artifact("whisper-bin/native-dependencies.json", resourcesDir),
    artifactAt(
      "binaries/solo-server-aarch64-apple-darwin",
      join(repoDir, "desktop", "src-tauri", "binaries", "solo-server-aarch64-apple-darwin"),
    ),
  ];

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  const licensePaths = writeLicenses(outputDir, components);
  const sbom = buildSpdxDocument({
    sourceDateEpoch: nativeLock.sourceDateEpoch,
    namespaceSeed: `${nativeManifest.lockSha256}-${nativeManifest.artifacts[0]?.sha256 ?? "missing"}`,
    components,
    artifacts,
  });
  const sbomPath = join(outputDir, "sbom.spdx.json");
  const noticePath = join(outputDir, "THIRD_PARTY_NOTICES.md");
  writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);
  writeFileSync(noticePath, renderNotices(components, licensePaths));
  return { sbomPath, noticePath, components: components.length };
}

function usage(): never {
  console.error("使い方: bun scripts/desktop-provenance.ts [--repo <dir>] [--resources <dir>] [--output <dir>]");
  process.exit(2);
}

if (import.meta.main) {
  let repoDir = resolve(import.meta.dir, "..");
  let resourcesDir = join(repoDir, "desktop", "src-tauri", "resources");
  let outputDir = join(resourcesDir, "provenance");
  const args = process.argv.slice(2);
  while (args.length) {
    const argument = args.shift();
    const value = args.shift();
    if (argument === "--repo" && value) repoDir = resolve(value);
    else if (argument === "--resources" && value) resourcesDir = resolve(value);
    else if (argument === "--output" && value) outputDir = resolve(value);
    else usage();
  }
  const result = generateDesktopProvenance(repoDir, resourcesDir, outputDir);
  console.log(`OK: desktop provenance generated (${result.components} components)`);
}
