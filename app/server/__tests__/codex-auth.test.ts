import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import { ensureCodexApiKeyHome, resetCodexApiKeyHome, codexSpawnEnv, type CodexLoginSpawn } from "../codex-auth";

/**
 * 実 DATA_DIR/codex-home には一切触れない（ローカル専用データを壊すリスクを避ける）。
 * ensureCodexApiKeyHome の第2引数（dir）で毎回 mkdtemp の一時ディレクトリを注入する。
 */
function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "codex-home-"));
}

function withEnvKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const saved = Bun.env.CODEX_API_KEY;
  if (value === undefined) delete Bun.env.CODEX_API_KEY;
  else Bun.env.CODEX_API_KEY = value;
  return fn().finally(() => {
    if (saved === undefined) delete Bun.env.CODEX_API_KEY;
    else Bun.env.CODEX_API_KEY = saved;
  });
}

describe("ensureCodexApiKeyHome", () => {
  test("auth.json が既に存在すればspawnFnを呼ばずdirをそのまま返す（冪等）", async () => {
    const dir = freshDir();
    try {
      writeFileSync(path.join(dir, "auth.json"), "{}");
      const calls: unknown[] = [];
      const spawnFn: CodexLoginSpawn = async (args) => { calls.push(args); };

      await withEnvKey("sk-unused", async () => {
        const result = await ensureCodexApiKeyHome(spawnFn, dir);
        expect(result).toBe(dir);
        expect(calls).toHaveLength(0);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("auth.json が無ければ CODEX_HOME=dir で codex login --with-api-key を実行し、キーはstdinで渡す", async () => {
    const dir = freshDir();
    rmSync(dir, { recursive: true, force: true }); // ensureCodexApiKeyHome 自身が mkdir することを確認する
    try {
      const calls: Array<{ env: Record<string, string | undefined>; stdin: string }> = [];
      const spawnFn: CodexLoginSpawn = async (args) => { calls.push(args); };

      await withEnvKey("sk-secret-123", async () => {
        const result = await ensureCodexApiKeyHome(spawnFn, dir);
        expect(result).toBe(dir);
        expect(calls).toHaveLength(1);
        expect(calls[0].env.CODEX_HOME).toBe(dir);
        expect(calls[0].stdin).toBe("sk-secret-123");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CODEX_API_KEY 未設定ならspawnFnを呼ばずthrowする", async () => {
    const dir = freshDir();
    rmSync(dir, { recursive: true, force: true });
    try {
      const calls: unknown[] = [];
      const spawnFn: CodexLoginSpawn = async (args) => { calls.push(args); };

      await withEnvKey(undefined, async () => {
        await expect(ensureCodexApiKeyHome(spawnFn, dir)).rejects.toThrow(/codex api key/i);
        expect(calls).toHaveLength(0);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("spawnFn が throw したら ensureCodexApiKeyHome もそのまま throw する", async () => {
    const dir = freshDir();
    rmSync(dir, { recursive: true, force: true });
    try {
      const spawnFn: CodexLoginSpawn = async () => {
        throw new Error("codex login --with-api-key failed (exit 1): boom");
      };

      await withEnvKey("sk-x", async () => {
        await expect(ensureCodexApiKeyHome(spawnFn, dir)).rejects.toThrow(/failed/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("既存 auth.json チェックの前段として、必要なら mkdir 済みディレクトリでも動作する", async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true }); // 既に存在するが auth.json はまだ無い状態
    try {
      const calls: unknown[] = [];
      const spawnFn: CodexLoginSpawn = async (args) => { calls.push(args); };

      await withEnvKey("sk-y", async () => {
        const result = await ensureCodexApiKeyHome(spawnFn, dir);
        expect(result).toBe(dir);
        expect(calls).toHaveLength(1);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("auth.json が壊れている（JSON.parse失敗）場合は無効扱いにして再ログインする（login が上書きする）", async () => {
    const dir = freshDir();
    try {
      writeFileSync(path.join(dir, "auth.json"), "{not valid json,,,");
      const calls: Array<{ env: Record<string, string | undefined>; stdin: string }> = [];
      const spawnFn: CodexLoginSpawn = async (args) => { calls.push(args); };

      await withEnvKey("sk-recover", async () => {
        const result = await ensureCodexApiKeyHome(spawnFn, dir);
        expect(result).toBe(dir);
        expect(calls).toHaveLength(1);
        expect(calls[0].stdin).toBe("sk-recover");
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("codexSpawnEnv", () => {
  test("subscription: undefined を返す（env上書きなし＝現行どおりprocess.env継承）", () => {
    expect(codexSpawnEnv("subscription", { PATH: "/usr/bin" })).toBeUndefined();
  });

  test("api-key: baseEnv を土台に CODEX_HOME を注入した env を返す", () => {
    const out = codexSpawnEnv("api-key", { PATH: "/usr/bin" });
    expect(out?.PATH).toBe("/usr/bin");
    expect(out?.CODEX_HOME).toMatch(/codex-home$/);
  });
});

describe("resetCodexApiKeyHome（キーのローテーション/削除時の auth.json 破棄）", () => {
  test("auth.json を削除する（次回 ensure が新しいキーで再ログインできる状態に戻す）", async () => {
    const { mkdtempSync, writeFileSync, existsSync } = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    const dir = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const authPath = path.join(dir, "auth.json");
    writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: "old" }));
    resetCodexApiKeyHome(dir);
    expect(existsSync(authPath)).toBe(false);
  });

  test("auth.json が無くても冪等に成功する", async () => {
    const { mkdtempSync } = await import("node:fs");
    const path = await import("node:path");
    const os = await import("node:os");
    resetCodexApiKeyHome(mkdtempSync(path.join(os.tmpdir(), "codex-home-")));
  });
});
