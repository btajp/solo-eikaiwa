/**
 * API キーの Keychain 保存・読み出し。
 *
 * - 保存は `security -i` の **stdin 経由**でコマンドを渡す（鍵の値を argv に出さない＝`ps` 露出防止）
 * - Keychain値はmanager内だけに保持し、process.envへ展開しない
 * - 解決優先順位は Keychain > app/.env。削除後はenv由来値へ自然に戻る
 * - 鍵の値をログ・エラーメッセージに含めない（呼び出し側の応答にも含めない — routes/secrets.ts 参照）
 */

import { minimalSubprocessEnv } from "./subprocess-env";

/** Keychain のサービス名（アカウント名 = 変数名）。 */
const KEYCHAIN_SERVICE = "solo-eikaiwa";

/**
 * UI/Keychain で扱う鍵のホワイトリスト（binding・spec §2）。
 * OPENAI_API_KEY は含めない（TTS は TTS_API_KEY が優先解決されるため UI 上はこれで完結。
 * OPENAI_API_KEY は教材生成 CLI・レガシーフォールバック用に env のみ）。
 */
export const KEYCHAIN_SECRET_NAMES = [
  "ANTHROPIC_API_KEY",
  "CODEX_API_KEY",
  "OPENAI_COMPAT_API_KEY",
  "TTS_API_KEY",
] as const;

export type SecretName = (typeof KEYCHAIN_SECRET_NAMES)[number];

export function isSecretName(v: string): v is SecretName {
  return (KEYCHAIN_SECRET_NAMES as readonly string[]).includes(v);
}

/**
 * 鍵の値の形式検証。空白・制御文字・引用符（" '）・バックスラッシュを含まない printable ASCII の
 * 1..500 文字だけを受理する（一般的な API キー形状はすべて通る）。
 * これにより `security -i` へ渡すコマンド文字列の引用が単純な二重引用符囲みで安全になる。
 */
export function isValidSecretValue(v: string): boolean {
  if (v.length < 1 || v.length > 500) return false;
  return /^[\x21-\x7e]+$/.test(v) && !/["'\\]/.test(v);
}

/** secrets 専用の spawn シーム。既存の SpawnFn は stdin/stdout 非対応のため別定義（テストで注入する）。 */
export type SecretsSpawnFn = (
  cmd: string[],
  stdin?: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const realSecretsSpawn: SecretsSpawnFn = async (cmd, stdin) => {
  const proc = Bun.spawn(cmd, {
    env: minimalSubprocessEnv(),
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
};

export type SecretSource = "keychain" | "env" | null;
export type SecretStatus = { configured: boolean; source: SecretSource };

export type SecretsManager = {
  /** 起動時: Keychain の値をmanager内へ読み込む。security の失敗は warn のみ（fail-open）。 */
  load(): Promise<void>;
  /** 検証 → Keychain 保存 → manager内へ反映。失敗は throw（メッセージに値は含めない）。 */
  save(name: SecretName, value: string): Promise<void>;
  /** Keychain から削除する。env由来値は変更しない（項目不在は冪等に成功扱い）。 */
  remove(name: SecretName): Promise<void>;
  /** Keychain > env の優先順位で値を解決する。値を外部応答へ渡してはならない。 */
  get(name: SecretName): string | undefined;
  /** 鍵ごとの有無とソース。値は絶対に返さない。 */
  status(): Record<SecretName, SecretStatus>;
};

export function makeSecretsManager(opts?: {
  spawn?: SecretsSpawnFn;
  /** 注入先の env（既定 process.env）。テストではプレーンオブジェクトを注入する。 */
  env?: Record<string, string | undefined>;
}): SecretsManager {
  const spawn = opts?.spawn ?? realSecretsSpawn;
  const env = opts?.env ?? (process.env as Record<string, string | undefined>);
  const keychainValues = new Map<SecretName, string>();

  return {
    async load() {
      for (const name of KEYCHAIN_SECRET_NAMES) {
        try {
          // find は値が stdout に「出てくる」方向なので argv に秘密は乗らない
          const r = await spawn(["/usr/bin/security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
          if (r.exitCode !== 0) {
            keychainValues.delete(name);
            continue;
          }
          const value = r.stdout.trim();
          if (!value) {
            keychainValues.delete(name);
            continue;
          }
          keychainValues.set(name, value);
        } catch (err) {
          // Keychain ロック・security 不在等でも起動をブロックしない（env のみで継続）
          console.warn(`secrets: keychain read failed for ${name} (continuing with env): ${String(err)}`);
        }
      }
    },

    async save(name, value) {
      if (!isSecretName(name)) throw new Error(`unknown secret name: ${String(name)}`);
      if (!isValidSecretValue(value)) {
        throw new Error("invalid secret value (1..500 printable ASCII chars, no spaces/quotes/backslashes)");
      }
      // -U: 既存項目を上書き。値は stdin のコマンド行にのみ現れる（argv には security -i だけ）
      const r = await spawn(["/usr/bin/security", "-i"], `add-generic-password -U -a ${name} -s ${KEYCHAIN_SERVICE} -w "${value}"\n`);
      if (r.exitCode !== 0) {
        const detail = r.stderr.trim().replaceAll(value, "[redacted]") || `exit ${r.exitCode}`;
        throw new Error(`keychain write failed for ${name}: ${detail}`);
      }
      keychainValues.set(name, value);
    },

    async remove(name) {
      if (!isSecretName(name)) throw new Error(`unknown secret name: ${String(name)}`);
      const r = await spawn(["/usr/bin/security", "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
      // 44 = 項目なし。冪等な削除として成功扱いにする
      if (r.exitCode !== 0 && r.exitCode !== 44) {
        throw new Error(`keychain delete failed for ${name}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
      }
      keychainValues.delete(name);
    },

    get(name) {
      return keychainValues.get(name) ?? (env[name]?.trim() ? env[name] : undefined);
    },

    status() {
      const out = {} as Record<SecretName, SecretStatus>;
      for (const name of KEYCHAIN_SECRET_NAMES) {
        const configured = Boolean(keychainValues.get(name) ?? env[name]?.trim());
        out[name] = {
          configured,
          source: keychainValues.has(name) ? "keychain" : configured ? "env" : null,
        };
      }
      return out;
    },
  };
}
