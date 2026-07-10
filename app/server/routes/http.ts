/** ルータモジュール共通の HTTP ヘルパとテーブル型。旧 routes.ts の json/parseJsonBody をここへ集約する。 */

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export type ParsedBody<T> = { ok: true; body: T } | { ok: false; response: Response };

export const JSON_BODY_MAX_BYTES = 64 * 1024;
const JSON_MAX_DEPTH = 10;
const JSON_MAX_NODES = 1_024;
const JSON_MAX_STRING_CHARS = 32 * 1024;

export async function readRequestBody(
  req: Request,
  options: { maxBytes: number },
): Promise<ParsedBody<Uint8Array>> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { ok: false, response: json({ error: "invalid Content-Length" }, 400) };
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) {
      return { ok: false, response: json({ error: "invalid Content-Length" }, 400) };
    }
    if (declaredBytes > options.maxBytes) {
      return { ok: false, response: json({ error: `payload exceeds ${options.maxBytes} byte limit` }, 413) };
    }
  }

  if (!req.body) return { ok: true, body: new Uint8Array() };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > options.maxBytes) {
        try { await reader.cancel("payload too large"); } catch { /* 応答は413を優先 */ }
        return { ok: false, response: json({ error: `payload exceeds ${options.maxBytes} byte limit` }, 413) };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    return { ok: false, response: json({ error: "request body could not be read" }, 400) };
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, body };
}

function isJsonMediaType(contentType: string | null): boolean {
  if (!contentType) return false;
  const mediaType = contentType.split(";", 1)[0]!.trim().toLowerCase();
  return mediaType === "application/json" || (mediaType.startsWith("application/") && mediaType.endsWith("+json"));
}

function jsonStructureError(
  root: Record<string, unknown>,
  options: { maxDepth: number; maxNodes: number; maxStringChars: number },
): string | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    nodes++;
    if (nodes > options.maxNodes) return "JSON body has too many values";
    if (typeof value === "string" && value.length > options.maxStringChars) {
      return "JSON body contains an oversized string";
    }
    if (value === null || typeof value !== "object") continue;
    if (depth >= options.maxDepth) return "JSON body is nested too deeply";
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) stack.push({ value: child, depth: depth + 1 });
  }
  return null;
}

/** JSON media type・stream byte上限・object root・構造量を検証してから型付きbodyを返す。 */
export async function parseJsonBody<T>(
  req: Request,
  options: {
    maxBytes?: number;
    maxDepth?: number;
    maxNodes?: number;
    maxStringChars?: number;
  } = {},
): Promise<ParsedBody<T>> {
  if (!isJsonMediaType(req.headers.get("content-type"))) {
    return { ok: false, response: json({ error: "Content-Type must be application/json" }, 415) };
  }
  const raw = await readRequestBody(req, { maxBytes: options.maxBytes ?? JSON_BODY_MAX_BYTES });
  if (!raw.ok) return raw;
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw.body);
    value = JSON.parse(text);
  } catch {
    return { ok: false, response: json({ error: "invalid JSON body" }, 400) };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, response: json({ error: "JSON body must be an object" }, 400) };
  }
  const structureError = jsonStructureError(value as Record<string, unknown>, {
    maxDepth: options.maxDepth ?? JSON_MAX_DEPTH,
    maxNodes: options.maxNodes ?? JSON_MAX_NODES,
    maxStringChars: options.maxStringChars ?? JSON_MAX_STRING_CHARS,
  });
  if (structureError) return { ok: false, response: json({ error: structureError }, 400) };
  return { ok: true, body: value as T };
}

/** ルートテーブルの1エントリ。合成側は method 一致 + match(pathname) で先頭一致ディスパッチする */
export type RouteEntry = {
  method: string;
  match: (pathname: string) => boolean;
  handler: (req: Request, url: URL) => Response | Promise<Response>;
};

/** 完全一致ルート */
export function exact(method: string, pathname: string, handler: RouteEntry["handler"]): RouteEntry {
  return { method, match: (p) => p === pathname, handler };
}

/** 前方一致ルート（パスパラメータ付き。例: PUT /api/chunks/:id/visibility） */
export function prefix(method: string, pathnamePrefix: string, handler: RouteEntry["handler"]): RouteEntry {
  return { method, match: (p) => p.startsWith(pathnamePrefix), handler };
}

/** ベストエフォート副作用: 失敗しても握りつぶし警告だけ出す（親レスポンスを失敗させないため）。同期処理専用 — async fn を渡すと例外が unhandled rejection になり警告されない。 */
export function bestEffort(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(label, String(err));
  }
}
