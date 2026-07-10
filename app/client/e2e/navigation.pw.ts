import { expect, test, type Page } from "@playwright/test";

const health = {
  ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: true,
  app: "solo-eikaiwa", version: "test", llmReady: true,
};

async function preparePage(page: Page) {
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
    if (url.pathname === "/api/sentences") return json({ sentences: [] });
    if (url.pathname === "/api/sentences/queue") return json({ queue: [] });
    if (url.pathname === "/api/chunks") return json({ chunks: [] });
    if (url.pathname === "/api/listening") return json({ items: [], weeklyCount: 0 });
    if (url.pathname === "/api/metrics/summary") {
      const empty = {
        utterances: 0, words: 0, speechMs: 0, totalMs: 0, pauseMs: 0, repetitionWords: 0,
        repetitionWeightedWords: 0, speakingSec: 0, avgArticulationWpm: 0, avgPauseRatio: 0, repetitionRatio: 0,
      };
      return json({ days: [], weekly: { current: empty, previous: empty }, level: { current: 1, history: [] } });
    }
    if (url.pathname === "/api/assessment/latest") return json({ report: null });
    if (url.pathname === "/api/assessment/list") return json({ reports: [] });
    if (url.pathname === "/api/menu/quick") {
      return json({
        minutes: 6,
        date: "2026-07-11",
        blocks: [{ id: "q1", kind: "warmup-reading", title: "Warm-up", titleKey: "warmup", minutes: 6, params: {} }],
      });
    }
    return json({});
  });
}

test.beforeEach(async ({ page }) => {
  await preparePage(page);
});

test("通常画面はURL・戻る/進む・再読込で現在地を保つ", async ({ page }) => {
  await page.goto("/#/sentences");
  const practice = page.getByRole("button", { name: "Today's practice", exact: true });
  const browse = page.getByRole("button", { name: "Browse", exact: true });
  await expect(practice).toHaveAttribute("aria-pressed", "true");

  await browse.click();
  await expect(page).toHaveURL(/#\/sentences\?tab=browse$/);
  await expect(browse).toHaveAttribute("aria-pressed", "true");
  await page.goBack();
  await expect(page).toHaveURL(/#\/sentences$/);
  await expect(practice).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("button", { name: "Listening", exact: true }).click();
  await expect(page).toHaveURL(/#\/listening$/);
  await expect(page.getByRole("heading", { name: "Listening" })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/#\/listening$/);
  await expect(page.getByRole("heading", { name: "Listening" })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/#\/sentences$/);
  await expect(practice).toHaveAttribute("aria-pressed", "true");
  await page.goForward();
  await expect(page).toHaveURL(/#\/listening$/);
});

test("不明なURLは説明とともにHomeへ戻す", async ({ page }) => {
  await page.goto("/#/not-a-screen");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByText("That address isn't available, so you're back on Home.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
});

test("再読込後のセッションURLは復元不可を説明してHomeへ戻す", async ({ page }) => {
  await page.goto("/#/session");
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByText("An in-progress practice can't be restored after a reload. You're back on Home.", { exact: true })).toBeVisible();
});

test("戻る操作では進行中セッションを確認なしに中断しない", async ({ page }) => {
  await page.goto("/");
  await page.locator(".drill-card").filter({ hasText: "Read-Aloud Warm-up" }).click();
  await expect(page).toHaveURL(/#\/session$/);

  await page.goBack();
  await expect(page).toHaveURL(/#\/session$/);
  await expect(page.getByText("Leave the current practice and open the selected screen?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Keep practicing", exact: true }).click();
  await expect(page).toHaveURL(/#\/session$/);

  await page.goBack();
  await expect(page.getByText("Leave the current practice and open the selected screen?", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Leave practice", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("Tauri webview markerでもhash URLを同じ画面として復元する", async ({ browser }) => {
  const context = await browser.newContext({ userAgent: "Mozilla/5.0 solo-eikaiwa-desktop" });
  const page = await context.newPage();
  await preparePage(page);
  await page.goto("http://127.0.0.1:4173/#/progress");
  await expect(page).toHaveURL(/#\/progress$/);
  await expect(page.getByRole("heading", { name: "Progress" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Progress" })).toBeVisible();
  await context.close();
});
