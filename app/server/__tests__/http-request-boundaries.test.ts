import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import {
  JSON_BODY_MAX_BYTES,
  parseJsonBody,
  readRequestBody,
} from "../routes/http";
import { readEvents } from "../session-log";
import { FAKE_HEALTH, makeTestDeps } from "./helpers/route-deps";

function streamRequest(
  chunks: Uint8Array[],
  headers: Record<string, string>,
  onCancel?: () => void,
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    cancel() {
      onCancel?.();
    },
  });
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

describe("HTTP request host/origin boundary", () => {
  test("DNS rebindingを想定した許可外HostはOriginなしでも403", async () => {
    const { deps } = makeTestDeps();
    const res = await makeFetchHandler(deps)(new Request("http://127.0.0.1/api/health", {
      headers: { host: "attacker.example" },
    }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Host");
  });

  test("許可Hostでも外部Originの副作用requestは処理前に403", async () => {
    let warmups = 0;
    const { deps, logFile } = makeTestDeps({ warmLlm: () => { warmups++; } });
    const res = await makeFetchHandler(deps)(new Request("http://localhost/api/session/start", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: "{}",
    }));
    expect(res.status).toBe(403);
    expect(readEvents(logFile)).toEqual([]);
    expect(warmups).toBe(0);
  });

  test("Origin:nullとcross-site Fetch Metadataは拒否し、OriginなしのCLI相当は許可", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const nullOrigin = await handler(new Request("http://localhost/api/health", { headers: { origin: "null" } }));
    expect(nullOrigin.status).toBe(403);
    const crossSite = await handler(new Request("http://localhost/api/health", {
      headers: { "sec-fetch-site": "cross-site" },
    }));
    expect(crossSite.status).toBe(403);
    const noOrigin = await handler(new Request("http://localhost/api/health"));
    expect(noOrigin.status).toBe(200);
  });

  test("正当なIPv4・IPv6・Caddy・ViteのHost/Originを許可", async () => {
    const { deps } = makeTestDeps();
    const handler = makeFetchHandler(deps);
    const allowed = [
      { url: "http://127.0.0.1:3111/api/health", host: "127.0.0.1:3111", origin: "http://127.0.0.1:3111" },
      { url: "http://[::1]:3112/api/health", host: "[::1]:3112", origin: "http://[::1]:3112" },
      { url: "https://solo-eikaiwa/api/health", host: "solo-eikaiwa", origin: "https://solo-eikaiwa" },
      { url: "https://solo-eikaiwa.localhost/api/health", host: "solo-eikaiwa.localhost", origin: "https://solo-eikaiwa.localhost" },
      { url: "http://localhost:5173/api/health", host: "localhost:5173", origin: "http://localhost:5173" },
    ];
    for (const sample of allowed) {
      const res = await handler(new Request(sample.url, { headers: { host: sample.host, origin: sample.origin } }));
      expect(res.status, sample.host).toBe(200);
      expect(await res.json()).toEqual(FAKE_HEALTH);
    }
  });

  test("simple text/plainは外部Originなら403、OriginなしでもJSON endpointでは415", async () => {
    let warmups = 0;
    const { deps, logFile } = makeTestDeps({ warmLlm: () => { warmups++; } });
    const handler = makeFetchHandler(deps);
    const external = await handler(new Request("http://localhost/api/session/start", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://attacker.example" },
      body: "{}",
    }));
    expect(external.status).toBe(403);
    const originless = await handler(new Request("http://localhost/api/session/start", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }));
    expect(originless.status).toBe(415);
    expect(readEvents(logFile)).toEqual([]);
    expect(warmups).toBe(0);
  });
});

describe("stream-limited request body", () => {
  test("Content-Lengthが上限超過ならbodyを読む前に413", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull() { pulls++; } });
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "content-length": "6" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const parsed = await readRequestBody(req, { maxBytes: 5 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(413);
    // ReadableStream自体の初期pull 1回を除き、parserはbodyを読み進めない。
    expect(pulls).toBe(1);
  });

  test("Content-Length欠落のchunked bodyも累積上限で中止する", async () => {
    let cancelled = false;
    const req = streamRequest(
      [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6])],
      { "content-type": "application/octet-stream" },
      () => { cancelled = true; },
    );
    const parsed = await readRequestBody(req, { maxBytes: 5 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  test("虚偽の小さいContent-Lengthでも実受信量を優先して413", async () => {
    const req = streamRequest(
      [new TextEncoder().encode("{\"x\":12345}")],
      { "content-type": "application/json", "content-length": "2" },
    );
    const parsed = await parseJsonBody(req, { maxBytes: 8 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.response.status).toBe(413);
  });

  test("上限内のapplication/json objectはparseできる", async () => {
    const req = new Request("http://localhost/api/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{\"ok\":true}",
    });
    const parsed = await parseJsonBody<{ ok: boolean }>(req, { maxBytes: JSON_BODY_MAX_BYTES });
    expect(parsed).toEqual({ ok: true, body: { ok: true } });
  });

  test("不正Content-Type・配列root・深すぎるobject・巨大stringを400/415で拒否", async () => {
    const plain = await parseJsonBody(new Request("http://localhost/api/test", {
      method: "POST", headers: { "content-type": "text/plain" }, body: "{}",
    }));
    expect(plain.ok ? 200 : plain.response.status).toBe(415);

    const array = await parseJsonBody(new Request("http://localhost/api/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: "[]",
    }));
    expect(array.ok ? 200 : array.response.status).toBe(400);

    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 12; i++) nested = { child: nested };
    const deep = await parseJsonBody(new Request("http://localhost/api/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(nested),
    }), { maxDepth: 8 });
    expect(deep.ok ? 200 : deep.response.status).toBe(400);

    const hugeString = await parseJsonBody(new Request("http://localhost/api/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "123456" }),
    }), { maxStringChars: 5 });
    expect(hugeString.ok ? 200 : hugeString.response.status).toBe(400);
  });
});
