import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LISTENING_DIR } from "./paths";
import { parseFrontmatter, parseDomain, parseLevelRange, type Domain } from "./content";

/** 多聴素材1本。本文は散文スクリプトを段落（空行区切り）に分割して持つ（TTS は段落単位で逐次再生するため）。 */
export type ListeningItem = {
  id: string;
  title: string;
  titleJa: string;
  domain: Domain;
  level: [number, number];
  paragraphs: string[];
};

/**
 * listening/*.md をパースする。frontmatter は content と共有ヘルパ、本文は散文の段落分割（箇条書きではない）。
 * id・title が無い、または段落が1つも取れないファイルは null（loadListening で除外される）。
 */
export function parseListeningFile(text: string): ListeningItem | null {
  const fm = parseFrontmatter(text);
  if (!fm) return null;
  const { fields, body } = fm;
  if (!fields.id || !fields.title) return null;
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return null;
  return {
    id: fields.id, title: fields.title, titleJa: fields.title_ja ?? "",
    domain: parseDomain(fields.domain), level: parseLevelRange(fields.level), paragraphs,
  };
}

export function loadListening(dir: string): ListeningItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => parseListeningFile(readFileSync(path.join(dir, f), "utf8")))
    .filter((c): c is ListeningItem => c !== null);
}

/** listeningId → 素材定義（未知は undefined）。routes の配線クロージャから使う。 */
export function findListening(id: string): ListeningItem | undefined {
  return loadListening(LISTENING_DIR).find((it) => it.id === id);
}
