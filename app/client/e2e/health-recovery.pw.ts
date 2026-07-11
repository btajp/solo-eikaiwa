import { expect, test } from "@playwright/test";

const health = {
  ok: true,
  whisper: true,
  ffmpeg: true,
  claude: true,
  ttsKey: true,
  modelFile: true,
  app: "solo-eikaiwa",
  version: "test",
  llmReady: true,
};

test("health が一度失敗しても画面を再読込せず復旧する", async ({ page }) => {
  let healthRequests = 0;
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("lang", "en");
  });
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

    if (pathname === "/api/health") {
      healthRequests += 1;
      // 開発時の StrictMode で最初の effect が再実行されても、現行 mount の失敗状態を確認できるようにする。
      if (healthRequests <= 2) {
        return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporarily unavailable" }) });
      }
      return json(health);
    }
    if (pathname === "/api/progress/days") return json({ days: [], xpByDay: {} });
    if (pathname === "/api/progress/summary") {
      return json({ level: 1, xp: 0, xpIntoLevel: 0, xpToNext: 100, stage: 1, difficultyMaxed: false, proposal: null });
    }
    if (pathname === "/api/placement/latest") return json({ result: null });
    return json({});
  });

  await page.goto("/");
  const serverDown = page.getByText(/Can't connect to the API server/);
  await expect(serverDown).toBeVisible();
  await expect(serverDown).toBeHidden({ timeout: 8_000 });
  expect(healthRequests).toBeGreaterThanOrEqual(3);
});
