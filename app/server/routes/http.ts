/** ルータモジュール共通の HTTP ヘルパとテーブル型。旧 routes.ts の json/parseJsonBody をここへ集約する。 */

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export type ParsedBody<T> = { ok: true; body: T } | { ok: false; response: Response };

/** req.json() の失敗（不正なJSON）を 500 ではなく 400 として扱うための共通ラッパー */
export async function parseJsonBody<T>(req: Request): Promise<ParsedBody<T>> {
  try {
    return { ok: true, body: (await req.json()) as T };
  } catch {
    return { ok: false, response: json({ error: "invalid JSON body" }, 400) };
  }
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

/** 前方一致ルート（パスパラメータ付き。例: DELETE /api/chunks/:id） */
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
