import { isLoopbackHostname } from "./request-security";

export type ServeEnv = Record<string, string | undefined>;

export const DEFAULT_PORT = 3111;
export const DEFAULT_HOSTNAME = "127.0.0.1";

/** SOLO_EIKAIWA_PORT が数値として不正/未設定なら DEFAULT_PORT にフォールバックする（現行既定は不変）。 */
export function resolvePort(env: ServeEnv): number {
  const raw = env.SOLO_EIKAIWA_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_PORT;
}

/** SOLO_EIKAIWA_HOST が未設定/空なら DEFAULT_HOSTNAME にフォールバックする（現行既定は不変）。 */
export function resolveHostname(env: ServeEnv): string {
  const hostname = env.SOLO_EIKAIWA_HOST?.trim() || DEFAULT_HOSTNAME;
  if (!isLoopbackHostname(hostname)) {
    throw new Error(`SOLO_EIKAIWA_HOST must be a loopback hostname; unauthenticated external bind is forbidden: ${hostname}`);
  }
  return hostname === "[::1]" ? "::1" : hostname;
}

function isAddrInUse(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "EADDRINUSE";
}

export type ServeOrExitOpts = {
  /** テスト用の差し替え seam。既定は process.exit。 */
  exit?: (code: number) => never;
  /** テスト用の差し替え seam。既定は console.error。 */
  log?: (message: string) => void;
};

/**
 * Bun.serve をラップし、ポートbind失敗（EADDRINUSE = 既存プロセスがそのポートを掴んでいる）を
 * ハンドリングされない例外クラッシュではなく、わかりやすい日本語一行メッセージ + exit code 1 に変換する。
 * sidecar モードではユーザーがスタックトレースから原因を診断できないため、要点だけを出す。
 * それ以外のエラーはそのまま再送出する（想定外の失敗を握りつぶさない）。
 */
export function serveOrExit(
  options: Parameters<typeof Bun.serve>[0],
  opts: ServeOrExitOpts = {},
): ReturnType<typeof Bun.serve> {
  const exit = opts.exit ?? ((code: number) => process.exit(code) as never);
  const log = opts.log ?? ((message: string) => console.error(message));
  try {
    return Bun.serve(options);
  } catch (err) {
    if (isAddrInUse(err)) {
      const port = (options as { port?: number | string }).port;
      log(
        `起動に失敗しました: ポート使用中です（port=${String(port)}）。既存デーモンが稼働している可能性があります。` +
        `SOLO_EIKAIWA_PORT で別のポートを指定するか、既存プロセスを終了してください。`,
      );
      return exit(1);
    }
    throw err;
  }
}
