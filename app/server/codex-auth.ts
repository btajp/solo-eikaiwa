import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./paths";
import { getActiveAuthSecrets, type AuthMode } from "./llm-auth-store";
import { minimalSubprocessEnv } from "./subprocess-env";

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
 * auth.json が「有効」かどうかを判定する。存在しない、または存在しても JSON として壊れている
 * （書き込み途中でプロセスが落ちた等）場合は無効＝false とし、呼び出し元に再ログインさせる
 * （codex login --with-api-key は auth.json を上書きするため、壊れたファイルを消さずとも再実行で直る）。
 */
function hasValidAuthJson(authPath: string): boolean {
  if (!existsSync(authPath)) return false;
  try {
    JSON.parse(readFileSync(authPath, "utf8"));
    return true;
  } catch {
    return false;
  }
}

/**
 * codex api-key モード用の隔離 CODEX_HOME に auth.json を用意する（冪等）。
 * 既に有効な auth.json があれば何もせず dir をそのまま返す。無い、または壊れていれば
 * resolverが解決したCODEX_API_KEYを stdin で渡して `CODEX_HOME=<dir> codex login --with-api-key` を
 * 実行し、作成した dir を返す。dir 引数はテスト用（既定 CODEX_HOME_DIR）— 実運用の呼び出し
 * （route 経由）は常に引数省略で呼ぶ。
 */
export async function ensureCodexApiKeyHome(
  spawnFn: CodexLoginSpawn = realCodexLoginSpawn,
  dir: string = CODEX_HOME_DIR,
  apiKey: string | undefined = getActiveAuthSecrets().codex,
  baseEnv: Record<string, string | undefined> = Bun.env,
): Promise<string> {
  const authPath = path.join(dir, "auth.json");
  if (hasValidAuthJson(authPath)) return dir;

  if (!apiKey || !apiKey.trim()) {
    throw new Error("codex auth mode is api-key but no key is configured; save a key or switch to subscription");
  }

  mkdirSync(dir, { recursive: true });
  await spawnFn({ env: minimalSubprocessEnv(baseEnv, { CODEX_HOME: dir }), stdin: apiKey });
  return dir;
}

/**
 * 隔離 CODEX_HOME の auth.json を破棄する（キーのローテーション/削除時・冪等）。
 * ensureCodexApiKeyHome は有効な auth.json があると early-return するため、キー変更を
 * 反映するには先にこれを呼んで再ログインさせる必要がある（routes/secrets.ts 経由）。
 */
export function resetCodexApiKeyHome(dir: string = CODEX_HOME_DIR): void {
  rmSync(path.join(dir, "auth.json"), { force: true });
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
 * subscriptionでは固定allowlistだけを返す。api-keyでは鍵の存在を検証し、最小envへ
 * CODEX_HOME（隔離ディレクトリ）だけを追加する
 * （standalone の codex app-server は env 単体では認証されず、CODEX_HOME 配下の auth.json を要求するため。
 * exec 側もここで揃え、両経路とも同一の隔離ホームを常に指す設計にする）。
 */
export function codexSpawnEnv(
  mode: AuthMode,
  baseEnv: Record<string, string | undefined> = Bun.env,
  apiKey: string | undefined = getActiveAuthSecrets().codex,
): Record<string, string> {
  if (mode === "subscription") return minimalSubprocessEnv(baseEnv);
  if (!apiKey?.trim()) {
    throw new Error("codex auth mode is api-key but no key is configured; save a key or switch to subscription");
  }
  return minimalSubprocessEnv(baseEnv, { CODEX_HOME: CODEX_HOME_DIR });
}
