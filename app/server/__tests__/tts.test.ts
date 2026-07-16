import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cacheKeyFor, httpCacheKeyFor, synthesize, resolveTtsConfig, TtsTimeoutError,
  DEFAULT_TTS_BASE_URL, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, DEFAULT_TTS_CACHE_MAX_BYTES,
} from "../tts";
import { ensureTtsProviderSchema, makeTtsProviderStore } from "../tts-provider-store";

/**
 * Bun.env.OPENAI_API_KEY を一時的に取り除いた状態で fn を実行し、
 * 実行結果に関わらず元の値へ復元する。
 * 「キー不在」の挙動を、実行環境に実キーが設定されていても再現できるようにする。
 */
async function withNoApiKey<T>(fn: () => Promise<T>): Promise<T> {
  const saved = Bun.env.OPENAI_API_KEY;
  delete Bun.env.OPENAI_API_KEY;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete Bun.env.OPENAI_API_KEY;
    else Bun.env.OPENAI_API_KEY = saved;
  }
}

// say が生成するはずの出力ファイルを偽造する共通フェイク。
function makeFakeSpawn(spawned: string[][]) {
  return async (cmd: string[], options?: { signal?: AbortSignal }) => {
    spawned.push(cmd);
    const oIdx = cmd.indexOf("-o");
    expect(oIdx).toBeGreaterThanOrEqual(0);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    const out = cmd[oIdx + 1]!;
    await Bun.write(out, new Uint8Array([9, 9]));
    return { exitCode: 0, stderr: "" };
  };
}

describe("tts", () => {
  test("cacheKeyFor は model/voice/text で決まる64桁hex", () => {
    const k1 = cacheKeyFor("gpt-4o-mini-tts", "alloy", "Hello");
    const k2 = cacheKeyFor("gpt-4o-mini-tts", "alloy", "Hello");
    const k3 = cacheKeyFor("gpt-4o-mini-tts", "nova", "Hello");
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("HTTP cache keyはschema/provider/正規化base URL/model/voiceを分離する", () => {
    const cfg = { baseUrl: "https://api.openai.com/v1", model: "m", voice: "v" };
    const key = httpCacheKeyFor("openai", cfg, "Hello");
    expect(key).toBe(httpCacheKeyFor("openai", { ...cfg, baseUrl: "https://api.openai.com/v1/" }, "Hello"));
    expect(key).not.toBe(httpCacheKeyFor("openai-compat", cfg, "Hello"));
    expect(key).not.toBe(httpCacheKeyFor("openai", { ...cfg, baseUrl: "https://other.example/v1" }, "Hello"));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("同梱音声があれば APIキーなしでも say に落ちず openai として返す", async () => {
    const bundledDir = mkdtempSync(path.join(tmpdir(), "tts-bundle-"));
    const key = cacheKeyFor("gpt-4o-mini-tts", "alloy", "Bundled sentence");
    await Bun.write(path.join(bundledDir, `${key}.mp3`), new Uint8Array([7, 7, 7]));
    const spawned: string[][] = [];
    const r = await withNoApiKey(() =>
      synthesize("Bundled sentence", { bundledDir, spawnFn: makeFakeSpawn(spawned), env: {} }),
    );
    expect(r.engine).toBe("openai");
    expect(Array.from(r.audio)).toEqual([7, 7, 7]);
    expect(spawned).toHaveLength(0);
  });

  test("同梱音声は API 呼び出しより優先される", async () => {
    const bundledDir = mkdtempSync(path.join(tmpdir(), "tts-bundle-"));
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const key = cacheKeyFor("gpt-4o-mini-tts", "alloy", "Bundled first");
    await Bun.write(path.join(bundledDir, `${key}.mp3`), new Uint8Array([5]));
    const fakeFetch = (async () => {
      throw new Error("API must not be called when bundled audio exists");
    }) as unknown as typeof fetch;
    const r = await synthesize("Bundled first", { apiKey: "sk-test", bundledDir, cacheDir, fetchFn: fakeFetch, env: {} });
    expect(r.engine).toBe("openai");
    expect(Array.from(r.audio)).toEqual([5]);
  });

  test("provider=sayでも既定ラベルの同梱音声を優先し say を起動しない", async () => {
    const bundledDir = mkdtempSync(path.join(tmpdir(), "tts-bundle-"));
    const key = cacheKeyFor(DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, "Use say");
    await Bun.write(path.join(bundledDir, `${key}.mp3`), new Uint8Array([5]));
    const spawned: string[][] = [];

    const result = await synthesize("Use say", {
      provider: "say", bundledDir, spawnFn: makeFakeSpawn(spawned), env: {},
    });

    expect(result.engine).toBe("openai");
    expect(Array.from(result.audio)).toEqual([5]);
    expect(spawned).toHaveLength(0);
  });

  test("provider=say: 同梱に無いテキストは macOS say で合成する（HTTP は呼ばない）", async () => {
    const bundledDir = mkdtempSync(path.join(tmpdir(), "tts-bundle-"));
    const spawned: string[][] = [];
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls++;
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await synthesize("Not bundled text", {
      provider: "say", bundledDir, spawnFn: makeFakeSpawn(spawned), fetchFn: fakeFetch, env: {},
    });

    expect(result.engine).toBe("say");
    expect(Array.from(result.audio)).toEqual([9, 9]);
    expect(spawned).toHaveLength(1);
    expect(fetchCalls).toBe(0);
  });

  test("APIキーがあれば OpenAI を呼び、2回目はキャッシュを使う", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;

    const r1 = await synthesize("Hello there", { apiKey: "sk-test", cacheDir, fetchFn: fakeFetch, env: {} });
    const r2 = await synthesize("Hello there", { apiKey: "sk-test", cacheDir, fetchFn: fakeFetch, env: {} });
    expect(calls).toBe(1);
    expect(r1.engine).toBe("openai");
    expect(r1.mime).toBe("audio/mpeg");
    expect(Array.from(r2.audio)).toEqual([1, 2, 3]);
    expect(readdirSync(cacheDir)).toHaveLength(1);
  });

  test("同梱生成modeは凍結済みlegacy keyへ原子的に保存する", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-bundled-generate-"));
    const text = "New bundled sentence";
    const legacyPath = path.join(cacheDir, `${cacheKeyFor(DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, text)}.mp3`);
    const fakeFetch = (async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 })) as unknown as typeof fetch;

    await synthesize(text, {
      apiKey: "sk-test", cacheDir, cacheTarget: "bundled", fetchFn: fakeFetch, env: {},
    });

    expect(existsSync(legacyPath)).toBe(true);
    expect(readdirSync(cacheDir)).toEqual([path.basename(legacyPath)]);
  });

  test("APIキーが無ければ say フォールバックで生成する", async () => {
    await withNoApiKey(async () => {
      const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
      const spawned: string[][] = [];
      const r = await synthesize("Hello", { apiKey: undefined, cacheDir, spawnFn: makeFakeSpawn(spawned), env: {} });
      expect(r.engine).toBe("say");
      expect(r.mime).toBe("audio/mp4");
      expect(spawned[0][0]).toBe("say");
      expect(spawned).toHaveLength(1);
      expect(spawned[0]).toContain("--data-format=aac");
      expect(spawned[0].some((arg) => arg.endsWith(".m4a"))).toBe(true);
    });
  });

  test("OpenAI が実行時エラー（非200）でも say にフォールバックしてセッションを継続する", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const spawned: string[][] = [];

    const r = await synthesize("Hello", {
      apiKey: "sk-test", cacheDir, fetchFn: fakeFetch, spawnFn: makeFakeSpawn(spawned), env: {},
    });
    expect(r.engine).toBe("say");
    expect(Array.from(r.audio)).toEqual([9, 9]);
    expect(spawned[0][0]).toBe("say");
  });

  test("OpenAI の fetch 自体が例外を投げても say にフォールバックする", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const fakeFetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const spawned: string[][] = [];

    const r = await synthesize("Hello", {
      apiKey: "sk-test", cacheDir, fetchFn: fakeFetch, spawnFn: makeFakeSpawn(spawned), env: {},
    });
    expect(r.engine).toBe("say");
    expect(Array.from(r.audio)).toEqual([9, 9]);
  });

  test("OpenAI も say も失敗したら synthesize は reject する", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const fakeSpawn = async (_cmd: string[]) => ({ exitCode: 1, stderr: "say not available" });

    await expect(
      synthesize("Hello", { apiKey: "sk-test", cacheDir, fetchFn: fakeFetch, spawnFn: fakeSpawn, env: {} }),
    ).rejects.toThrow();
  });

  test("cacheDir がファイルでキャッシュ書き込みに失敗しても合成結果は返る", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "tts-"));
    const cacheDirAsFile = path.join(parent, "not-a-dir");
    await Bun.write(cacheDirAsFile, "im a file, not a directory");
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(new Uint8Array([4, 2, 0]), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await synthesize("Cache write failure text", {
      apiKey: "sk-test", cacheDir: cacheDirAsFile, fetchFn: fakeFetch, env: {},
    });
    expect(r.engine).toBe("openai");
    expect(Array.from(r.audio)).toEqual([4, 2, 0]);
    expect(calls).toBe(1);
  });

  test("cache書き込み失敗では一時・最終ファイルを残さず、次回は再合成する", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-atomic-"));
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls++;
      return new Response(new Uint8Array([4, 2, 0]), { status: 200 });
    }) as unknown as typeof fetch;
    const failingWrite = async (filePath: string, data: Uint8Array) => {
      await Bun.write(filePath, data.slice(0, 1));
      throw new Error("ENOSPC");
    };

    await synthesize("Atomic cache", {
      apiKey: "sk-test", cacheDir, fetchFn: fakeFetch, cacheWriteFn: failingWrite, env: {},
    });
    expect(readdirSync(cacheDir)).toEqual([]);
    await synthesize("Atomic cache", {
      apiKey: "sk-test", cacheDir, fetchFn: fakeFetch, cacheWriteFn: failingWrite, env: {},
    });
    expect(fetchCalls).toBe(2);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  test("cache参照時に強制終了で残った一時ファイルを掃除する", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-stale-"));
    const stale = path.join(cacheDir, "old.mp3.tmp-123-dead");
    await Bun.write(stale, new Uint8Array([1]));
    const fakeFetch = (async () => new Response(new Uint8Array([2]), { status: 200 })) as unknown as typeof fetch;

    await synthesize("Clean stale", { apiKey: "sk-test", cacheDir, fetchFn: fakeFetch, env: {} });

    expect(existsSync(stale)).toBe(false);
    expect(readdirSync(cacheDir).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  test("HTTP timeoutはfetchをabortし、sayへ継続せず総deadlineで終了する", async () => {
    let fetchSignal: AbortSignal | null | undefined;
    let spawnCalls = 0;
    const hangingFetch = ((_url: string, init: RequestInit) => {
      fetchSignal = init.signal;
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    }) as unknown as typeof fetch;

    await expect(synthesize("Timeout", {
      apiKey: "sk-test",
      fetchFn: hangingFetch,
      spawnFn: async () => { spawnCalls++; return { exitCode: 0, stderr: "" }; },
      timeoutMs: 5,
      env: {},
    })).rejects.toBeInstanceOf(TtsTimeoutError);
    expect(fetchSignal?.aborted).toBe(true);
    expect(spawnCalls).toBe(0);
  });

  test("sayのcancelでも一時ディレクトリを必ず削除する", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "tts-say-cancel-"));
    const controller = new AbortController();
    let spawnSignal: AbortSignal | undefined;
    const hangingSpawn = async (_cmd: string[], options?: { signal?: AbortSignal }) => {
      spawnSignal = options?.signal;
      return new Promise<{ exitCode: number; stderr: string }>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
    };
    const running = synthesize("Cancel say", {
      provider: "say", spawnFn: hangingSpawn, signal: controller.signal, tempRoot, env: {},
    });
    await Promise.resolve();
    controller.abort(new Error("cancel say"));

    await expect(running).rejects.toThrow("cancel say");
    expect(spawnSignal?.aborted).toBe(true);
    expect(readdirSync(tempRoot)).toEqual([]);
  });

  test("say 実行時、先頭が「-」のテキストも argv に直接渡らずファイル経由になる（引数インジェクション対策）", async () => {
    await withNoApiKey(async () => {
      const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
      const text = "- dash leading text";
      const spawned: string[][] = [];
      const fakeSpawn = async (cmd: string[]) => {
        spawned.push(cmd);
        if (cmd[0] === "say") {
          const fIdx = cmd.indexOf("-f");
          expect(fIdx).toBeGreaterThanOrEqual(0);
          const textFile = cmd[fIdx + 1];
          expect(readFileSync(textFile, "utf8")).toBe(text);
        }
        const oIdx = cmd.indexOf("-o");
        const out = oIdx >= 0 ? cmd[oIdx + 1] : cmd[cmd.length - 2];
        await Bun.write(out, new Uint8Array([1]));
        return { exitCode: 0, stderr: "" };
      };

      const r = await synthesize(text, { apiKey: undefined, cacheDir, spawnFn: fakeSpawn, env: {} });
      expect(r.engine).toBe("say");
      for (const arg of spawned[0]) {
        expect(arg).not.toBe(text);
      }
    });
  });
});

describe("tts provider config", () => {
  test("明示した OpenAI 公式が失敗しても say へ黙って切り替えない", async () => {
    let spawnCalls = 0;
    await expect(synthesize("No fallback", {
      provider: "openai",
      apiKey: "sk-test",
      fetchFn: (async () => new Response("failed", { status: 500 })) as unknown as typeof fetch,
      spawnFn: async () => { spawnCalls++; return { exitCode: 0, stderr: "" }; },
      cacheDir: mkdtempSync(path.join(tmpdir(), "tts-")),
      env: {},
    })).rejects.toThrow(/TTS HTTP failed/);
    expect(spawnCalls).toBe(0);
  });

  test("resolveTtsConfig: 未指定なら既定（OpenAI/gpt-4o-mini-tts/alloy）に解決し鍵は env フォールバック", () => {
    const cfg = resolveTtsConfig({}, { OPENAI_API_KEY: "sk-openai" });
    expect(cfg).toEqual({
      baseUrl: DEFAULT_TTS_BASE_URL, model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE, apiKey: "sk-openai",
    });
  });

  test("resolveTtsConfig: opts > 既定 の2層で解決し、env の TTS_BASE_URL/TTS_MODEL/TTS_VOICE は読まない（envフォールバック廃止）", () => {
    const cfg = resolveTtsConfig(
      { baseUrl: "http://opts:8880/v1" },
      { TTS_BASE_URL: "http://env:8880/v1", TTS_MODEL: "kokoro", TTS_VOICE: "af_sky", TTS_API_KEY: "sk-tts" },
    );
    expect(cfg).toEqual({ baseUrl: "http://opts:8880/v1", model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE, apiKey: "sk-tts" });
  });

  test("resolveTtsConfig: TTS_API_KEY は OPENAI_API_KEY より優先する", () => {
    const cfg = resolveTtsConfig({}, { TTS_API_KEY: "sk-tts", OPENAI_API_KEY: "sk-openai" });
    expect(cfg.apiKey).toBe("sk-tts");
  });

  test("既定 + 鍵ありは https://api.openai.com/v1/audio/speech を gpt-4o-mini-tts/alloy/mp3 で叩く（現行不変）", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let captured: { url: string; headers: Record<string, string>; body: unknown } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await synthesize("Speak this", { apiKey: "sk-test", cacheDir, fetchFn: fakeFetch, env: {} });
    expect(r.engine).toBe("openai");
    expect(captured!.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(captured!.headers["Authorization"]).toBe("Bearer sk-test");
    expect(captured!.body).toEqual({ model: "gpt-4o-mini-tts", voice: "alloy", input: "Speak this", response_format: "mp3" });
  });

  test("既定 + 鍵なしは HTTP 層を飛ばして say（fetch 未呼び出し）", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let called = 0;
    const fakeFetch = (async () => { called++; return new Response(new Uint8Array([1]), { status: 200 }); }) as unknown as typeof fetch;
    const spawned: string[][] = [];
    const r = await synthesize("Hello", { cacheDir, fetchFn: fakeFetch, spawnFn: makeFakeSpawn(spawned), env: {} });
    expect(called).toBe(0);
    expect(r.engine).toBe("say");
  });

  test("baseUrl がカスタムなら鍵なしでも HTTP を試す・Authorization は付けない", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let captured: { url: string; headers: Record<string, string> } | null = null;
    const fakeFetch = (async (url: string, init: RequestInit) => {
      captured = { url, headers: init.headers as Record<string, string> };
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await synthesize("Local voice", {
      cacheDir, fetchFn: fakeFetch, baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky", env: {},
    });
    expect(r.engine).toBe("openai");
    expect(captured!.url).toBe("http://localhost:8880/v1/audio/speech");
    expect("Authorization" in captured!.headers).toBe(false);
    expect(Array.from(r.audio)).toEqual([9, 9, 9]);
  });

  test("非loopback HTTPには明示apiKeyも送らず、redirectを追従しない", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let captured: RequestInit | null = null;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      captured = init;
      return new Response(new Uint8Array([8]), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await synthesize("Unsafe target", {
      provider: "openai-compat",
      apiKey: "must-not-leak",
      baseUrl: "http://192.168.1.10:8880/v1",
      cacheDir,
      fetchFn: fakeFetch,
      env: {},
    });
    expect(r.engine).toBe("openai");
    expect((captured!.headers as Record<string, string>).Authorization).toBeUndefined();
    expect(captured!.redirect).toBe("error");
  });

  test("provider=say: 鍵あり・カスタムbaseUrlでも HTTP を飛ばして常に say", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let called = 0;
    const fakeFetch = (async () => { called++; return new Response(new Uint8Array([1]), { status: 200 }); }) as unknown as typeof fetch;
    const spawned: string[][] = [];
    const r = await synthesize("Force say", {
      provider: "say", apiKey: "sk-test", baseUrl: "http://localhost:8880/v1",
      cacheDir, fetchFn: fakeFetch, spawnFn: makeFakeSpawn(spawned), env: {},
    });
    expect(called).toBe(0);
    expect(r.engine).toBe("say");
    expect(spawned.length).toBeGreaterThan(0);
  });

  test("provider=openai-compat: 鍵なし・既定baseUrlでも HTTP を試す（暗黙判定をスキップ）", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    let called = 0;
    const fakeFetch = (async () => { called++; return new Response(new Uint8Array([4, 4]), { status: 200 }); }) as unknown as typeof fetch;
    const r = await synthesize("Force http", { provider: "openai-compat", cacheDir, fetchFn: fakeFetch, env: {} });
    expect(called).toBe(1);
    expect(r.engine).toBe("openai");
  });

  test("provider=openai-compat: HTTP 失敗時は say へ黙って切り替えない", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    let spawnCalls = 0;
    await expect(synthesize("Broken http", {
      provider: "openai-compat", cacheDir, fetchFn: fakeFetch,
      spawnFn: async () => { spawnCalls++; return { exitCode: 0, stderr: "" }; }, env: {},
    })).rejects.toThrow(/TTS HTTP failed/);
    expect(spawnCalls).toBe(0);
  });

  test("カスタム model/voice は cacheKeyFor が変わり同梱バンドルにヒットせず HTTP を叩く", async () => {
    // 既定キーで bundled ファイルを置くが、カスタム voice では別キーになりミスする
    const bundledDir = mkdtempSync(path.join(tmpdir(), "tts-bundle-"));
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const defaultKey = cacheKeyFor(DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, "Shared text");
    await Bun.write(path.join(bundledDir, `${defaultKey}.mp3`), new Uint8Array([7]));
    let called = 0;
    const fakeFetch = (async () => { called++; return new Response(new Uint8Array([2, 2]), { status: 200 }); }) as unknown as typeof fetch;
    const r = await synthesize("Shared text", {
      bundledDir, cacheDir, fetchFn: fakeFetch,
      baseUrl: "http://localhost:8880/v1", model: "kokoro", voice: "af_sky", env: {},
    });
    expect(called).toBe(1); // バンドルはミス → HTTP を叩いた
    expect(Array.from(r.audio)).toEqual([2, 2]);
  });

  test("カスタムendpointは既定model/voiceと同じ名前でも同梱音声へ短絡しない", async () => {
    const bundledDir = mkdtempSync(path.join(tmpdir(), "tts-bundle-"));
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const bundledKey = cacheKeyFor(DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, "Same labels");
    await Bun.write(path.join(bundledDir, `${bundledKey}.mp3`), new Uint8Array([7]));
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(new Uint8Array([3]), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await synthesize("Same labels", {
      bundledDir, cacheDir, fetchFn: fakeFetch,
      baseUrl: "http://localhost:8880/v1", model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE, env: {},
    });

    expect(calls).toBe(1);
    expect(Array.from(result.audio)).toEqual([3]);
  });

  test("providerまたはendpoint変更後は同じtext/model/voiceでも旧HTTP cacheを返さない", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-isolation-"));
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(new Uint8Array([calls]), { status: 200 });
    }) as unknown as typeof fetch;

    await synthesize("Shared labels", { provider: "openai", apiKey: "sk", cacheDir, fetchFn: fakeFetch, env: {} });
    await synthesize("Shared labels", {
      provider: "openai-compat", apiKey: "sk", cacheDir, fetchFn: fakeFetch, env: {},
    });
    await synthesize("Shared labels", {
      provider: "openai-compat", baseUrl: "http://localhost:8880/v1",
      model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE, cacheDir, fetchFn: fakeFetch, env: {},
    });

    expect(calls).toBe(3);
    expect(readdirSync(cacheDir)).toHaveLength(3);
  });

  test("既定解決（設定行なし・キーなし→say）でも同梱音声にヒットし、sayもHTTPも呼ばれない", async () => {
    // index.ts の resolveLegacy と同じ既定解決を再現する:
    // tts_provider_settings 行なし・互換baseUrlなし・公式キーなし → "say"
    const db = new Database(":memory:");
    ensureTtsProviderSchema(db);
    const store = makeTtsProviderStore(db, () => "say");
    expect(store.get()).toBe("say");

    const bundledDir = mkdtempSync(path.join(tmpdir(), "tts-bundle-"));
    const key = cacheKeyFor(DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE, "Fresh install sentence");
    await Bun.write(path.join(bundledDir, `${key}.mp3`), new Uint8Array([6, 6]));
    const spawned: string[][] = [];
    let fetchCalls = 0;
    const fakeFetch = (async () => {
      fetchCalls++;
      return new Response(new Uint8Array([1]), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await synthesize("Fresh install sentence", {
      provider: store.get(), bundledDir, spawnFn: makeFakeSpawn(spawned), fetchFn: fakeFetch, env: {},
    });

    expect(r.engine).toBe("openai");
    expect(Array.from(r.audio)).toEqual([6, 6]);
    expect(spawned).toHaveLength(0);
    expect(fetchCalls).toBe(0);
  });

  test("カスタムエンドポイントでも HTTP 失敗時は say にフォールバックする", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const spawned: string[][] = [];
    const r = await synthesize("Hello", {
      cacheDir, fetchFn: fakeFetch, spawnFn: makeFakeSpawn(spawned),
      env: { TTS_BASE_URL: "http://localhost:8880/v1" },
    });
    expect(r.engine).toBe("say");
    expect(Array.from(r.audio)).toEqual([9, 9]);
  });
});

describe("tts: HTTPキャッシュの容量上限・LRUエビクション（#207）", () => {
  const OLD_A = new Date("2020-01-01T00:00:00Z");
  const OLD_B = new Date("2020-01-02T00:00:00Z");

  function mkAudioFetch(bytes: number) {
    return (async () => new Response(new Uint8Array(bytes).fill(7), { status: 200 })) as unknown as typeof fetch;
  }

  /** runtime HTTPキャッシュの実パス（provider "openai"・既定接続の合成キー） */
  function runtimeCachePath(cacheDir: string, text: string): string {
    const key = httpCacheKeyFor(
      "openai", { baseUrl: DEFAULT_TTS_BASE_URL, model: DEFAULT_TTS_MODEL, voice: DEFAULT_TTS_VOICE }, text,
    );
    return path.join(cacheDir, `${key}.mp3`);
  }

  function totalMp3Bytes(cacheDir: string): number {
    return readdirSync(cacheDir)
      .filter((name) => name.endsWith(".mp3"))
      .reduce((sum, name) => sum + statSync(path.join(cacheDir, name)).size, 0);
  }

  test("既定の容量上限は正の有限値", () => {
    expect(Number.isFinite(DEFAULT_TTS_CACHE_MAX_BYTES)).toBe(true);
    expect(DEFAULT_TTS_CACHE_MAX_BYTES).toBeGreaterThan(0);
  });

  test("上限超過時はmtimeの古い順に削除され、総容量が上限内へ収まる", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-lru-"));
    const opts = {
      apiKey: "sk-test", provider: "openai" as const, cacheDir,
      fetchFn: mkAudioFetch(100), env: {}, cacheMaxBytes: 250,
    };
    await synthesize("evict text 1", opts);
    utimesSync(runtimeCachePath(cacheDir, "evict text 1"), OLD_A, OLD_A);
    await synthesize("evict text 2", opts);
    utimesSync(runtimeCachePath(cacheDir, "evict text 2"), OLD_B, OLD_B);
    await synthesize("evict text 3", opts); // 100+100+100=300 > 250 → 最古の1件を削除

    expect(existsSync(runtimeCachePath(cacheDir, "evict text 1"))).toBe(false);
    expect(existsSync(runtimeCachePath(cacheDir, "evict text 2"))).toBe(true);
    expect(existsSync(runtimeCachePath(cacheDir, "evict text 3"))).toBe(true);
    expect(totalMp3Bytes(cacheDir)).toBeLessThanOrEqual(250);
  });

  test("キャッシュヒットはLRU順位を更新する（直近に再生された音声より、長く再生されていない音声を先に削除）", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-lru-hit-"));
    const opts = {
      apiKey: "sk-test", provider: "openai" as const, cacheDir,
      fetchFn: mkAudioFetch(100), env: {}, cacheMaxBytes: 250,
    };
    await synthesize("lru A", opts);
    utimesSync(runtimeCachePath(cacheDir, "lru A"), OLD_A, OLD_A); // Aの方が古い
    await synthesize("lru B", opts);
    utimesSync(runtimeCachePath(cacheDir, "lru B"), OLD_B, OLD_B);

    // Aを再生: キャッシュヒット（無料再生の維持）+ LRU順位が最新になる
    const throwingFetch = (async () => {
      throw new Error("must not fetch on cache hit");
    }) as unknown as typeof fetch;
    const hit = await synthesize("lru A", { ...opts, fetchFn: throwingFetch });
    expect(hit.engine).toBe("openai");
    expect(Array.from(hit.audio)).toEqual(Array.from(new Uint8Array(100).fill(7)));

    await synthesize("lru C", opts); // 1件evict → 最古はB（Aはヒットで更新済み）
    expect(existsSync(runtimeCachePath(cacheDir, "lru B"))).toBe(false);
    expect(existsSync(runtimeCachePath(cacheDir, "lru A"))).toBe(true);
    expect(existsSync(runtimeCachePath(cacheDir, "lru C"))).toBe(true);
  });

  test("同梱生成mode（cacheTarget: bundled）は容量上限の対象外で何も削除されない", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-lru-bundled-"));
    const opts = {
      apiKey: "sk-test", cacheDir, cacheTarget: "bundled" as const,
      fetchFn: mkAudioFetch(100), env: {}, cacheMaxBytes: 150,
    };
    await synthesize("bundle 1", opts);
    await synthesize("bundle 2", opts);
    await synthesize("bundle 3", opts);
    expect(readdirSync(cacheDir).filter((name) => name.endsWith(".mp3"))).toHaveLength(3);
  });
});
