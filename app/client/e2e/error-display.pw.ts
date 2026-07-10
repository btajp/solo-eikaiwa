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

test("設定取得の内部エラーを日本語の再試行案内へ変換する", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("lang", "ja");
  });
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

    if (pathname === "/api/health") return json(health);
    if (pathname === "/api/progress/days") return json({ days: [], xpByDay: {} });
    if (pathname === "/api/progress/summary") {
      return json({ level: 1, xp: 0, xpIntoLevel: 0, xpToNext: 100, stage: 1, difficultyMaxed: false, proposal: null });
    }
    if (pathname === "/api/placement/latest") return json({ result: null });
    if (pathname === "/api/llm-settings") {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "llm role settings save failed: API_KEY=secret-value at /Users/example/private" }),
      });
    }
    if (pathname === "/api/tts-settings") {
      return json({
        provider: "auto", baseUrl: null, model: null, voice: null, apiKeyConfigured: false,
        defaults: { baseUrl: "http://127.0.0.1:8880/v1", model: "gpt-4o-mini-tts", voice: "alloy" },
      });
    }
    if (pathname === "/api/secrets") {
      return json({
        ANTHROPIC_API_KEY: { configured: false, source: null },
        CODEX_API_KEY: { configured: false, source: null },
        OPENAI_COMPAT_API_KEY: { configured: false, source: null },
        TTS_API_KEY: { configured: false, source: null },
      });
    }
    return json({});
  });

  await page.goto("/");
  await page.getByRole("button", { name: "設定", exact: true }).click();

  const alert = page.getByRole("alert").first();
  await expect(alert).toContainText("モデル接続設定を取得できませんでした。設定は変更していません。");
  await expect(alert).toContainText("参照番号:");
  await expect(page.getByText("secret-value", { exact: false })).toHaveCount(0);
  await expect(page.getByText("llm role settings save failed", { exact: false })).toHaveCount(0);
  await expect(page.getByText("/Users/example/private", { exact: false })).toHaveCount(0);
});
