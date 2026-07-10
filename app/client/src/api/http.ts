/**
 * API・通信失敗を画面向けの安定コードと、開発時だけ追える診断情報へ分ける。
 * サーバの error 本文は画面に返さない。画面は user-error.ts でコードを日英の案内へ変換する。
 */
export type ClientErrorCode =
  | "VALIDATION"
  | "OFFLINE"
  | "TIMEOUT"
  | "AUTHORIZATION"
  | "NOT_FOUND"
  | "SERVER"
  | "UNKNOWN";

export type ClientErrorDetail = {
  code: ClientErrorCode;
  correlationId: string;
  diagnostic: string;
  status?: number;
  operation?: string;
};

const MARKER_PREFIX = "solo-eikaiwa-error";
const MARKER = new RegExp(`\\[\\[${MARKER_PREFIX}:(VALIDATION|OFFLINE|TIMEOUT|AUTHORIZATION|NOT_FOUND|SERVER|UNKNOWN):([A-Za-z0-9-]+)\\]\\]`);
const MAX_RETAINED_DETAILS = 100;
const detailsByReference = new Map<string, ClientErrorDetail>();
const reportedReferences = new Set<string>();
let localSequence = 0;

function correlationId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  localSequence += 1;
  return `local-${Date.now().toString(36)}-${localSequence}`;
}

function responseCorrelationId(res: Response): string {
  const requestId = res.headers.get("x-request-id");
  return requestId && /^[A-Za-z0-9-]+$/.test(requestId) ? requestId : correlationId();
}

function codeForStatus(status: number): ClientErrorCode {
  if (status === 408 || status === 504) return "TIMEOUT";
  if (status === 401 || status === 403) return "AUTHORIZATION";
  if (status === 404) return "NOT_FOUND";
  if (status >= 500) return "SERVER";
  if (status >= 400) return "VALIDATION";
  return "UNKNOWN";
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error);
}

function codeForException(text: string, error: unknown): ClientErrorCode {
  const name = error instanceof Error ? error.name : "";
  if (name === "AbortError" || name === "TimeoutError" || /timeout|timed out|aborted/i.test(text)) return "TIMEOUT";
  if (/failed to fetch|networkerror|network request failed|load failed|connection refused|offline/i.test(text)) return "OFFLINE";
  return "UNKNOWN";
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/(api[ _-]?key|authorization|bearer|token|password)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
    .replace(/\/Users\/[^\s:]+/g, "[local-path]")
    .slice(0, 500);
}

function remember(detail: ClientErrorDetail): ClientErrorDetail {
  detailsByReference.set(detail.correlationId, detail);
  while (detailsByReference.size > MAX_RETAINED_DETAILS) {
    const oldest = detailsByReference.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    detailsByReference.delete(oldest);
  }
  return detail;
}

function marker(detail: ClientErrorDetail): string {
  return `[[${MARKER_PREFIX}:${detail.code}:${detail.correlationId}]]`;
}

function operationFrom(text: string): string | undefined {
  const index = text.indexOf("[[");
  const prefix = (index >= 0 ? text.slice(0, index) : "").replace(/:\s*$/, "").trim();
  return prefix || undefined;
}

/**
 * 任意の例外を、UI に表示してよい情報だけを持つ安定したエラー詳細へ変換する。
 * 同じ marker は同じ参照番号・診断情報を再利用する。
 */
export function describeClientError(error: unknown): ClientErrorDetail {
  const text = errorText(error);
  const matched = text.match(MARKER);
  if (matched) {
    const code = matched[1] as ClientErrorCode;
    const correlation = matched[2];
    const known = detailsByReference.get(correlation);
    if (known) return { ...known, operation: known.operation ?? operationFrom(text) };
    return {
      code,
      correlationId: correlation,
      diagnostic: "The original diagnostic detail is no longer retained in this tab.",
      operation: operationFrom(text),
    };
  }
  return remember({
    code: codeForException(text, error),
    correlationId: correlationId(),
    diagnostic: redactDiagnostic(text),
  });
}

/** エラーを安全な内部 marker に直列化する。marker 自体は画面表示用ではない。 */
export function serializeClientError(error: unknown): string {
  return marker(describeClientError(error));
}

/** 参照番号で一度だけ診断を開発ログへ残す。画面にはこの詳細を表示しない。 */
export function reportClientError(error: unknown): ClientErrorDetail {
  const detail = describeClientError(error);
  if (!reportedReferences.has(detail.correlationId)) {
    reportedReferences.add(detail.correlationId);
    while (reportedReferences.size > MAX_RETAINED_DETAILS) {
      const oldest = reportedReferences.values().next().value as string | undefined;
      if (oldest === undefined) break;
      reportedReferences.delete(oldest);
    }
    console.error("[solo-eikaiwa] request failed", {
      reference: detail.correlationId,
      code: detail.code,
      status: detail.status,
      operation: detail.operation,
      diagnostic: detail.diagnostic,
    });
  }
  return detail;
}

/**
 * 非2xxレスポンスを安全な marker に変換する。サーバの error（内部例外・path等を含み得る）は
 * 診断用にだけ保持し、呼び出し元の Error.message へは安定コードと参照番号だけを渡す。
 */
export async function extractErrorMessage(res: Response): Promise<string> {
  let diagnostic = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown };
    if (typeof body?.error === "string" && body.error) diagnostic = body.error;
  } catch {
    // 非JSON本文でも HTTP 状態だけを診断に残す
  }
  return marker(remember({
    code: codeForStatus(res.status),
    correlationId: responseCorrelationId(res),
    diagnostic: redactDiagnostic(diagnostic),
    status: res.status,
  }));
}
