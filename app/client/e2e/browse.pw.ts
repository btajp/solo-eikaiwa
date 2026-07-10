import { expect, test } from "@playwright/test";

const health = {
  ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: true,
  app: "solo-eikaiwa", version: "test", llmReady: true,
};

const sentences = Array.from({ length: 390 }, (_, index) => {
  const no = index + 1;
  return {
    no, category_no: no % 2 ? 1 : 2, category: no % 2 ? "Requests" : "Plans",
    domain: no % 3 === 0 ? "it" : no % 3 === 1 ? "daily" : "business",
    en: no === 12 ? "Could you reschedule the meeting?" : `Example sentence ${no}.`,
    ja: no === 12 ? "会議の日程を変更できますか" : `例文 ${no}`,
    note: `Note ${no}`,
    srs: no % 2 ? null : { stage: 2, due: "2026-07-12", reviews: 1 },
  };
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("lang", "en");
  });
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/health") return json(health);
    if (url.pathname === "/api/progress/days") return json({ days: [], xpByDay: {} });
    if (url.pathname === "/api/progress/summary") {
      return json({ level: 1, xp: 0, xpIntoLevel: 0, xpToNext: 100, stage: 1, difficultyMaxed: false, proposal: null });
    }
    if (url.pathname === "/api/placement/latest") return json({ result: null });
    if (url.pathname === "/api/sentences") return json({ sentences });
    if (url.pathname === "/api/sentences/queue") return json({ queue: [] });
    if (url.pathname === "/api/chunks") {
      return json({ chunks: url.searchParams.get("visibility") === "hidden" ? [] : [{
        id: 1, created: "2026-07-10", source: "ae", promptText: "I go office", en: "I went to the office", note: "Tense",
        srs: { stage: 0, due: "2026-07-11", reviews: 0 },
      }] });
    }
    return json({});
  });
});

test("例文とマイフレーズを検索し、390件は1ページだけ描画する", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "390 Sentences" }).click();
  await page.getByRole("button", { name: "Browse" }).click();

  await expect(page.locator(".sentence-row")).toHaveCount(41);
  await expect(page.getByText("390 results · page 1 of 10", { exact: true })).toBeVisible();

  const search = page.getByLabel("Find a phrase");
  await search.fill("日程");
  await expect(page.getByText("Could you reschedule the meeting?", { exact: true })).toBeVisible();
  await expect(page.getByText("390 results · page 1 of 10", { exact: true })).toHaveCount(0);
  const play = page.getByRole("button", { name: "Play No.12" });
  await play.focus();
  await expect(play).toBeFocused();

  await search.fill("office");
  await expect(page.getByText("I went to the office", { exact: true })).toBeVisible();
});
