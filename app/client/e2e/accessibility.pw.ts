import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const practiceDays = ["2026-07-09", "2026-07-10"];
const metricsDay = (ymd: string, speakingSec: number, avgArticulationWpm: number) => ({
  ymd,
  utterances: 1,
  words: 20,
  speechMs: speakingSec * 1_000,
  totalMs: speakingSec * 1_100,
  pauseMs: speakingSec * 100,
  repetitionWords: 0,
  repetitionWeightedWords: 0,
  speakingSec,
  avgArticulationWpm,
  avgPauseRatio: 0.1,
  repetitionRatio: 0,
});
const metrics = [metricsDay("2026-07-09", 480, 90), metricsDay("2026-07-10", 720, 110)];

const inheritRole = { provider: "inherit", baseUrl: null, model: null, codexModel: null };
const noTuning = { claudeModel: null, effort: null, serviceTier: null };
const llmSettings = {
  provider: "claude", baseUrl: null, model: null, openaiModel: null, codexModel: null,
  apiKeyConfigured: false, apiKeyApproved: false, openAiKeyConfigured: false,
  roles: { conversation: inheritRole, assist: inheritRole, coaching: inheritRole, generation: inheritRole, assessment: inheritRole },
  globalTuning: noTuning,
  tuning: { conversation: noTuning, assist: noTuning, coaching: noTuning, generation: noTuning, assessment: noTuning },
  authModes: { claude: "subscription", codex: "subscription" },
  authKeys: { anthropic: true, codex: false },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("lang", "en");
  });
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const { pathname } = new URL(route.request().url());
    const json = (body: unknown) => route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });

    if (pathname === "/api/health") {
      return json({ ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: true, app: "solo-eikaiwa", version: "test", llmReady: true });
    }
    if (pathname === "/api/progress/days") {
      return json({ days: practiceDays, xpByDay: { "2026-07-09": 20, "2026-07-10": 45 } });
    }
    if (pathname === "/api/progress/summary") {
      return json({ level: 1, xp: 65, xpIntoLevel: 65, xpToNext: 35, stage: 1, difficultyMaxed: false, proposal: null });
    }
    if (pathname === "/api/placement/latest") return json({ result: null });
    if (pathname === "/api/metrics/summary") {
      return json({
        days: metrics,
        weekly: { current: metrics[1], previous: metrics[0] },
        level: { current: 1, history: [] },
      });
    }
    if (pathname === "/api/assessment/latest") return json({ report: null });
    if (pathname === "/api/assessment/list") return json({ reports: [] });
    if (pathname === "/api/llm-settings") return json(llmSettings);
    if (pathname === "/api/tts-settings") {
      return json({
        provider: "say", baseUrl: null, model: null, voice: null, openaiModel: null, openaiVoice: null,
        apiKeyConfigured: false, apiKeyApproved: false,
        defaults: { baseUrl: "http://127.0.0.1:8880/v1", model: "gpt-4o-mini-tts", voice: "alloy" },
      });
    }
    if (pathname === "/api/secrets") {
      return json({
        ANTHROPIC_API_KEY: { configured: false, source: null },
        CODEX_API_KEY: { configured: false, source: null },
        OPENAI_API_KEY: { configured: false, source: null },
        OPENAI_COMPAT_API_KEY: { configured: false, source: null },
        TTS_API_KEY: { configured: false, source: null },
      });
    }
    return json({});
  });
});

async function expectNoSeriousViolations(page: import("@playwright/test").Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter(({ impact }) => impact === "serious" || impact === "critical");
  expect(serious).toEqual([]);
}

test("言語・状態・代替テキストを支援技術へ伝える", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Home" })).toHaveAttribute("aria-current", "page");
  const github = page.getByRole("link", { name: "GitHub repository (opens in a new tab)", exact: true });
  const website = page.getByRole("link", { name: "Official website (opens in a new tab)", exact: true });
  await expect(github).toHaveAttribute("href", "https://github.com/btajp/solo-eikaiwa");
  await expect(website).toHaveAttribute("href", "https://btajp.github.io/solo-eikaiwa/");
  for (const link of [github, website]) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  await expect(page.getByText("© 2026 BTAJP. All Rights Reserved. Licensed under the MIT License.", { exact: true })).toBeVisible();
  await expect(page.getByText("Practice recorded on 2 days.", { exact: true })).toBeAttached();
  await expect(page.getByText("July 9, 2026 · 20 XP", { exact: true })).toBeAttached();
  await expectNoSeriousViolations(page);

  await page.getByRole("button", { name: "日本語", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  await expect(page.getByRole("button", { name: "日本語", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("link", { name: "GitHub リポジトリ（新しいタブで開く）", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "公式ウェブサイト（新しいタブで開く）", exact: true })).toBeVisible();
  await expect(page.getByText("練習を記録した日: 2日。", { exact: true })).toBeAttached();
  await expectNoSeriousViolations(page);

  await page.getByRole("button", { name: "EN", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(page.getByRole("button", { name: "EN", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.reload();
  await expect(page.getByRole("button", { name: "Home" })).toBeVisible();
  await expectNoSeriousViolations(page);

  await page.getByRole("button", { name: "Progress" }).click();
  await expect(page.getByText("July 9, 2026: 8.0 minutes of speaking", { exact: true })).toBeAttached();
  // 遷移通知の live region（.shell 直下）が加わったため、進捗画面内の代替テキストは main 配下で数える
  await expect(page.locator("main .visually-hidden").nth(1)).toContainText("July 10, 2026: 110 words per minute");
  await expectNoSeriousViolations(page);
});

// #210: SPA遷移の通知（タイトル・フォーカス移動・live region）
test("SPA遷移でタイトルが変わり、フォーカス移動とlive region通知が行われる", async ({ page }) => {
  const liveRegion = page.locator(".shell > .visually-hidden[role=\"status\"]");
  await page.goto("/");
  await expect(page).toHaveTitle("Home — solo-eikaiwa");
  await expect(liveRegion).toHaveText(""); // 初回表示では読み上げない

  await page.getByRole("button", { name: "Progress", exact: true }).click();
  await expect(page).toHaveTitle("Progress — solo-eikaiwa");
  await expect(page.locator("main.app")).toBeFocused();
  await expect(liveRegion).toHaveText("Moved to Progress.");

  await page.goBack();
  await expect(page).toHaveTitle("Home — solo-eikaiwa");
  await expect(page.locator("main.app")).toBeFocused();
  await expect(liveRegion).toHaveText("Moved to Home.");

  await page.goForward();
  await expect(page).toHaveTitle("Progress — solo-eikaiwa");
  await expect(liveRegion).toHaveText("Moved to Progress.");

  await page.getByRole("button", { name: "日本語", exact: true }).click();
  await expect(page).toHaveTitle("進捗 — solo-eikaiwa"); // タイトルはUI言語に追従する
});

// #185/#211: 設定タブのARIA準拠（roving tabindex・矢印/Home/End・tab/tabpanel関連・deep link）
test("設定タブは矢印キーで操作でき、学習者向けの表示タブが既定になる", async ({ page }) => {
  await page.goto("/#/settings");
  const tablist = page.getByRole("tablist", { name: "Settings" });
  const keysTab = tablist.getByRole("tab", { name: "API keys" });
  const connTab = tablist.getByRole("tab", { name: "Model connections" });
  const rolesTab = tablist.getByRole("tab", { name: "Model per role" });
  const displayTab = tablist.getByRole("tab", { name: "Display" });

  // 既定は学習者向けの表示タブ。tab/tabpanel がIDで関連づく
  await expect(displayTab).toHaveAttribute("aria-selected", "true");
  await expect(displayTab).toHaveAttribute("aria-controls", "settings-panel-display");
  const displayPanel = page.locator("#settings-panel-display");
  await expect(displayPanel).toHaveAttribute("role", "tabpanel");
  await expect(displayPanel).toHaveAttribute("aria-labelledby", "settings-tab-display");
  await expect(displayPanel.getByRole("group", { name: "Text size" })).toBeVisible();

  // roving tabindex: 選択タブだけが tab stop
  await expect(displayTab).toHaveAttribute("tabindex", "0");
  for (const inactive of [keysTab, connTab, rolesTab]) {
    await expect(inactive).toHaveAttribute("tabindex", "-1");
  }

  // 右矢印は末尾から先頭へ折り返し、選択がフォーカスに追従する（URLも deep link 可能な形で更新）
  await displayTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(keysTab).toBeFocused();
  await expect(keysTab).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(/#\/settings\?tab=keys$/);
  await expect(page.locator("#settings-panel-keys")).toBeVisible();

  await page.keyboard.press("End");
  await expect(displayTab).toBeFocused();
  await expect(displayTab).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("ArrowLeft");
  await expect(rolesTab).toBeFocused();
  await expect(rolesTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#settings-panel-roles")).toBeVisible();

  await page.keyboard.press("Home");
  await expect(keysTab).toBeFocused();
  await expect(keysTab).toHaveAttribute("aria-selected", "true");
  await expectNoSeriousViolations(page);

  // APIキー等への直接導線（deep link）は維持される
  await page.goto("/#/settings?tab=conn");
  await expect(connTab).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#settings-panel-conn")).toBeVisible();
  await expectNoSeriousViolations(page);
});

// #211: whisperセットアップのモデル選択（radiogroup）も宣言どおり矢印キーで動く
test("whisperセットアップのモデル選択は矢印キーで切り替えられる", async ({ page }) => {
  await page.route("**/api/health", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: false, app: "solo-eikaiwa", version: "test", llmReady: true }),
  }));
  await page.route("**/api/setup/status", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      status: "idle", model: null, receivedBytes: 0, totalBytes: 0, error: null,
      resumable: false, diskFreeBytes: 100_000_000_000, models: { "large-v3-turbo": false, small: false },
    }),
  }));
  await page.goto("/");

  const group = page.getByRole("radiogroup", { name: "Model" });
  const large = group.getByRole("radio", { name: "Recommended (1.6 GB)" });
  const small = group.getByRole("radio", { name: "Lightweight (0.5 GB)" });
  await expect(large).toHaveAttribute("aria-checked", "true");
  await expect(large).toHaveAttribute("tabindex", "0");
  await expect(small).toHaveAttribute("tabindex", "-1");

  await large.focus();
  await page.keyboard.press("ArrowRight");
  await expect(small).toBeFocused();
  await expect(small).toHaveAttribute("aria-checked", "true");
  await expect(large).toHaveAttribute("tabindex", "-1");

  await page.keyboard.press("ArrowDown"); // 端では折り返す
  await expect(large).toBeFocused();
  await expect(large).toHaveAttribute("aria-checked", "true");
  await expectNoSeriousViolations(page);
});

test("狭幅でもすべての主ナビゲーションをキーボードで操作できる", async ({ page }) => {
  await page.goto("/");
  const navigation = page.getByRole("navigation", { name: "Main navigation" });
  const navigationLabels = ["Home", "Free Talk", "390 Sentences", "Listening", "Level Check", "Model Talks", "Progress", "Practice reactions", "Settings"];

  for (const width of [320, 375, 640, 860]) {
    await page.setViewportSize({ width, height: 800 });
    for (const label of navigationLabels) {
      const item = navigation.getByRole("button", { name: label, exact: true });
      await expect(item).toBeVisible();
      await item.focus();
      await expect(item).toBeFocused();
      await expect(item).toBeInViewport();
    }
    for (const label of ["GitHub repository (opens in a new tab)", "Official website (opens in a new tab)"]) {
      const link = page.getByRole("link", { name: label, exact: true });
      await expect(link).toBeVisible();
      await link.focus();
      await expect(link).toBeFocused();
      await expect(link).toBeInViewport();
    }
  }
});
