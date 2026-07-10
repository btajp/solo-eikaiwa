/** 子プロセスへ継承してよい、実行基盤に必要な環境変数だけの固定allowlist。 */
const SAFE_SUBPROCESS_ENV_KEYS = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/**
 * ambient envを子プロセスへ丸ごと渡さず、固定allowlistと呼び出し元が明示した値だけを返す。
 * APIキー・NODE_OPTIONS・アプリ固有envはallowlistに含めない。
 */
export function minimalSubprocessEnv(
  baseEnv: Record<string, string | undefined> = Bun.env,
  additions: Record<string, string | undefined> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of SAFE_SUBPROCESS_ENV_KEYS) {
    const value = baseEnv[key];
    if (value !== undefined) out[key] = value;
  }
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
