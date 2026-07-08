import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { POC_STT_LOG_FILE } from "../paths";
import { exact, json, type RouteEntry } from "./http";

/** Task 3（Tauri Phase 1）の録音→STT PoC専用。省略時は実ログ（POC_STT_LOG_FILE）を使う。テストでは temp file を注入する。 */
export type DevRoutesDeps = {
  pocLogFile?: string;
};

// PoC結果（サポート状況＋STTテキスト程度）を想定した上限。任意サイズの一般アップロード経路にしないためのガード。
const MAX_POC_RESULT_BYTES = 64 * 1024;

function asRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : { value: body };
}

/**
 * クライアントの録音→STT実測結果（対応mimeType一覧・選択結果・STT応答orエラー）を
 * data/logs/poc-stt.jsonl へ追記するだけの dev 専用エンドポイント。ヘッドレスな実機PoC実行の
 * 結果を後から読めるようにするための最小実装（ファイル名固定・JSON以外拒否・サイズ上限で
 * 任意ファイル書き込み/データ抜き取りの経路にしない）。
 */
async function handlePocResult(req: Request, deps: DevRoutesDeps): Promise<Response> {
  const text = await req.text();
  if (text.length > MAX_POC_RESULT_BYTES) return json({ error: "payload too large" }, 413);

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const file = deps.pocLogFile ?? POC_STT_LOG_FILE;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ receivedAt: new Date().toISOString(), ...asRecord(body) }) + "\n", "utf8");
  return json({ ok: true });
}

export function makeDevRoutes(deps: DevRoutesDeps): RouteEntry[] {
  return [exact("POST", "/api/dev/poc-result", (req) => handlePocResult(req, deps))];
}
