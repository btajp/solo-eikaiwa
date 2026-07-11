import { describe, expect, test } from "bun:test";
import { describeClientError, extractErrorMessage, reportClientError, serializeClientError, type ClientErrorCode } from "./http";

describe("client error classification", () => {
  const responseCases: Array<{ status: number; code: ClientErrorCode }> = [
    { status: 400, code: "VALIDATION" },
    { status: 401, code: "AUTHORIZATION" },
    { status: 403, code: "AUTHORIZATION" },
    { status: 404, code: "NOT_FOUND" },
    { status: 408, code: "TIMEOUT" },
    { status: 500, code: "SERVER" },
    { status: 504, code: "TIMEOUT" },
  ];

  for (const { status, code } of responseCases) {
    test(`HTTP ${status} is ${code}`, async () => {
      const marker = await extractErrorMessage(new Response(JSON.stringify({ error: "provider API_KEY=secret-value at /Users/example/private" }), {
        status,
        headers: { "x-request-id": `trace-${status}` },
      }));
      const detail = describeClientError(marker);

      expect(detail.code).toBe(code);
      expect(detail.correlationId).toBe(`trace-${status}`);
      expect(marker).not.toContain("secret-value");
      expect(marker).not.toContain("private");
      expect(detail.diagnostic).not.toContain("secret-value");
      expect(detail.diagnostic).not.toContain("/Users/example");
    });
  }

  const exceptionCases: Array<{ error: Error; code: ClientErrorCode }> = [
    { error: new TypeError("Failed to fetch"), code: "OFFLINE" },
    { error: new DOMException("request aborted", "AbortError"), code: "TIMEOUT" },
    { error: new Error("unexpected parser state"), code: "UNKNOWN" },
  ];

  for (const { error, code } of exceptionCases) {
    test(`${error.name} is ${code}`, () => {
      expect(describeClientError(serializeClientError(error)).code).toBe(code);
    });
  }

  test("診断は参照番号付きでログへ残し、秘匿値は伏せる", async () => {
    const original = console.error;
    const calls: unknown[][] = [];
    console.error = (...args) => { calls.push(args); };
    try {
      const marker = await extractErrorMessage(new Response(JSON.stringify({ error: "Authorization: Bearer token-value" }), {
        status: 500,
        headers: { "x-request-id": "trace-log" },
      }));
      reportClientError(marker);
    } finally {
      console.error = original;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe("[solo-eikaiwa] request failed");
    expect(calls[0][1]).toMatchObject({ reference: "trace-log", code: "SERVER", diagnostic: "Authorization=[redacted]" });
  });

  test("macOS以外も含むローカルパスを診断から伏せる", () => {
    const detail = describeClientError(new Error(
      "at /private/var/db/app file:///Users/example/data file://localhost/Users/example/data C:\\Users\\example\\app /home/example/project /var/folders/a/b",
    ));

    expect(detail.diagnostic).not.toContain("/private/");
    expect(detail.diagnostic).not.toContain("file:///");
    expect(detail.diagnostic).not.toContain("file://localhost/");
    expect(detail.diagnostic).not.toContain("C:\\Users");
    expect(detail.diagnostic).not.toContain("/home/example");
    expect(detail.diagnostic).not.toContain("/var/folders");
    expect(detail.diagnostic).toContain("[local-path]");
  });
});
