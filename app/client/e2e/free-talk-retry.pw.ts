import { expect, test, type Page } from "@playwright/test";

type FailureStage = "stt" | "reply" | "audio";

const health = {
  ok: true, whisper: true, ffmpeg: true, claude: true, ttsKey: true, modelFile: true,
  app: "solo-eikaiwa", version: "test", llmReady: true,
};

async function preparePage(page: Page, failure: FailureStage) {
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem("lang", "en");

    const stream = { getTracks: () => [{ stop: () => {} }] };
    class FakeMediaRecorder {
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onstop: (() => void) | null = null;
      constructor(readonly source: MediaStream) {}
      get stream() { return this.source; }
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        queueMicrotask(() => {
          this.ondataavailable?.({ data: new Blob(["recording"], { type: "audio/webm" }) } as BlobEvent);
          this.onstop?.();
        });
      }
    }
    class FakeAudio {
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(_url: string) {}
      play() { queueMicrotask(() => this.onended?.()); return Promise.resolve(); }
      pause() {}
    }
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => stream } });
    Object.defineProperty(window, "MediaRecorder", { configurable: true, value: FakeMediaRecorder });
    Object.defineProperty(window, "Audio", { configurable: true, value: FakeAudio });
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:fake" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  });

  const calls = { stt: 0, reply: 0, audio: 0 };
  await page.route((url) => url.pathname.startsWith("/api/"), async (route) => {
    const url = new URL(route.request().url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (url.pathname === "/api/health") return json(health);
    if (url.pathname === "/api/progress/days") return json({ days: [], xpByDay: {} });
    if (url.pathname === "/api/progress/summary") {
      return json({ level: 1, xp: 0, xpIntoLevel: 0, xpToNext: 100, stage: 1, difficultyMaxed: false, proposal: null });
    }
    if (url.pathname === "/api/placement/latest") return json({ result: null });
    if (url.pathname === "/api/stt") {
      calls.stt++;
      if (failure === "stt" && calls.stt === 1) return json({ error: "unavailable" }, 503);
      return json({ text: "Could you help me?" });
    }
    if (url.pathname === "/api/converse") {
      calls.reply++;
      if (failure === "reply" && calls.reply === 1) return json({ error: "unavailable" }, 503);
      return json({ replyText: "Sure, I can help.", sessionId: "conversation-1" });
    }
    if (url.pathname === "/api/tts") {
      calls.audio++;
      if (failure === "audio" && calls.audio === 1) return json({ error: "unavailable" }, 503);
      return route.fulfill({ contentType: "audio/mpeg", body: "audio" });
    }
    return json({});
  });
  return calls;
}

async function recordOneTurn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Free Talk", exact: true }).click();
  await page.getByRole("button", { name: /Start recording$/ }).click();
  await expect(page.getByRole("button", { name: /Stop and send$/ })).toBeVisible();
  await page.getByRole("button", { name: /Stop and send$/ }).click();
}

test("STT失敗では同じ録音を再試行するか録り直すかを選べる", async ({ page }) => {
  const calls = await preparePage(page, "stt");
  await recordOneTurn(page);

  await expect(page.getByRole("button", { name: "Retry transcription", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Record again", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry transcription", exact: true }).click();
  await expect(page.getByText("Sure, I can help.", { exact: true })).toBeVisible();
  expect(calls.stt).toBe(2);
});

test("会話生成失敗では確定済みの発話を重複させず返答だけ再試行する", async ({ page }) => {
  const calls = await preparePage(page, "reply");
  await recordOneTurn(page);

  await expect(page.getByRole("button", { name: "Retry reply", exact: true })).toBeVisible();
  await expect(page.locator(".chat-row.you")).toHaveCount(1);
  await page.getByRole("button", { name: "Retry reply", exact: true }).click();
  await expect(page.getByText("Sure, I can help.", { exact: true })).toBeVisible();
  await expect(page.locator(".chat-row.you")).toHaveCount(1);
  expect(calls.reply).toBe(2);
});

test("TTS失敗ではAI返答を残し、音声だけ再試行する", async ({ page }) => {
  const calls = await preparePage(page, "audio");
  await recordOneTurn(page);

  await expect(page.getByText("Sure, I can help.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry audio", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Retry audio", exact: true }).click();
  await expect(page.getByRole("button", { name: /Start recording$/ })).toBeVisible();
  expect(calls.reply).toBe(1);
  expect(calls.audio).toBe(2);
});
