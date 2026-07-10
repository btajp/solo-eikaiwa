import type { Database } from "bun:sqlite";
import type { SecretName } from "./secrets";
import { parseRemoteBaseUrl } from "./remote-endpoint";

export const ORIGIN_BOUND_SECRET_NAMES = ["OPENAI_COMPAT_API_KEY", "TTS_API_KEY"] as const;
export type OriginBoundSecretName = (typeof ORIGIN_BOUND_SECRET_NAMES)[number];

export function isOriginBoundSecretName(name: SecretName): name is OriginBoundSecretName {
  return (ORIGIN_BOUND_SECRET_NAMES as readonly string[]).includes(name);
}

export function ensureApiKeyOriginSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS api_key_origins (
    secret_name TEXT PRIMARY KEY,
    origin TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
}

export type ApiKeyOriginStore = {
  get(name: OriginBoundSecretName): string | null;
  set(name: OriginBoundSecretName, origin: string): void;
  remove(name: OriginBoundSecretName): void;
};

export function makeApiKeyOriginStore(db: Database): ApiKeyOriginStore {
  return {
    get(name) {
      return db.query<{ origin: string }, [string]>(
        "SELECT origin FROM api_key_origins WHERE secret_name = ?",
      ).get(name)?.origin ?? null;
    },
    set(name, origin) {
      db.run(
        `INSERT INTO api_key_origins (secret_name, origin, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(secret_name) DO UPDATE SET origin = excluded.origin, updated_at = excluded.updated_at`,
        [name, origin, new Date().toISOString()],
      );
    },
    remove(name) {
      db.run("DELETE FROM api_key_origins WHERE secret_name = ?", [name]);
    },
  };
}

/** 承認originと現在の接続先originが一致し、かつ認証送信可能なURLのときだけ鍵を返す。 */
export function resolveOriginBoundSecret(
  store: ApiKeyOriginStore,
  name: OriginBoundSecretName,
  baseUrl: string,
  getSecret: (name: OriginBoundSecretName) => string | undefined,
): string | undefined {
  const parsed = parseRemoteBaseUrl(baseUrl);
  if (!parsed.ok || !parsed.credentialsAllowed || store.get(name) !== parsed.origin) return undefined;
  return getSecret(name);
}

/**
 * origin-bound鍵が設定済みなら承認結果を優先し、未承認時に別の鍵へ黙って切り替えない。
 * origin-bound鍵自体が無い場合だけ、固定された信頼済み接続先向けのレガシー鍵を返す。
 */
export function resolveOriginBoundSecretWithFixedFallback(
  store: ApiKeyOriginStore,
  name: OriginBoundSecretName,
  baseUrl: string,
  getSecret: (name: OriginBoundSecretName) => string | undefined,
  fixedBaseUrl: string,
  getFallbackSecret: () => string | undefined,
): string | undefined {
  const primary = getSecret(name);
  if (primary) return resolveOriginBoundSecret(store, name, baseUrl, () => primary);

  const target = parseRemoteBaseUrl(baseUrl);
  const fixed = parseRemoteBaseUrl(fixedBaseUrl);
  if (!target.ok || !target.credentialsAllowed || !fixed.ok || target.origin !== fixed.origin) return undefined;
  return getFallbackSecret();
}
