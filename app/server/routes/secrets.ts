import { json, parseJsonBody, exact, prefix, type RouteEntry } from "./http";
import { KEYCHAIN_SECRET_NAMES, isSecretName, isValidSecretValue, type SecretName, type SecretStatus } from "../secrets";
import { isOriginBoundSecretName, type OriginBoundSecretName } from "../api-key-origin-store";
import { parseRemoteBaseUrl } from "../remote-endpoint";

/**
 * API キーの write-only 設定 API（v0.29 追補・spec §3）。
 * **鍵の値はいかなる応答にも含めない**: GET は有無とソースのみ、PUT/DELETE の応答も同様。
 * 400 の検証エラーメッセージは静的文言のみ（受信値をエコーしない）。
 */
export type SecretsRoutesDeps = {
  /** 鍵ごとの有無とソース（keychain | env | null）。値は含まれない。 */
  getSecretsStatus: () => Record<SecretName, SecretStatus>;
  /** Keychain へ保存し、プロセス内の秘密情報キャッシュを更新する（失敗は throw・値を含めない）。 */
  saveSecret: (name: SecretName, value: string) => Promise<void>;
  /** Keychain から削除する。起動時 env の値は変更しない。 */
  removeSecret: (name: SecretName) => Promise<void>;
  /** 保存/削除後に runner を一括再解決する（fail-open で applied/error を返す）。 */
  applySecretsChange: (name: SecretName) => { applied: boolean; error: string | null };
  /** codex の認証環境が変わったとき常駐 app-server を kill する（llm-settings ルートと同一の依存）。 */
  killCodexAppServerRegistry: () => void;
  /**
   * CODEX_API_KEY の変更を隔離 CODEX_HOME の auth.json へ反映する（旧 auth.json 破棄 → api-key モード
   * かつ新キーがあれば再ログイン）。失敗は throw（route が applied:false + error として情報的に返す）。
   */
  refreshCodexAuth: () => Promise<void>;
  /** Claude api-keyモードと鍵の整合を再検査する。モード自体は変更しない。 */
  refreshClaudeAuth: () => Promise<void>;
  /** HTTP providerの鍵を、保存操作で明示確認した正規化originへ束縛する。 */
  bindSecretOrigin: (name: OriginBoundSecretName, origin: string) => void;
  /** origin-bound key削除時に承認記録も削除する。 */
  removeSecretOrigin: (name: OriginBoundSecretName) => void;
};

async function applyAndRespond(deps: SecretsRoutesDeps, name: SecretName): Promise<Response> {
  // CODEX_API_KEY は隔離 CODEX_HOME の auth.json と常駐プロセスに効くため、変更時は
  // app-server を kill し、auth.json を新しい鍵で作り直す（ensureCodexApiKeyHome は有効な
  // auth.json があると early-return するため、破棄→再ログインまでやらないと旧キーが使われ続ける）。
  let authError: string | null = null;
  if (name === "CODEX_API_KEY") {
    deps.killCodexAppServerRegistry();
    try {
      await deps.refreshCodexAuth();
    } catch (err) {
      authError = err instanceof Error ? err.message : String(err);
    }
  }
  if (name === "ANTHROPIC_API_KEY") {
    try {
      await deps.refreshClaudeAuth();
    } catch (err) {
      authError = err instanceof Error ? err.message : String(err);
    }
  }
  const { applied, error } = deps.applySecretsChange(name);
  return json({ secrets: deps.getSecretsStatus(), applied: applied && authError === null, error: authError ?? error });
}

async function handlePut(req: Request, deps: SecretsRoutesDeps): Promise<Response> {
  const parsed = await parseJsonBody<{ name?: unknown; value?: unknown; baseUrl?: unknown }>(req);
  if (!parsed.ok) return parsed.response;
  const { name, value } = parsed.body;
  if (typeof name !== "string" || !isSecretName(name)) {
    return json({ error: `name must be one of ${KEYCHAIN_SECRET_NAMES.join(", ")}` }, 400);
  }
  // 検証エラーに受信値をエコーしない（鍵の値をレスポンスに出さない規約）
  if (typeof value !== "string" || !isValidSecretValue(value)) {
    return json({ error: "value must be 1..500 printable ASCII chars without spaces, quotes, or backslashes" }, 400);
  }
  let approvedOrigin: string | null = null;
  const originBoundName = isOriginBoundSecretName(name) ? name : null;
  if (originBoundName !== null) {
    if (typeof parsed.body.baseUrl !== "string") {
      return json({ error: "baseUrl is required when saving this API key" }, 400);
    }
    const parsedBase = parseRemoteBaseUrl(parsed.body.baseUrl);
    if (!parsedBase.ok) return json({ error: parsedBase.error }, 400);
    if (!parsedBase.credentialsAllowed) {
      return json({ error: "API keys may only be sent to HTTPS or loopback HTTP origins" }, 400);
    }
    approvedOrigin = parsedBase.origin;
  }
  let originDetached = false;
  try {
    // KeychainとDBを跨ぐため完全なtransactionにはできない。先に旧承認を外し、途中失敗時も
    // 「鍵は存在するがどのoriginにも送らない」状態へ倒す。
    if (originBoundName !== null) {
      deps.removeSecretOrigin(originBoundName);
      originDetached = true;
    }
    await deps.saveSecret(name, value);
    if (approvedOrigin !== null && originBoundName !== null) deps.bindSecretOrigin(originBoundName, approvedOrigin);
  } catch (err) {
    // runnerは解決時の鍵を保持するため、承認を外した後の失敗でも即時再解決して古い鍵を破棄する。
    if (originDetached) deps.applySecretsChange(name);
    const message = (err instanceof Error ? err.message : String(err)).replaceAll(value, "[redacted]");
    return json({ error: message }, 500);
  }
  return applyAndRespond(deps, name);
}

async function handleDelete(url: URL, deps: SecretsRoutesDeps): Promise<Response> {
  const name = decodeURIComponent(url.pathname.slice("/api/secrets/".length));
  if (!isSecretName(name)) {
    return json({ error: `name must be one of ${KEYCHAIN_SECRET_NAMES.join(", ")}` }, 400);
  }
  let originDetached = false;
  try {
    // 先に承認を外してfail-closedにする。Keychain削除が失敗しても鍵が通信へ使われ続けない。
    if (isOriginBoundSecretName(name)) {
      deps.removeSecretOrigin(name);
      originDetached = true;
    }
    await deps.removeSecret(name);
  } catch (err) {
    if (originDetached) deps.applySecretsChange(name);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
  return applyAndRespond(deps, name);
}

export function makeSecretsRoutes(deps: SecretsRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/secrets", () => json(deps.getSecretsStatus())),
    exact("PUT", "/api/secrets", (req) => handlePut(req, deps)),
    prefix("DELETE", "/api/secrets/", (_req, url) => handleDelete(url, deps)),
  ];
}
