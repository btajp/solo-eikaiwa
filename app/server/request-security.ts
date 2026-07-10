const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const APP_HOSTNAMES = new Set(["solo-eikaiwa", "solo-eikaiwa.localhost"]);

function normalizeHostname(hostname: string): string {
  let normalized = hostname.trim().toLowerCase();
  if (normalized.startsWith("[") && normalized.endsWith("]")) normalized = normalized.slice(1, -1);
  if (normalized.endsWith(".")) normalized = normalized.slice(0, -1);
  return normalized;
}

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function hostnameFromAuthority(authority: string): string | null {
  if (!authority || /[\s/@\\]/.test(authority)) return null;
  try {
    const parsed = new URL(`http://${authority}`);
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function isAllowedHost(authority: string): boolean {
  const hostname = hostnameFromAuthority(authority);
  return hostname !== null && (LOOPBACK_HOSTNAMES.has(hostname) || APP_HOSTNAMES.has(hostname));
}

function isAllowedOrigin(origin: string): boolean {
  if (!origin || origin === "null") return false;
  try {
    const parsed = new URL(origin);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
    const hostname = normalizeHostname(parsed.hostname);
    if (LOOPBACK_HOSTNAMES.has(hostname)) {
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    }
    if (APP_HOSTNAMES.has(hostname)) {
      return parsed.protocol === "https:" && (parsed.port === "" || parsed.port === "443");
    }
    return false;
  } catch {
    return false;
  }
}

export type RequestBoundaryViolation = { status: 403; error: string };

/** APIをDNS rebinding・cross-origin browser requestから守る。OriginなしのCLIは許可する。 */
export function validateRequestBoundary(req: Request, url: URL): RequestBoundaryViolation | null {
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return null;
  const authority = req.headers.get("host")?.trim() || url.host;
  if (!isAllowedHost(authority)) return { status: 403, error: "request Host is not allowed" };

  if (req.headers.get("sec-fetch-site")?.toLowerCase() === "cross-site") {
    return { status: 403, error: "cross-site request is not allowed" };
  }
  const origin = req.headers.get("origin");
  if (origin !== null && !isAllowedOrigin(origin)) {
    return { status: 403, error: "request Origin is not allowed" };
  }
  return null;
}
