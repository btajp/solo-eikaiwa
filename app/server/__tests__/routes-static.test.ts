import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFetchHandler } from "../routes";
import { serveStatic } from "../routes/static";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq } from "./helpers/http";

/** index.html + assets/x-abc123.js を持つ dist フィクスチャを作る（Vite build 出力の最小再現） */
function makeDistFixture(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dist-"));
  writeFileSync(path.join(dir, "index.html"), "<!doctype html><html><body>root</body></html>");
  mkdirSync(path.join(dir, "assets"), { recursive: true });
  writeFileSync(path.join(dir, "assets", "x-abc123.js"), "console.log('hi')");
  writeFileSync(path.join(dir, "favicon.svg"), "<svg></svg>");
  return dir;
}

describe("routes: static (client dist 直接配信)", () => {
  test("GET / は index.html を200・text/html・no-cacheで返す", async () => {
    const staticDir = makeDistFixture();
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(await res.text()).toContain("root");
  });

  test("GET /assets/x-abc123.js はjsとして長期キャッシュ付きで返す", async () => {
    const staticDir = makeDistFixture();
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/assets/x-abc123.js"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await res.text()).toBe("console.log('hi')");
  });

  test("GET /favicon.svg はsvgとして返る（assets外はno-cache）", async () => {
    const staticDir = makeDistFixture();
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/favicon.svg"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  test("GET /nonexistent-page は存在しないのでSPAフォールバックでindex.htmlを200で返す", async () => {
    const staticDir = makeDistFixture();
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/nonexistent-page"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("root");
  });

  test("GET /assets（ファイルではなくディレクトリ）はディレクトリ一覧を返さずSPAフォールバックする", async () => {
    const staticDir = makeDistFixture();
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/assets"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("root");
  });

  test("GET /..%2f..%2fetc%2fpasswd はdistの外へエスケープできず404", async () => {
    const staticDir = makeDistFixture();
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/..%2f..%2fetc%2fpasswd"));
    expect(res.status).toBe(404);
  });

  test("リテラルな .. はnew URL()の正規化でdist配下のパスに畳まれ、SPAフォールバックする（distの外へは出ない）", async () => {
    const staticDir = makeDistFixture();
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    // new URL("http://localhost/../etc/passwd").pathname は "/etc/passwd" に正規化される
    const res = await handler(getReq("/../etc/passwd"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("root"); // SPAフォールバック＝index.html。/etc/passwd の中身は絶対に返らない
  });

  test("serveStatic単体: URL正規化を経由しない生の '..' でもcontainmentチェックでdistの外は404（多層防御）", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "static-"));
    const distDir = path.join(dir, "dist");
    mkdirSync(distDir, { recursive: true });
    writeFileSync(path.join(distDir, "index.html"), "root");
    writeFileSync(path.join(dir, "secret.txt"), "SECRET"); // dist の外（兄弟ファイル）

    const res = serveStatic("GET", "/../secret.txt", distDir);
    expect(res.status).toBe(404);
  });

  test("dist内のsymlinkがdist外を指す場合はrealpathでcontainmentを検証し404で拒否する（レキシカルチェックだけでは防げないケース）", async () => {
    const staticDir = makeDistFixture();
    const outsideDir = mkdtempSync(path.join(tmpdir(), "outside-"));
    const secretPath = path.join(outsideDir, "secret.txt");
    writeFileSync(secretPath, "SECRET-OUTSIDE-DIST");
    symlinkSync(secretPath, path.join(staticDir, "evil-link.txt"));

    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);

    const res = await handler(getReq("/evil-link.txt"));
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("SECRET-OUTSIDE-DIST");

    // symlink防御を追加してもdist内の正当なファイル配信・SPAフォールバックは影響を受けない
    const legit = await handler(getReq("/assets/x-abc123.js"));
    expect(legit.status).toBe(200);
    expect(await legit.text()).toBe("console.log('hi')");

    const spa = await handler(getReq("/nonexistent-page"));
    expect(spa.status).toBe(200);
    expect(await spa.text()).toContain("root");
  });

  test("POST / は405（静的配信はGETのみ）", async () => {
    const staticDir = makeDistFixture();
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/", { method: "POST" }));
    expect(res.status).toBe(405);
  });

  test("dist未ビルド（存在しないディレクトリ）は503でビルド手順を案内する", async () => {
    const staticDir = path.join(mkdtempSync(path.join(tmpdir(), "nodist-")), "dist-not-built");
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/"));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain("bun run build");
  });

  test("GET /api/health は従来どおり（staticにフォールバックしない）", async () => {
    const staticDir = makeDistFixture();
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/api/health"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
  });

  test("GET /api/nope（未知のAPIルート）は従来どおり404 JSON（staticにフォールバックしない）", async () => {
    const staticDir = makeDistFixture();
    const { deps } = makeTestDeps({ staticDir });
    const handler = makeFetchHandler(deps);
    const res = await handler(getReq("/api/nope"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
