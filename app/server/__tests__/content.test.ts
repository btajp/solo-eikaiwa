import { describe, expect, test } from "bun:test";
import { DOMAINS, loadContent } from "../content";
import { SCENARIOS_DIR, TOPICS_DIR } from "../paths";

/** リポジトリ実コンテンツの整合性（frontmatter タグの網羅チェック） */
describe("content integrity", () => {
  const topics = loadContent(TOPICS_DIR);
  const scenarios = loadContent(SCENARIOS_DIR);

  test("topics は22本以上・scenarios は16本以上パースできる", () => {
    expect(topics.length).toBeGreaterThanOrEqual(22);
    expect(scenarios.length).toBeGreaterThanOrEqual(16);
  });

  test("topics / scenarios とも3ドメインすべてに1本以上ある", () => {
    for (const domain of DOMAINS) {
      expect(topics.filter((t) => t.domain === domain).length).toBeGreaterThanOrEqual(1);
      expect(scenarios.filter((s) => s.domain === domain).length).toBeGreaterThanOrEqual(1);
    }
  });

  test("全アイテムの level が 1..6 の有効範囲", () => {
    for (const it of [...topics, ...scenarios]) {
      expect(it.level[0]).toBeGreaterThanOrEqual(1);
      expect(it.level[1]).toBeLessThanOrEqual(6);
      expect(it.level[0]).toBeLessThanOrEqual(it.level[1]);
    }
  });

  test("どの stage(1..6) にも topics / scenarios の適合プールが3本以上ある", () => {
    for (let stage = 1; stage <= 6; stage++) {
      const tPool = topics.filter((t) => t.level[0] <= stage && stage <= t.level[1]);
      const sPool = scenarios.filter((s) => s.level[0] <= stage && stage <= s.level[1]);
      expect(tPool.length).toBeGreaterThanOrEqual(3);
      expect(sPool.length).toBeGreaterThanOrEqual(3);
    }
  });
});
