import { isLoopbackHostname } from "./request-security";

export type ParsedRemoteBaseUrl = {
  ok: true;
  baseUrl: string;
  origin: string;
  credentialsAllowed: boolean;
};

export type InvalidRemoteBaseUrl = { ok: false; error: string };

/**
 * OpenAI互換接続先を正規化する。鍵なし通信ではLAN上のHTTPを許容するが、認証情報を送れるのは
 * HTTPSまたはloopback HTTPだけ。userinfo・query・fragmentは接続先の曖昧化を避けるため拒否する。
 */
export function parseRemoteBaseUrl(raw: string): ParsedRemoteBaseUrl | InvalidRemoteBaseUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, error: "baseUrl must be an absolute http(s) URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "baseUrl must use http or https" };
  }
  if (url.username || url.password) return { ok: false, error: "baseUrl must not contain userinfo" };
  if (url.search || url.hash) return { ok: false, error: "baseUrl must not contain a query or fragment" };

  const pathname = url.pathname.replace(/\/+$/, "");
  const baseUrl = pathname ? `${url.origin}${pathname}` : url.origin;
  return {
    ok: true,
    baseUrl,
    origin: url.origin,
    credentialsAllowed: url.protocol === "https:" || isLoopbackHostname(url.hostname),
  };
}
