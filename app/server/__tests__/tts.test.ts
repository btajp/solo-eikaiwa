import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  cacheKeyFor, synthesize, resolveTtsConfig,
  DEFAULT_TTS_BASE_URL, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE,
} from "../tts";

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

// say / ffmpeg が生成するはずの出力ファイルを偽造する共通フェイク
// say: ["say","-v","Samantha","-o",<aiff>,"-f",<textFile>] → -o の次
// ffmpeg: ["ffmpeg","-i",<aiff>,<mp3>,"-y"] → 末尾 "-y" の1つ前
function makeFakeSpawn(spawned: string[][]) {
  return async (cmd: string[]) => {
    spawned.push(cmd);
    const oIdx = cmd.indexOf("-o");
    const out = oIdx >= 0 ? cmd[oIdx + 1] : cmd[cmd.length - 2];
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

  test("APIキーが無ければ say フォールバックで生成する", async () => {
    await withNoApiKey(async () => {
      const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
      const spawned: string[][] = [];
      const r = await synthesize("Hello", { apiKey: undefined, cacheDir, spawnFn: makeFakeSpawn(spawned), env: {} });
      expect(r.engine).toBe("say");
      expect(spawned[0][0]).toBe("say");
      expect(spawned[1][0]).toBe("ffmpeg");
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

  test("provider=openai-compat: HTTP 失敗時は従来どおり say へフォールバックする（固定は試行順の固定）", async () => {
    const cacheDir = mkdtempSync(path.join(tmpdir(), "tts-"));
    const fakeFetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const spawned: string[][] = [];
    const r = await synthesize("Broken http", {
      provider: "openai-compat", cacheDir, fetchFn: fakeFetch, spawnFn: makeFakeSpawn(spawned), env: {},
    });
    expect(r.engine).toBe("say");
    expect(spawned.length).toBeGreaterThan(0);
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
