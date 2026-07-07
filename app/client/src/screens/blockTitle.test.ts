import { describe, expect, test } from "bun:test";
import { blockTitle } from "./blockTitle";
import type { MenuBlock } from "../api";

const BASE: MenuBlock = {
  id: "b1", kind: "warmup-reading", title: "音読ウォームアップ",
  titleKey: "warmup", minutes: 6, params: {},
};

describe("blockTitle", () => {
  test("titleKey があれば言語別に組み立てる", () => {
    expect(blockTitle(BASE, "en")).toBe("Read-Aloud Warm-up");
    expect(blockTitle(BASE, "ja")).toBe("音読ウォームアップ");
  });

  test("topicTitle を差し込む（ftt）", () => {
    const b: MenuBlock = { ...BASE, kind: "four-three-two", titleKey: "ftt", topicTitle: "My weekend" };
    expect(blockTitle(b, "en")).toBe("4/3/2: My weekend");
    expect(blockTitle(b, "ja")).toBe("4/3/2: My weekend");
  });

  test("titleKey が無ければ JA title をそのまま返す（旧キャッシュ）", () => {
    const b: MenuBlock = { ...BASE, titleKey: undefined };
    expect(blockTitle(b, "en")).toBe("音読ウォームアップ");
  });

  test("未知の titleKey は JA title へフォールバック（クラッシュしない）", () => {
    const b = { ...BASE, titleKey: "unknown-key" } as unknown as MenuBlock;
    expect(blockTitle(b, "en")).toBe("音読ウォームアップ");
    expect(blockTitle(b, "ja")).toBe("音読ウォームアップ");
  });
});
