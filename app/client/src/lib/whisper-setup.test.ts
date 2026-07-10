import { describe, expect, test } from "bun:test";
import {
  dismissSetupBanner, formatBytes, isDownloadActive, isSetupBannerDismissed, progressPercent,
  resumeSetupBanner, shouldShowSetupBanner, shouldShowSetupResume,
} from "./whisper-setup";

describe("shouldShowSetupBanner", () => {
  test("health.modelFile===falseかつ未読なら表示する", () => {
    expect(shouldShowSetupBanner({ modelFile: false }, false)).toBe(true);
  });

  test("health.modelFile===trueなら表示しない", () => {
    expect(shouldShowSetupBanner({ modelFile: true }, false)).toBe(false);
  });

  test("既読(dismissed=true)ならmodelFile===falseでも表示しない", () => {
    expect(shouldShowSetupBanner({ modelFile: false }, true)).toBe(false);
  });

  test("health自体がnull（未取得/サーバ未応答）なら表示しない", () => {
    expect(shouldShowSetupBanner(null, false)).toBe(false);
  });

  test("旧サーバ応答（modelFileフィールド自体が無い＝undefined）では表示しない（!undefinedがtrueになる誤検知を防ぐ）", () => {
    expect(shouldShowSetupBanner({} as { modelFile?: boolean }, false)).toBe(false);
  });
});

describe("setup banner dismissal", () => {
  test("閉じたセットアップをアプリ内導線から再開できる", () => {
    const values = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
      clear: () => { values.clear(); }, key: () => null, length: 0,
    } as Storage;
    try {
      resumeSetupBanner();
      dismissSetupBanner();
      expect(isSetupBannerDismissed()).toBe(true);
      resumeSetupBanner();
      expect(isSetupBannerDismissed()).toBe(false);
    } finally {
      delete (globalThis as unknown as { localStorage?: Storage }).localStorage;
    }
  });
});

describe("shouldShowSetupResume", () => {
  test("閉じた後も未導入なら常設の再開導線を表示する", () => {
    expect(shouldShowSetupResume({ modelFile: false }, true)).toBe(true);
  });

  test("モデル導入後・未読・旧サーバ応答では表示しない", () => {
    expect(shouldShowSetupResume({ modelFile: true }, true)).toBe(false);
    expect(shouldShowSetupResume({ modelFile: false }, false)).toBe(false);
    expect(shouldShowSetupResume({} as { modelFile?: boolean }, true)).toBe(false);
  });
});

describe("progressPercent", () => {
  test("received/totalの割合を0-100の整数で返す", () => {
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(0, 200)).toBe(0);
    expect(progressPercent(200, 200)).toBe(100);
  });

  test("totalBytesが0以下ならゼロ除算を避けて0を返す", () => {
    expect(progressPercent(10, 0)).toBe(0);
    expect(progressPercent(0, 0)).toBe(0);
  });

  test("received > total（サーバ応答が一瞬ズレるケース）でも100でクランプする", () => {
    expect(progressPercent(210, 200)).toBe(100);
  });
});

describe("formatBytes", () => {
  test("1GB未満はMB表示", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5 MB");
  });

  test("1GB以上はGB表示（小数2桁）", () => {
    expect(formatBytes(1_624_555_275)).toBe("1.51 GB");
  });

  test("不正値（負数/NaN）は0 MBにフォールバックする", () => {
    expect(formatBytes(-5)).toBe("0 MB");
    expect(formatBytes(NaN)).toBe("0 MB");
  });
});

describe("isDownloadActive", () => {
  test("downloading/verifyingはtrue", () => {
    expect(isDownloadActive("downloading")).toBe(true);
    expect(isDownloadActive("verifying")).toBe(true);
  });

  test("idle/done/errorはfalse", () => {
    expect(isDownloadActive("idle")).toBe(false);
    expect(isDownloadActive("done")).toBe(false);
    expect(isDownloadActive("error")).toBe(false);
  });
});
