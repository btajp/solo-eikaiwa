import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";
import type { AuthMode } from "./llm-auth-store";

/**
 * codex api-key モード専用の隔離 CODEX_HOME（gitignore済み data/ 配下）。
 * ユーザー本体の ~/.codex（ChatGPT ログイン）には一切触れない — 常にこのディレクトリのみを対象にする。
 */
export const CODEX_HOME_DIR = path.join(DATA_DIR, "codex-home");

/** `codex login --with-api-key` を1回実行する関数の型（テスト用 seam）。キーは stdin で渡す。 */
export type CodexLoginSpawn = (args: {
  env: Record<string, string | undefined>;
  stdin: string;
}) => Promise<void>;

/**
 * codex api-key モード用の隔離 CODEX_HOME に auth.json を用意する（冪等）。
 * 既に auth.json があれば何もせず dir をそのまま返す。無ければ CODEX_API_KEY（app/.env 由来）を
 * stdin で渡して `CODEX_HOME=<dir> codex login --with-api-key` を実行し、作成した dir を返す。
 * dir 引数はテスト用（既定 CODEX_HOME_DIR）— 実運用の呼び出し（route 経由）は常に引数省略で呼ぶ。
 */
export async function ensureCodexApiKeyHome(
  spawnFn: CodexLoginSpawn = realCodexLoginSpawn,
  dir: string = CODEX_HOME_DIR,
): Promise<string> {
  const authPath = path.join(dir, "auth.json");
  if (existsSync(authPath)) return dir;

  const apiKey = Bun.env.CODEX_API_KEY;
  if (!apiKey || !apiKey.trim()) {
    throw new Error("codex api key not configured in app/.env");
  }

  mkdirSync(dir, { recursive: true });
  await spawnFn({ env: { ...Bun.env, CODEX_HOME: dir }, stdin: apiKey });
  return dir;
}

/**
 * 実際の `codex login --with-api-key` 実行。キーは argv ではなく stdin から渡す
 * （realCodexExec/realClaudePrintExec と同じ流儀・プロセス一覧やログにキーを残さないため）。
 * プロセス起動に依存するため単体テスト対象外（ensureCodexApiKeyHome は注入した spawnFn フェイクで検証する）。
 */
export const realCodexLoginSpawn: CodexLoginSpawn = async ({ env, stdin }) => {
  const proc = Bun.spawn(["codex", "login", "--with-api-key"], {
    env,
    stdin: new TextEncoder().encode(stdin),
    stdout: "ignore",
    stderr: "pipe",
  });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`codex login --with-api-key failed (exit ${exitCode}): ${stderr.slice(-500)}`);
  }
};

/**
 * codex spawn（exec / app-server 共通）向けの env 上書きを組み立てる純関数。
 * subscription（既定）では undefined を返す＝現行どおり process.env をそのまま継承する（挙動不変の核）。
 * api-key のときだけ baseEnv を土台に CODEX_HOME（隔離ディレクトリ）を注入した env を返す
 * （standalone の codex app-server は env 単体では認証されず、CODEX_HOME 配下の auth.json を要求するため。
 * exec 側もここで揃え、両経路とも同一の隔離ホームを常に指す設計にする）。
 */
export function codexSpawnEnv(
  mode: AuthMode,
  baseEnv: Record<string, string | undefined> = Bun.env,
): Record<string, string | undefined> | undefined {
  return mode === "api-key" ? { ...baseEnv, CODEX_HOME: CODEX_HOME_DIR } : undefined;
}
