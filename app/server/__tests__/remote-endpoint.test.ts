import { describe, expect, test } from "bun:test";
import { parseRemoteBaseUrl } from "../remote-endpoint";

describe("parseRemoteBaseUrl", () => {
  test("scheme・host・default port・末尾slashを正規化してoriginを返す", () => {
    expect(parseRemoteBaseUrl(" HTTPS://Example.COM:443/v1/ ")).toEqual({
      ok: true,
      baseUrl: "https://example.com/v1",
      origin: "https://example.com",
      credentialsAllowed: true,
    });
  });

  test("HTTPで認証を送れるのはlocalhost・IPv4/IPv6 loopbackだけ", () => {
    for (const input of ["http://localhost:11434/v1", "http://127.0.0.1:8880/v1", "http://[::1]:9000/v1"]) {
      const parsed = parseRemoteBaseUrl(input);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.credentialsAllowed).toBe(true);
    }
    for (const input of ["http://192.168.1.10:11434/v1", "http://models.example/v1"]) {
      const parsed = parseRemoteBaseUrl(input);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.credentialsAllowed).toBe(false);
    }
  });

  test("userinfo・非HTTP scheme・query・fragmentを拒否する", () => {
    for (const input of [
      "https://user:pass@example.com/v1",
      "ftp://example.com/v1",
      "https://example.com/v1?next=https://evil.example",
      "https://example.com/v1#fragment",
    ]) {
      expect(parseRemoteBaseUrl(input).ok, input).toBe(false);
    }
  });
});
