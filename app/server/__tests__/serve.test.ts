import { describe, expect, test } from "bun:test";
import { DEFAULT_HOSTNAME, DEFAULT_PORT, resolveHostname, resolvePort, serveOrExit } from "../serve";

describe("resolvePort", () => {
  test("env未設定時は既定の3111", () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
    expect(resolvePort({ SOLO_EIKAIWA_PORT: undefined })).toBe(DEFAULT_PORT);
  });

  test("SOLO_EIKAIWA_PORTの数値文字列で上書きされる", () => {
    expect(resolvePort({ SOLO_EIKAIWA_PORT: "4000" })).toBe(4000);
  });

  test("空文字/空白のみは既定値にフォールバックする", () => {
    expect(resolvePort({ SOLO_EIKAIWA_PORT: "" })).toBe(DEFAULT_PORT);
    expect(resolvePort({ SOLO_EIKAIWA_PORT: "   " })).toBe(DEFAULT_PORT);
  });

  test("数値でない/0以下/非整数は既定値にフォールバックする（不正値でクラッシュさせない）", () => {
    expect(resolvePort({ SOLO_EIKAIWA_PORT: "abc" })).toBe(DEFAULT_PORT);
    expect(resolvePort({ SOLO_EIKAIWA_PORT: "-1" })).toBe(DEFAULT_PORT);
    expect(resolvePort({ SOLO_EIKAIWA_PORT: "0" })).toBe(DEFAULT_PORT);
    expect(resolvePort({ SOLO_EIKAIWA_PORT: "3111.5" })).toBe(DEFAULT_PORT);
  });
});

describe("resolveHostname", () => {
  test("env未設定時は既定の127.0.0.1", () => {
    expect(resolveHostname({})).toBe(DEFAULT_HOSTNAME);
  });

  test("IPv4/IPv6 loopbackだけ上書きを許可する", () => {
    expect(resolveHostname({ SOLO_EIKAIWA_HOST: "localhost" })).toBe("localhost");
    expect(resolveHostname({ SOLO_EIKAIWA_HOST: "::1" })).toBe("::1");
  });

  test("認証のない非loopback待受は起動前に拒否する", () => {
    expect(() => resolveHostname({ SOLO_EIKAIWA_HOST: "0.0.0.0" })).toThrow("loopback");
    expect(() => resolveHostname({ SOLO_EIKAIWA_HOST: "192.168.1.10" })).toThrow("loopback");
    expect(() => resolveHostname({ SOLO_EIKAIWA_HOST: "::" })).toThrow("loopback");
  });

  test("空文字/空白のみは既定値にフォールバックする", () => {
    expect(resolveHostname({ SOLO_EIKAIWA_HOST: "" })).toBe(DEFAULT_HOSTNAME);
    expect(resolveHostname({ SOLO_EIKAIWA_HOST: "   " })).toBe(DEFAULT_HOSTNAME);
  });
});

describe("serveOrExit", () => {
  test("正常にbindできればBun.serveのサーバをそのまま返す", () => {
    const server = serveOrExit({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      expect(server.port).toBeGreaterThan(0);
    } finally {
      server.stop(true);
    }
  });

  test("ポート使用中（EADDRINUSE）は例外を投げず、日本語メッセージを出してexit(1)する", () => {
    const first = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    try {
      const port = first.port;
      const captured: { exitCode: number | null; message: string } = { exitCode: null, message: "" };
      const result = serveOrExit(
        { port, hostname: "127.0.0.1", fetch: () => new Response("ok") },
        {
          exit: (code: number) => { captured.exitCode = code; return undefined as never; },
          log: (msg: string) => { captured.message = msg; },
        },
      );
      expect(captured.exitCode).toBe(1);
      expect(captured.message).toContain("ポート使用中です");
      expect(captured.message).toContain("既存デーモン");
      expect(captured.message).toContain(String(port));
      expect(result).toBeUndefined();
    } finally {
      first.stop(true);
    }
  });

  test("EADDRINUSE以外のエラーはそのまま再送出する（握りつぶさない）", () => {
    expect(() =>
      serveOrExit({ port: 0, hostname: "127.0.0.1", fetch: undefined as never }),
    ).toThrow();
  });
});
