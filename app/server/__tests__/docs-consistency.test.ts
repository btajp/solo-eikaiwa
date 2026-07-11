import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const readRepoFile = (...parts: string[]) => readFileSync(path.join(repoRoot, ...parts), "utf8");

describe("公開ドキュメントの実装同期", () => {
  test("暗記例文数を教材JSON・README・LPで揃える", () => {
    const sentences = JSON.parse(readRepoFile("content", "sentences", "sentences300.json")) as unknown[];
    const sentenceCount = sentences.length;
    const readme = readRepoFile("README.md");
    const landingPage = readRepoFile("site", "index.html");

    expect(sentenceCount).toBeGreaterThan(0);
    expect(readme).toContain(`暗記例文${sentenceCount}`);
    expect(landingPage).toContain(`暗記例文${sentenceCount}`);
    expect(landingPage).toContain(`${sentenceCount}文`);
  });

  test("配布・ソース更新・キー保存の案内を実装と揃える", () => {
    const readme = readRepoFile("README.md");
    const landingPage = readRepoFile("site", "index.html");

    expect(readme).toContain("日常のコード更新では再実行しません");
    expect(readme).toContain("./scripts/install-bun-deps.sh all");
    expect(readme).toContain("launchctl kickstart -k gui/$(id -u)/com.local.solo-eikaiwa.server");
    expect(readme).toContain("Keychain が優先");
    expect(readme).not.toContain("secretsは`app/.env`だけに置く");
    expect(landingPage).toContain("https://github.com/btajp/solo-eikaiwa/releases");
    expect(landingPage).toContain("v0.29.0以降は、起動時の案内から更新を適用できます");
  });
});
