import { afterEach, describe, expect, test } from "bun:test";
import { serializeClientError } from "../api/http";
import { formatClientError } from "./user-error";

const realConsoleError = console.error;
afterEach(() => { console.error = realConsoleError; });

describe("利用者向けエラー文", () => {
  test("同じ安定コードを日英で同じ保存操作へ変換し、内部詳細を出さない", () => {
    console.error = () => {};
    const error = serializeClientError(new Error("provider API_KEY=secret-value at /Users/example/private"));
    const en = formatClientError("en", error, "save");
    const ja = formatClientError("ja", error, "save");

    expect(en).toContain("Couldn't save your changes.");
    expect(ja).toContain("変更を保存できませんでした。");
    expect(en).toContain("Reference:");
    expect(ja).toContain("参照番号:");
    expect(`${en}\n${ja}`).not.toContain("secret-value");
    expect(`${en}\n${ja}`).not.toContain("/Users/example");
  });
});
