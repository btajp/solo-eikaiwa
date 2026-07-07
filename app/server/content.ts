import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { SCENARIOS_DIR, TOPICS_DIR } from "./paths";

export type Domain = "daily" | "business" | "it";
/** ドメインの巡回順（ラウンドロビンはこの順で次を探す） */
export const DOMAINS: readonly Domain[] = ["daily", "business", "it"];

export type ContentItem = {
  id: string; kind: "topic" | "scenario"; title: string; titleJa: string; hints: string[];
  starters: string[];
  domain: Domain; level: [number, number];
};

export function parseDomain(raw: string | undefined): Domain {
  if (raw === undefined) return "it";
  if ((DOMAINS as readonly string[]).includes(raw)) return raw as Domain;
  console.warn(`[content] invalid domain "${raw}", falling back to "it"`);
  return "it";
}

/** level: [min, max]（1..6, min<=max）。省略はデフォルト、不正は警告してデフォルト */
export function parseLevelRange(raw: string | undefined): [number, number] {
  if (raw === undefined) return [1, 6];
  const m = raw.match(/^\[\s*(\d+)\s*,\s*(\d+)\s*\]$/);
  if (m) {
    const min = Number(m[1]);
    const max = Number(m[2]);
    if (min >= 1 && max <= 6 && min <= max) return [min, max];
  }
  console.warn(`[content] invalid level "${raw}", falling back to [1, 6]`);
  return [1, 6];
}

/** frontmatter（先頭の `---\n ... \n---` ブロック）を key:value 辞書と本文に分解する。
 *  topic/scenario（parseContentFile）と listening（parseListeningFile）で共有する。frontmatter が無ければ null。 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } | null {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { fields, body: text.slice(m[0].length) };
}

export function parseContentFile(text: string): ContentItem | null {
  const fm = parseFrontmatter(text);
  if (!fm) return null;
  const { fields, body } = fm;
  if (!fields.id || !fields.title || (fields.kind !== "topic" && fields.kind !== "scenario")) return null;
  const hints = body.split("\n").filter((l) => l.trim().startsWith("- ")).map((l) => l.trim().slice(2));
  const starters = body.split("\n").filter((l) => l.trim().startsWith("> ")).map((l) => l.trim().slice(2).trim());
  return {
    id: fields.id, kind: fields.kind, title: fields.title, titleJa: fields.title_ja ?? "", hints, starters,
    domain: parseDomain(fields.domain), level: parseLevelRange(fields.level),
  };
}

export function loadContent(dir: string): ContentItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseContentFile(readFileSync(path.join(dir, f), "utf8")))
    .filter((c): c is ContentItem => c !== null);
}

/** topicId → トピック定義（未知は undefined）。index.ts の配線クロージャの重複検索を1箇所に集約 */
export function findTopic(id: string): ContentItem | undefined {
  return loadContent(TOPICS_DIR).find((t) => t.id === id);
}

/** scenarioId → シナリオ定義（未知は undefined） */
export function findScenario(id: string): ContentItem | undefined {
  return loadContent(SCENARIOS_DIR).find((s) => s.id === id);
}
