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
  /** テスト用の差し替え seam。既定はグローバル fetch（EADDRINUSE時の身元確認プローブに使う）。 */
  fetchFn?: typeof fetch;
};

const HEALTH_PROBE_TIMEOUT_MS = 3_000;

/**
 * ポート占有者がこのアプリ自身の別インスタンスかを /api/health の応答（app: "solo-eikaiwa"）で確認する。
 * 到達不能・非JSON・別アプリの応答はすべて false（誤認して自発退出しないことを優先する）。
 */
async function isOwnServerResponding(
  hostname: string,
  port: number | string,
  fetchFn: typeof fetch,
): Promise<boolean> {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  try {
    const res = await fetchFn(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { app?: unknown };
    return body?.app === "solo-eikaiwa";
  } catch {
    return false;
  }
}

/**
 * Bun.serve をラップし、ポートbind失敗（EADDRINUSE = 既存プロセスがそのポートを掴んでいる）を
 * ハンドリングされない例外クラッシュではなく、わかりやすい日本語一行メッセージ + 終了コードに変換する。
 * sidecar モードではユーザーがスタックトレースから原因を診断できないため、要点だけを出す。
 * それ以外のエラーはそのまま再送出する（想定外の失敗を握りつぶさない）。
 *
 * 占有者の身元確認（#208）: EADDRINUSE 時に /api/health を確認し、このアプリ自身が既に応答しているなら
 * exit 0 で静かに退出する。LaunchAgent の plist（install-daemon.sh）は KeepAlive を SuccessfulExit=false に
 * しているため、exit 0 は「意図した停止」として再起動ループに入らない。占有者が別物なら従来どおり exit 1
 * （真のクラッシュ扱い・launchd が ThrottleInterval を空けて再起動）にする。
 */
export async function serveOrExit(
  options: Parameters<typeof Bun.serve>[0],
  opts: ServeOrExitOpts = {},
): Promise<ReturnType<typeof Bun.serve>> {
  const exit = opts.exit ?? ((code: number) => process.exit(code) as never);
  const log = opts.log ?? ((message: string) => console.error(message));
  const fetchFn = opts.fetchFn ?? fetch;
  try {
    return Bun.serve(options);
  } catch (err) {
    if (isAddrInUse(err)) {
      const port = (options as { port?: number | string }).port;
      const hostname = (options as { hostname?: string }).hostname ?? DEFAULT_HOSTNAME;
      if (await isOwnServerResponding(hostname, port ?? DEFAULT_PORT, fetchFn)) {
        log(
          `このアプリのサーバが既に稼働しています（port=${String(port)}）。二重起動を避けて終了します。`,
        );
        return exit(0);
      }
      log(
        `起動に失敗しました: ポート使用中です（port=${String(port)}）。既存デーモンが稼働している可能性があります。` +
        `SOLO_EIKAIWA_PORT で別のポートを指定するか、既存プロセスを終了してください。`,
      );
      return exit(1);
    }
    throw err;
  }
}
