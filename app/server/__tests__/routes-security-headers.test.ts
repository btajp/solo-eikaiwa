import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq, postJson } from "./helpers/http";

/** index.html + assets を持つ dist フィクスチャ（routes-static.test.ts と同じ最小再現） */
function makeDistFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dist-sec-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body>root</body></html>");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "assets", "x-abc123.js"), "console.log('hi')");
  return dir;
}

/** #204: iframe埋め込み（クリックジャッキング）とMIME推測への防御層。全レスポンス共通で付与する。 */
function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
}

describe("routes: セキュリティヘッダの一括付与（#204）", () => {
  test("配信HTML（GET /）に CSP frame-ancestors・X-Frame-Options・nosniff が付く", async () => {
    const { deps } = makeTestDeps({ staticDir: makeDistFixture() });
    const res = await makeFetchHandler(deps)(getReq("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expectSecurityHeaders(res);
  });

  test("静的アセット（GET /assets/*.js）にも付く（既存のcache-controlは保持）", async () => {
    const { deps } = makeTestDeps({ staticDir: makeDistFixture() });
    const res = await makeFetchHandler(deps)(getReq("/assets/x-abc123.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expectSecurityHeaders(res);
  });

  test("APIレスポンス（GET /api/health）にも付く", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(getReq("/api/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expectSecurityHeaders(res);
  });

  test("404 JSON にも付く", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(getReq("/api/nope"));
    expect(res.status).toBe(404);
    expectSecurityHeaders(res);
  });

  test("500 エラーJSON にも付く", async () => {
    const { deps } = makeTestDeps({
      converse: async () => {
        throw new Error("boom");
      },
    });
    const res = await makeFetchHandler(deps)(
      postJson("/api/converse", { userText: "hi", activitySessionId: "practice-1" }),
    );
    expect(res.status).toBe(500);
    expectSecurityHeaders(res);
  });

  test("境界検証で拒否されたレスポンス（403）にも付く", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/health", {
      headers: { origin: "https://evil.example" },
    }));
    expect(res.status).toBe(403);
    expectSecurityHeaders(res);
  });
});
