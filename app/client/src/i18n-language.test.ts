import { describe, expect, test } from "bun:test";
import { resolveLang, STR } from "./i18n";

describe("初回表示言語", () => {
  test("保存済みの言語はOS言語より優先する", () => {
    expect(resolveLang("en", "ja-JP")).toBe("en");
    expect(resolveLang("ja", "en-US")).toBe("ja");
  });

  test("未保存時はja系localeだけ日本語にし、他は英語へフォールバックする", () => {
    expect(resolveLang(null, "ja-JP")).toBe("ja");
    expect(resolveLang(null, "JA")).toBe("ja");
    expect(resolveLang(null, "en-US")).toBe("en");
    expect(resolveLang(null, "fr-FR")).toBe("en");
  });

  test("4/3/2の文字起こし話者ラベルも表示言語に従う", () => {
    expect(STR.en.ftt432.transcriptYou).toBe("You:");
    expect(STR.ja.ftt432.transcriptYou).toBe("あなた:");
  });
});
