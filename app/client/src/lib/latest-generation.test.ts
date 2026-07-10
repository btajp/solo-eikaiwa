import { describe, expect, test } from "bun:test";
import { makeLatestGeneration } from "./latest-generation";

describe("最新要求の世代管理", () => {
  test("後から始めた要求だけを現在の要求として扱う", () => {
    const generation = makeLatestGeneration();
    const first = generation.begin();
    const second = generation.begin();

    expect(generation.isCurrent(first)).toBe(false);
    expect(generation.isCurrent(second)).toBe(true);
  });
});
