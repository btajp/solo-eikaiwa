/** ルートテスト用の Request 生成ヘルパ。JSON POST と GET のボイラープレートを1行に畳む。
 * DELETE・バイナリ本文（STT アップロード）は少数のため、各テストでインライン生成のまま残す。 */

export function postJson(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function getReq(path: string): Request {
  return new Request(`http://localhost${path}`);
}
