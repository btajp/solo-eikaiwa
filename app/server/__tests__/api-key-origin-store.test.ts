import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ensureApiKeyOriginSchema,
  makeApiKeyOriginStore,
  resolveOriginBoundSecret,
  resolveOriginBoundSecretWithFixedFallback,
} from "../api-key-origin-store";

describe("api-key-origin-store", () => {
  test("secretごとに承認originをupsert・取得・削除できる", () => {
    const db = new Database(":memory:");
    ensureApiKeyOriginSchema(db);
    const store = makeApiKeyOriginStore(db);

    expect(store.get("OPENAI_COMPAT_API_KEY")).toBeNull();
    store.set("OPENAI_COMPAT_API_KEY", "https://one.example");
    expect(store.get("OPENAI_COMPAT_API_KEY")).toBe("https://one.example");
    store.set("OPENAI_COMPAT_API_KEY", "https://two.example");
    expect(store.get("OPENAI_COMPAT_API_KEY")).toBe("https://two.example");
    store.remove("OPENAI_COMPAT_API_KEY");
    expect(store.get("OPENAI_COMPAT_API_KEY")).toBeNull();
  });

  test("保存originと異なる接続先・非loopback HTTPへは鍵を解決しない", () => {
    const db = new Database(":memory:");
    ensureApiKeyOriginSchema(db);
    const store = makeApiKeyOriginStore(db);
    store.set("OPENAI_COMPAT_API_KEY", "https://models.example");
    const getSecret = () => "sk-secret";

    expect(resolveOriginBoundSecret(
      store, "OPENAI_COMPAT_API_KEY", "https://models.example/v1/chat", getSecret,
    )).toBe("sk-secret");
    expect(resolveOriginBoundSecret(
      store, "OPENAI_COMPAT_API_KEY", "https://other.example/v1", getSecret,
    )).toBeUndefined();
    store.set("OPENAI_COMPAT_API_KEY", "http://192.168.1.10:11434");
    expect(resolveOriginBoundSecret(
      store, "OPENAI_COMPAT_API_KEY", "http://192.168.1.10:11434/v1", getSecret,
    )).toBeUndefined();
  });

  test("origin-bound鍵が設定済みなら未承認時も固定fallback鍵へ切り替えない", () => {
    const db = new Database(":memory:");
    ensureApiKeyOriginSchema(db);
    const store = makeApiKeyOriginStore(db);
    const fixed = "https://api.openai.com/v1";

    expect(resolveOriginBoundSecretWithFixedFallback(
      store, "TTS_API_KEY", fixed, () => "sk-unapproved-tts", fixed, () => "sk-legacy",
    )).toBeUndefined();
    expect(resolveOriginBoundSecretWithFixedFallback(
      store, "TTS_API_KEY", fixed, () => undefined, fixed, () => "sk-legacy",
    )).toBe("sk-legacy");
    expect(resolveOriginBoundSecretWithFixedFallback(
      store, "TTS_API_KEY", "https://other.example/v1", () => undefined, fixed, () => "sk-legacy",
    )).toBeUndefined();

    store.set("TTS_API_KEY", "https://api.openai.com");
    expect(resolveOriginBoundSecretWithFixedFallback(
      store, "TTS_API_KEY", fixed, () => "sk-approved-tts", fixed, () => "sk-legacy",
    )).toBe("sk-approved-tts");
  });
});
