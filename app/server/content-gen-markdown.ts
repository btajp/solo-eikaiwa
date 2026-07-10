import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseContentFile } from "./content";
import { parseListeningFile } from "./listening";

export type GeneratedContentCandidate = {
  id: string;
  kind: "topic" | "scenario";
  title: string;
  titleJa: string;
  domain: string;
  level: [number, number];
  hints: string[];
  starters?: string[];
  experienceAnchor?: string;
  memoryCue?: string;
  commonObjectsOrActions?: string[];
};

export type GeneratedListeningCandidate = {
  id: string;
  title: string;
  titleJa: string;
  domain: string;
  level: [number, number];
  paragraphs: string[];
};

export function contentToMarkdown(candidate: GeneratedContentCandidate): string {
  const heading = candidate.kind === "topic" ? "Talk about:" : "Roleplay setup:";
  return [
    "---",
    `id: ${candidate.id}`,
    `kind: ${candidate.kind}`,
    `title: "${candidate.title}"`,
    `title_ja: "${candidate.titleJa}"`,
    `domain: ${candidate.domain}`,
    `level: [${candidate.level[0]}, ${candidate.level[1]}]`,
    ...(candidate.experienceAnchor ? [`experience_anchor: "${candidate.experienceAnchor}"`] : []),
    ...(candidate.memoryCue ? [`memory_cue: "${candidate.memoryCue}"`] : []),
    ...(candidate.commonObjectsOrActions
      ? [`common_objects_or_actions: "${candidate.commonObjectsOrActions.join(", ")}"`]
      : []),
    "---",
    heading,
    ...candidate.hints.map((hint) => `- ${hint}`),
    ...(candidate.starters ? candidate.starters.map((starter) => `> ${starter}`) : []),
    "",
  ].join("\n");
}

export function listeningToMarkdown(candidate: GeneratedListeningCandidate): string {
  return [
    "---",
    `id: ${candidate.id}`,
    `title: "${candidate.title}"`,
    `title_ja: "${candidate.titleJa}"`,
    `domain: ${candidate.domain}`,
    `level: [${candidate.level[0]}, ${candidate.level[1]}]`,
    "---",
    "",
    candidate.paragraphs.join("\n\n"),
    "",
  ].join("\n");
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function optionalArraysEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return arraysEqual(left, right);
}

function contentRoundTrips(candidate: GeneratedContentCandidate, markdown: string): boolean {
  const parsed = parseContentFile(markdown);
  return parsed !== null
    && parsed.id === candidate.id
    && parsed.kind === candidate.kind
    && parsed.title === candidate.title
    && parsed.titleJa === candidate.titleJa
    && parsed.domain === candidate.domain
    && parsed.level[0] === candidate.level[0]
    && parsed.level[1] === candidate.level[1]
    && arraysEqual(parsed.hints, candidate.hints)
    && arraysEqual(parsed.starters, candidate.starters ?? [])
    && parsed.experienceAnchor === candidate.experienceAnchor
    && parsed.memoryCue === candidate.memoryCue
    && optionalArraysEqual(parsed.commonObjectsOrActions, candidate.commonObjectsOrActions);
}

function listeningRoundTrips(candidate: GeneratedListeningCandidate, markdown: string): boolean {
  const parsed = parseListeningFile(markdown);
  return parsed !== null
    && parsed.id === candidate.id
    && parsed.title === candidate.title
    && parsed.titleJa === candidate.titleJa
    && parsed.domain === candidate.domain
    && parsed.level[0] === candidate.level[0]
    && parsed.level[1] === candidate.level[1]
    && arraysEqual(parsed.paragraphs, candidate.paragraphs);
}

function writePrepared(entries: Array<{ file: string; markdown: string }>): string[] {
  const unique = new Set<string>();
  for (const entry of entries) {
    if (unique.has(entry.file) || existsSync(entry.file)) {
      throw new Error(`エラー: ${entry.file} は既に存在します。中止します。`);
    }
    unique.add(entry.file);
  }

  const written: string[] = [];
  try {
    for (const entry of entries) {
      written.push(entry.file);
      writeFileSync(entry.file, entry.markdown);
    }
    return written;
  } catch (error) {
    for (const file of written) rmSync(file, { force: true });
    throw error;
  }
}

/** 全候補をserialize→parseして完全一致した場合だけ、一括書き込みする。 */
export function writeContentCandidates(
  candidates: readonly GeneratedContentCandidate[],
  directoryFor: (candidate: GeneratedContentCandidate) => string,
): string[] {
  const entries = candidates.map((candidate) => {
    const markdown = contentToMarkdown(candidate);
    if (!contentRoundTrips(candidate, markdown)) {
      throw new Error(`エラー: ${candidate.id} のMarkdownラウンドトリップ検証に失敗しました。何も書き込みません。`);
    }
    return { file: path.join(directoryFor(candidate), `${candidate.id}.md`), markdown };
  });
  return writePrepared(entries);
}

/** listening候補をserialize→parseして完全一致した場合だけ、一括書き込みする。 */
export function writeListeningCandidates(
  candidates: readonly GeneratedListeningCandidate[],
  directory: string,
): string[] {
  const entries = candidates.map((candidate) => {
    const markdown = listeningToMarkdown(candidate);
    if (!listeningRoundTrips(candidate, markdown)) {
      throw new Error(`エラー: ${candidate.id} のMarkdownラウンドトリップ検証に失敗しました。何も書き込みません。`);
    }
    return { file: path.join(directory, `${candidate.id}.md`), markdown };
  });
  return writePrepared(entries);
}
