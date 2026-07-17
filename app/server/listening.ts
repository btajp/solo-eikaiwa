import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { LISTENING_DIR } from "./paths";
import { parseFrontmatter, parseDomain, parseLevelRange, type Domain } from "./content";

/** 多聴素材の形式。既定は独話（#220 で2話者対話 "dialogue" を追加）。 */
export type ListeningFormat = "monologue" | "dialogue";

/** 対話素材の1発話（話者交替の単位）。text は話者ラベルを含まない発話本文。 */
export type ListeningTurn = { speaker: string; text: string };

/** 多聴素材1本。本文は散文スクリプトを段落（空行区切り）に分割して持つ（TTS は段落単位で逐次再生するため）。 */
export type ListeningItem = {
  id: string;
  title: string;
  titleJa: string;
  domain: Domain;
  level: [number, number];
  /** 生の段落（dialogue では「話者名: 発話」のラベル付き行 — talk-explain 等の既存経路がそのまま使う） */
  paragraphs: string[];
  format: ListeningFormat;
  /** dialogue のみ: ターンの初出順の話者名（monologue は []） */
  speakers: string[];
  /** dialogue のみ: 発話ターン（monologue は []） */
  turns: ListeningTurn[];
};

/**
 * 対話ターンのラベル行（例: "Ken: Hey, do you have a minute?"）。
 * 話者名は1語の大文字始まり（生成側 validateDialogueListeningCandidate が保証する形式）。
 * 発話本文に ":" が含まれても、先頭ラベルのみを話者として切り出す。
 */
const DIALOGUE_TURN_RE = /^([A-Z][A-Za-z]*):\s+(\S[\s\S]*)$/;

/** dialogue の発話ターンから、ラベル抜きの発話本文だけを空行区切りで結合する（TTS・語数/口語検証の単位）。 */
export function dialogueScriptText(turns: readonly ListeningTurn[]): string {
  return turns.map((t) => t.text).join("\n\n");
}

/**
 * listening/*.md をパースする。frontmatter は content と共有ヘルパ、本文は散文の段落分割（箇条書きではない）。
 * id・title が無い、または段落が1つも取れないファイルは null（loadListening で除外される）。
 * format: dialogue のファイルは全段落が「話者名: 発話」のラベル行であることを要求し、
 * ラベル無し段落の混入や話者1人だけの対話は壊れたファイルとして null にする（手修正禁止 — 再生成対象）。
 */
export function parseListeningFile(text: string): ListeningItem | null {
  const fm = parseFrontmatter(text);
  if (!fm) return null;
  const { fields, body } = fm;
  if (!fields.id || !fields.title) return null;
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return null;
  const base = {
    id: fields.id, title: fields.title, titleJa: fields.title_ja ?? "",
    domain: parseDomain(fields.domain), level: parseLevelRange(fields.level), paragraphs,
  };
  if (fields.format === "dialogue") {
    const turns: ListeningTurn[] = [];
    for (const p of paragraphs) {
      const m = p.match(DIALOGUE_TURN_RE);
      if (!m) return null;
      turns.push({ speaker: m[1], text: m[2].trim() });
    }
    const speakers = [...new Set(turns.map((t) => t.speaker))];
    if (speakers.length < 2) return null;
    return { ...base, format: "dialogue", speakers, turns };
  }
  return { ...base, format: "monologue", speakers: [], turns: [] };
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
