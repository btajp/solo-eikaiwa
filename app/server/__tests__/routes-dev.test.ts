import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { postJson } from "./helpers/http";

/** Task 3 PoC専用: /api/dev/poc-result はクライアントの録音→STT実測結果をjsonlへ追記するだけの
 * dev用エンドポイント。ファイル名固定・サイズ上限・JSON以外拒否を確認する。 */
describe("routes: dev poc-result", () => {
  test("JSONボディを1行としてpocLogFileへ追記し{ok:true}を返す", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "poc-log-"));
    const pocLogFile = path.join(dir, "poc-stt.jsonl");
    const { deps } = makeTestDeps({ pocLogFile });
    const handler = makeFetchHandler(deps);

    const res = await handler(postJson("/api/dev/poc-result", { chosenMimeType: "audio/mp4", blobSize: 123 }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(existsSync(pocLogFile)).toBe(true);
    const lines = readFileSync(pocLogFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]!) as { receivedAt: string; chosenMimeType: string; blobSize: number };
    expect(entry.chosenMimeType).toBe("audio/mp4");
    expect(entry.blobSize).toBe(123);
    expect(typeof entry.receivedAt).toBe("string");
  });

  test("複数回POSTすると追記される（上書きしない）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "poc-log-"));
    const pocLogFile = path.join(dir, "poc-stt.jsonl");
    const { deps } = makeTestDeps({ pocLogFile });
    const handler = makeFetchHandler(deps);

    await handler(postJson("/api/dev/poc-result", { attempt: 1 }));
    await handler(postJson("/api/dev/poc-result", { attempt: 2 }));

    const lines = readFileSync(pocLogFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  test("親ディレクトリが存在しなくても自動作成する", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "poc-log-"));
    const pocLogFile = path.join(dir, "nested", "logs", "poc-stt.jsonl");
    const { deps } = makeTestDeps({ pocLogFile });
    const handler = makeFetchHandler(deps);

    const res = await handler(postJson("/api/dev/poc-result", { ok: true }));

    expect(res.status).toBe(200);
    expect(existsSync(pocLogFile)).toBe(true);
  });

  test("不正なJSONは400（ファイルへは追記しない）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "poc-log-"));
    const pocLogFile = path.join(dir, "poc-stt.jsonl");
    const { deps } = makeTestDeps({ pocLogFile });
    const handler = makeFetchHandler(deps);

    const res = await handler(
      new Request("http://localhost/api/dev/poc-result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not valid json",
      }),
    );

    expect(res.status).toBe(400);
    expect(existsSync(pocLogFile)).toBe(false);
  });

  test("サイズ上限超過は413（ファイルへは追記しない）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "poc-log-"));
    const pocLogFile = path.join(dir, "poc-stt.jsonl");
    const { deps } = makeTestDeps({ pocLogFile });
    const handler = makeFetchHandler(deps);

    const huge = "x".repeat(70 * 1024);
    const res = await handler(
      new Request("http://localhost/api/dev/poc-result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ huge }),
      }),
    );

    expect(res.status).toBe(413);
    expect(existsSync(pocLogFile)).toBe(false);
  });

  test("GET /api/dev/poc-result はPOST専用のため他のAPIルート同様404 JSON", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const res = await handler(new Request("http://localhost/api/dev/poc-result"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });
});
