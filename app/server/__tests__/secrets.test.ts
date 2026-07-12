import { describe, expect, test } from "bun:test";
import {
  KEYCHAIN_SECRET_NAMES, isValidSecretValue, makeSecretsManager, realSecretsSpawn,
  type SecretsSpawnFn,
} from "../secrets";

/** fake spawn: 呼び出しを記録し、事前登録した応答を返す。 */
function makeFakeSpawn(
  responder: (cmd: string[], stdin?: string) => { exitCode: number; stdout?: string; stderr?: string },
) {
  const calls: Array<{ cmd: string[]; stdin?: string }> = [];
  const spawn: SecretsSpawnFn = async (cmd, stdin) => {
    calls.push({ cmd, stdin });
    const r = responder(cmd, stdin);
    return { exitCode: r.exitCode, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { calls, spawn };
}

const OK = () => ({ exitCode: 0 });
const NOT_FOUND = () => ({ exitCode: 44 });

describe("isValidSecretValue", () => {
  test("一般的な API キー形状は受理する", () => {
    expect(isValidSecretValue("sk-ant-api03-abc_DEF-123")).toBe(true);
    expect(isValidSecretValue("github_pat_11AAA.bbb=ccc/ddd:eee+fff")).toBe(true);
  });
  test("空・空白入り・引用符/バックスラッシュ入り・500字超は拒否する", () => {
    expect(isValidSecretValue("")).toBe(false);
    expect(isValidSecretValue("  ")).toBe(false);
    expect(isValidSecretValue("sk test")).toBe(false);
    expect(isValidSecretValue('sk"test')).toBe(false);
    expect(isValidSecretValue("sk\\test")).toBe(false);
    expect(isValidSecretValue("sk'test")).toBe(false);
    expect(isValidSecretValue("x".repeat(501))).toBe(false);
  });
});

describe("makeSecretsManager", () => {
  test("save: 値は stdin にのみ現れ、argv には一切含まれない（ps 露出防止の機械検証）", async () => {
    const { calls, spawn } = makeFakeSpawn(OK);
    const env: Record<string, string | undefined> = {};
    const mgr = makeSecretsManager({ spawn, env });
    await mgr.save("ANTHROPIC_API_KEY", "sk-super-secret");
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toEqual(["/usr/bin/security", "-i"]);
    expect(calls[0].cmd.join(" ")).not.toContain("sk-super-secret");
    expect(calls[0].stdin).toContain('add-generic-password -U -a ANTHROPIC_API_KEY -s solo-eikaiwa -w "sk-super-secret"');
    // 保存値はmanager内にだけ保持し、ambient envへ展開しない
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(mgr.get("ANTHROPIC_API_KEY")).toBe("sk-super-secret");
    expect(mgr.status().ANTHROPIC_API_KEY).toEqual({ configured: true, source: "keychain" });
  });

  test("save: 対象外の名前・不正な値は保存せず throw する", async () => {
    const { calls, spawn } = makeFakeSpawn(OK);
    const mgr = makeSecretsManager({ spawn, env: {} });
    await expect(mgr.save("EVIL_KEY" as never, "v")).rejects.toThrow();
    await expect(mgr.save("TTS_API_KEY", 'bad"value')).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  test("save: security 失敗時は stderr を含めて throw するが、echoされた値は除去する", async () => {
    const { spawn } = makeFakeSpawn(() => ({ exitCode: 1, stderr: "keychain locked: sk-tts-secret" }));
    const mgr = makeSecretsManager({ spawn, env: {} });
    try {
      await mgr.save("TTS_API_KEY", "sk-tts-secret");
      throw new Error("should have thrown");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).toContain("keychain locked");
      expect(msg).toContain("[redacted]");
      expect(msg).not.toContain("sk-tts-secret");
    }
  });

  test("load: Keychain値をmanager内で優先し、ambient env自体は変更しない", async () => {
    const { spawn } = makeFakeSpawn((cmd) =>
      cmd.includes("ANTHROPIC_API_KEY") ? { exitCode: 0, stdout: "sk-from-keychain\n" } : NOT_FOUND(),
    );
    const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: "sk-from-env", CODEX_API_KEY: "sk-codex-env" };
    const mgr = makeSecretsManager({ spawn, env });
    await mgr.load();
    expect(env.ANTHROPIC_API_KEY).toBe("sk-from-env");
    expect(env.CODEX_API_KEY).toBe("sk-codex-env");
    expect(mgr.get("ANTHROPIC_API_KEY")).toBe("sk-from-keychain");
    expect(mgr.get("CODEX_API_KEY")).toBe("sk-codex-env");
    expect(mgr.status().ANTHROPIC_API_KEY).toEqual({ configured: true, source: "keychain" });
    expect(mgr.status().CODEX_API_KEY).toEqual({ configured: true, source: "env" });
    expect(mgr.status().TTS_API_KEY).toEqual({ configured: false, source: null });
  });

  test("load: security 自体の失敗は throw しない（fail-open・env のみで継続）", async () => {
    const spawn: SecretsSpawnFn = async () => {
      throw new Error("spawn failed");
    };
    const env: Record<string, string | undefined> = { TTS_API_KEY: "sk-env" };
    const mgr = makeSecretsManager({ spawn, env });
    await mgr.load(); // throw しないこと
    expect(env.TTS_API_KEY).toBe("sk-env");
    expect(mgr.status().TTS_API_KEY).toEqual({ configured: true, source: "env" });
  });

  test("load: security が永久pendingでもdeadlineでabortし、envのみで起動を継続する", async () => {
    let observedSignal: AbortSignal | undefined;
    const spawn: SecretsSpawnFn = async (_cmd, _stdin, opts) => {
      observedSignal = opts?.signal;
      return await new Promise(() => {});
    };
    const env: Record<string, string | undefined> = { CODEX_API_KEY: "sk-env-timeout" };
    const mgr = makeSecretsManager({ spawn, env, timeoutMs: 20 });
    const started = performance.now();

    await mgr.load();

    expect(performance.now() - started).toBeLessThan(200);
    expect(observedSignal?.aborted).toBe(true);
    expect(mgr.get("CODEX_API_KEY")).toBe("sk-env-timeout");
    expect(mgr.status().CODEX_API_KEY).toEqual({ configured: true, source: "env" });
  });

  test("remove: Keychain値だけを削除し、env由来値へresolverが戻る", async () => {
    const { spawn } = makeFakeSpawn(OK);
    const env: Record<string, string | undefined> = { OPENAI_COMPAT_API_KEY: "sk-env-original" };
    const mgr = makeSecretsManager({ spawn, env });
    await mgr.save("OPENAI_COMPAT_API_KEY", "sk-keychain-new");
    expect(env.OPENAI_COMPAT_API_KEY).toBe("sk-env-original");
    expect(mgr.get("OPENAI_COMPAT_API_KEY")).toBe("sk-keychain-new");
    await mgr.remove("OPENAI_COMPAT_API_KEY");
    expect(env.OPENAI_COMPAT_API_KEY).toBe("sk-env-original");
    expect(mgr.get("OPENAI_COMPAT_API_KEY")).toBe("sk-env-original");
    expect(mgr.status().OPENAI_COMPAT_API_KEY).toEqual({ configured: true, source: "env" });
  });

  test("remove: env元値が無い鍵はresolverから消え、sourceはnullに戻る", async () => {
    const { spawn } = makeFakeSpawn(OK);
    const env: Record<string, string | undefined> = {};
    const mgr = makeSecretsManager({ spawn, env });
    await mgr.save("TTS_API_KEY", "sk-new");
    await mgr.remove("TTS_API_KEY");
    expect(env.TTS_API_KEY).toBeUndefined();
    expect(mgr.status().TTS_API_KEY).toEqual({ configured: false, source: null });
  });

  test("remove: Keychain未登録でenv由来のみの鍵はenv値とsourceを保持する", async () => {
    const { spawn } = makeFakeSpawn(NOT_FOUND);
    const env: Record<string, string | undefined> = { TTS_API_KEY: "sk-from-dotenv" };
    const mgr = makeSecretsManager({ spawn, env });

    await mgr.remove("TTS_API_KEY");

    expect(env.TTS_API_KEY).toBe("sk-from-dotenv");
    expect(mgr.get("TTS_API_KEY")).toBe("sk-from-dotenv");
    expect(mgr.status().TTS_API_KEY).toEqual({ configured: true, source: "env" });
  });

  test("remove: Keychain に項目が無い（exit 44）は成功扱い（冪等）", async () => {
    const { spawn } = makeFakeSpawn(NOT_FOUND);
    const mgr = makeSecretsManager({ spawn, env: {} });
    await mgr.remove("CODEX_API_KEY"); // throw しないこと
  });

  test("KEYCHAIN_SECRET_NAMES は公式 OpenAI と互換 OpenAI を別鍵として持つ", () => {
    expect([...KEYCHAIN_SECRET_NAMES]).toEqual([
      "ANTHROPIC_API_KEY", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_COMPAT_API_KEY", "TTS_API_KEY",
    ]);
  });
});

describe("realSecretsSpawn", () => {
  test("AbortSignalで応答しない子プロセスを終了する", async () => {
    const controller = new AbortController();
    const started = performance.now();
    const pending = realSecretsSpawn(
      ["/bin/sh", "-c", "exec /bin/sleep 10"],
      undefined,
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    const result = await pending;
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.exitCode).not.toBe(0);
  });
});
