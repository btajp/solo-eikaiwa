import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROGRESS_DIR } from "./paths";

/** ユーザー設定。anchor は if-then 形式の1行（例:「朝コーヒーを淹れたら1ドリル」） */
export type Settings = { anchor: string };

const DEFAULT_SETTINGS: Settings = { anchor: "" };

function defaultFile(): string {
  return path.join(PROGRESS_DIR, "settings.json");
}

/** 存在しない・破損・不正形状はデフォルトにフォールバック（rotation.ts の readJsonSafe と同方針） */
export function readSettings(file: string = defaultFile()): Settings {
  if (!existsSync(file)) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Settings>;
    if (typeof parsed?.anchor === "string") return { anchor: parsed.anchor };
  } catch {
    console.warn(`[settings] failed to parse JSON, using defaults: ${file}`);
  }
  return { ...DEFAULT_SETTINGS };
}

export function writeSettings(s: Settings, file: string = defaultFile()): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
}
