import { describe, expect, test } from "bun:test";
import { minimalSubprocessEnv } from "../subprocess-env";

describe("minimalSubprocessEnv", () => {
  test("実行に必要なallowlistだけを継承し、APIキーと任意envを落とす", () => {
    const out = minimalSubprocessEnv({
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin",
      LANG: "ja_JP.UTF-8",
      TMPDIR: "/tmp",
      ANTHROPIC_API_KEY: "sk-anthropic",
      CODEX_API_KEY: "sk-codex",
      OPENAI_COMPAT_API_KEY: "sk-local",
      TTS_API_KEY: "sk-tts",
      OPENAI_API_KEY: "sk-openai",
      NODE_OPTIONS: "--require=/tmp/inject.js",
      UNRELATED_SECRET: "secret",
    });

    expect(out).toEqual({
      HOME: "/Users/test",
      PATH: "/usr/bin:/bin",
      LANG: "ja_JP.UTF-8",
      TMPDIR: "/tmp",
    });
  });

  test("providerが明示した値だけを追加でき、undefinedは追加しない", () => {
    expect(minimalSubprocessEnv(
      { HOME: "/Users/test", ANTHROPIC_API_KEY: "ambient" },
      { ANTHROPIC_API_KEY: "approved", CODEX_HOME: "/tmp/codex", OMIT: undefined },
    )).toEqual({
      HOME: "/Users/test",
      ANTHROPIC_API_KEY: "approved",
      CODEX_HOME: "/tmp/codex",
    });
  });
});
