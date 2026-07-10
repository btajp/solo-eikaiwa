import { describe, expect, test } from "bun:test";
import { localizedTitle } from "./localized-title";

describe("教材題名の表示言語", () => {
  test("選択中の言語を優先し、対応題名がないときだけもう一方へフォールバックする", () => {
    const bilingual = { title: "Ask my boss a question", titleJa: "上司に質問する" };
    expect(localizedTitle(bilingual, "en")).toBe("Ask my boss a question");
    expect(localizedTitle(bilingual, "ja")).toBe("上司に質問する");
    expect(localizedTitle({ title: "English only", titleJa: "" }, "ja")).toBe("English only");
    expect(localizedTitle({ title: "", titleJa: "日本語のみ" }, "en")).toBe("日本語のみ");
  });
});
