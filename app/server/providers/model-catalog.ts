import type { ModelInfo, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * モデルカタログ API（`GET /api/llm-models`）の中核: 3ソース（claude/codex/local）共通の型・
 * TTL キャッシュ・実 fetcher 3種。設計は docs/superpowers/specs/2026-07-08-provider-overhaul-design.md §7。
 * 「UI 真実性の原則」（binding）に従い、取得失敗は throw ではなく available:false + reason で返す
 * （HTTP は常に 200・UI は「実体未確認」に劣化するだけで嘘の表示をしない）。
 */

export type LlmCatalogProvider = "claude" | "codex" | "local";

export type CatalogModelEffort = { id: string; description?: string };
export type CatalogModelTier = { id: string; name: string; description?: string };

export type CatalogModel = {
  id: string;
  displayName: string;
  description: string;
  /** 'sonnet'→'claude-sonnet-5' のような canonical wire id（claude）／served model slug（codex）。実効モデル表示用。 */
  resolvedModel?: string;
  efforts?: CatalogModelEffort[];
  defaultEffort?: string;
  tiers?: CatalogModelTier[];
  defaultTier?: string;
  isDefault?: boolean;
};

export type CatalogResult = {
  available: boolean;
  reason?: string;
  models: CatalogModel[];
  fetchedAt: string;
};

export type CatalogFetcher = () => Promise<CatalogResult>;

// ---------------------------------------------------------------------------
// TTL キャッシュ
// ---------------------------------------------------------------------------

export type ModelCatalogCache = {
  get(provider: LlmCatalogProvider, refresh: boolean): Promise<CatalogResult>;
};

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * 3ソース分の fetcher を束ね、成功結果だけを TTL キャッシュする。
 * 失敗（available:false）は次回呼び出しのために一切キャッシュしない（毎回 fetcher を叩き直す）ため、
 * 一過性の障害が「実体未確認」を恒久化させない。既存の成功キャッシュも失敗では上書きされない
 * （refresh=1 で強制再取得した結果が失敗でも、直前の成功キャッシュはそのまま活かされる）。
 *
 * in-flight デデュープ（レビュー指摘）: 同一 provider への並行呼び出しは進行中の fetcher 実行を共有する
 * （例: refresh ボタンの連打で claude CLI プロセスが二重に立ち上がるのを防ぐ）。**選んだ意味論**: refresh=1
 * の呼び出しであっても、ちょうど進行中の fetch があればそれに相乗りし、別途新しい fetcher 実行は起こさない
 * （「強制再取得」の厳密性より「同時に何本も立ち上げない」ことを優先する）。fetch 完了後（成功・失敗いずれも）
 * は in-flight エントリを消すため、次回の呼び出しは新しい fetch を開始できる。
 */
export function makeModelCatalogCache(
  fetchers: Record<LlmCatalogProvider, CatalogFetcher>,
  opts?: { ttlMs?: number; now?: () => number },
): ModelCatalogCache {
  const ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts?.now ?? (() => Date.now());
  const cache = new Map<LlmCatalogProvider, { result: CatalogResult; expiresAt: number }>();
  const inFlight = new Map<LlmCatalogProvider, Promise<CatalogResult>>();

  return {
    get(provider, refresh) {
      if (!refresh) {
        const cached = cache.get(provider);
        if (cached && cached.expiresAt > now()) return Promise.resolve(cached.result);
      }

      const existing = inFlight.get(provider);
      if (existing) return existing;

      const p = (async () => {
        try {
          const result = await fetchers[provider]();
          if (result.available) cache.set(provider, { result, expiresAt: now() + ttlMs });
          return result;
        } finally {
          inFlight.delete(provider);
        }
      })();
      inFlight.set(provider, p);
      return p;
    },
  };
}

// ---------------------------------------------------------------------------
// 共通ユーティリティ
// ---------------------------------------------------------------------------

/** p が ms 以内に決着しなければ message で reject する。テスト容易性のため純粋な Promise ユーティリティとして持つ
 * （providers/decorators.ts の withTimeout は ClaudeRunner 専用のため流用しない）。 */
function raceTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// claude fetcher: Agent SDK query() streaming-input モード + supportedModels()
// ---------------------------------------------------------------------------

/**
 * query() が返す Query の内、カタログ取得に必要な最小サブセット。
 * 広い Query 型（AsyncGenerator を継承・多数の制御メソッドを持つ）に依存せず、フェイクでのテストを容易にする。
 * 実 SDK の `query` は Query（この2メソッドを含むより広い型）を返すため、そのまま代入可能（構造的部分型）。
 */
export type CatalogQueryHandle = {
  supportedModels(): Promise<ModelInfo[]>;
  interrupt(): Promise<void>;
};
/**
 * query() の options のうち、このカタログ取得が使う最小サブセット。実 SDK の Options（多数の任意フィールドを持つ）に
 * 構造的部分型として代入可能（全フィールドが任意のため、欠けているフィールドがあっても代入エラーにならない）。
 */
export type CatalogQueryOptions = { pathToClaudeCodeExecutable?: string };
export type CatalogQueryFn = (
  args: { prompt: AsyncIterable<SDKUserMessage>; options?: CatalogQueryOptions },
) => CatalogQueryHandle;

const CLAUDE_FETCH_TIMEOUT_MS = 10_000;

function toClaudeCatalogModel(m: ModelInfo): CatalogModel {
  return {
    id: m.value,
    displayName: m.displayName,
    description: m.description,
    ...(m.resolvedModel !== undefined ? { resolvedModel: m.resolvedModel } : {}),
    ...(m.supportedEffortLevels ? { efforts: m.supportedEffortLevels.map((id) => ({ id })) } : {}),
  };
}

/**
 * Agent SDK の streaming-input モードで query() を呼び、Query の supportedModels() だけを使ってモデル一覧を取る。
 * プロンプトは「何もyieldしないまま外側から明示的にcloseされるまで待つ」async generator を渡すため、
 * ユーザーターンは一切送信されずトークンを消費しない（CLI メタデータ取得のみ）。
 * 取得後は速やかに interrupt() してプロセス/セッションを畳む。ハング防止に timeoutMs（既定10秒）で打ち切る。
 * 失敗（spawn 不可・timeout・supportedModels 拒否）は throw せず available:false + reason を返す。
 */
export function makeClaudeCatalogFetcher(
  queryFn: CatalogQueryFn,
  opts?: { timeoutMs?: number; claudeExecutablePath?: string },
): CatalogFetcher {
  const timeoutMs = opts?.timeoutMs ?? CLAUDE_FETCH_TIMEOUT_MS;

  return async () => {
    const fetchedAt = new Date().toISOString();
    let resolveClose: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => { resolveClose = resolve; });
    async function* silentPrompt(): AsyncGenerator<SDKUserMessage> {
      await closed; // 何もyieldしない。resolveClose() が呼ばれるまでストリームを開いたままにする
    }

    try {
      // sidecarモード（index.tsからclaudeExecutablePathが渡るとき）だけ options を注入する。
      // 非sidecarモードでは options 自体を渡さず、既存呼び出し（converse.tsのmakeClaudeRunnerと同じ設計）と
      // バイト等価にする。
      const q = queryFn({
        prompt: silentPrompt(),
        ...(opts?.claudeExecutablePath ? { options: { pathToClaudeCodeExecutable: opts.claudeExecutablePath } } : {}),
      });
      try {
        const models = await raceTimeout(q.supportedModels(), timeoutMs, "claude supportedModels timed out");
        return { available: true, models: models.map(toClaudeCatalogModel), fetchedAt };
      } finally {
        resolveClose?.();
        try {
          await q.interrupt();
        } catch {
          // ベストエフォートの後始末。取得済みの結果（またはエラー）を上書きしない。
        }
      }
    } catch (err) {
      resolveClose?.();
      return { available: false, reason: reasonOf(err), models: [], fetchedAt };
    }
  };
}

// ---------------------------------------------------------------------------
// codex fetcher: app-server 常駐プロセスへの model/list（exec フォールバックなし）
// ---------------------------------------------------------------------------

/** codex-app-server.ts の CodexAppServerClient から必要な最小サブセット（テスト容易性のため）。 */
export type CodexModelListClient = { listModels(): Promise<Record<string, unknown>[]> };

function asArray<T>(v: unknown): T[] | undefined {
  return Array.isArray(v) ? (v as T[]) : undefined;
}

function toCodexCatalogModel(m: Record<string, unknown>): CatalogModel {
  const efforts = asArray<Record<string, unknown>>(m.supportedReasoningEfforts)?.map((e) => ({
    id: String(e.reasoningEffort ?? ""),
    ...(typeof e.description === "string" ? { description: e.description } : {}),
  }));
  const tiers = asArray<Record<string, unknown>>(m.serviceTiers)?.map((t) => ({
    id: String(t.id ?? ""),
    name: String(t.name ?? ""),
    ...(typeof t.description === "string" ? { description: t.description } : {}),
  }));
  return {
    id: String(m.id ?? ""),
    displayName: typeof m.displayName === "string" ? m.displayName : String(m.id ?? ""),
    description: typeof m.description === "string" ? m.description : "",
    // codex Model の `model`(served model slug) は claude の resolvedModel と同じ役割（実効モデルの可視化）を担うため、
    // CatalogModel の共有フィールド resolvedModel へ写像する。
    ...(typeof m.model === "string" ? { resolvedModel: m.model } : {}),
    ...(efforts ? { efforts } : {}),
    ...(typeof m.defaultReasoningEffort === "string" ? { defaultEffort: m.defaultReasoningEffort } : {}),
    ...(tiers ? { tiers } : {}),
    ...(typeof m.defaultServiceTier === "string" ? { defaultTier: m.defaultServiceTier } : {}),
    ...(typeof m.isDefault === "boolean" ? { isDefault: m.isDefault } : {}),
  };
}

/**
 * codex app-server の常駐プロセスへ model/list を投げてモデル一覧を取る。
 * getClient は呼び出し都度に現在の常駐クライアントを解決する関数（index.ts では
 * providers/codex-app-server.ts の getCodexAppServerClient を渡し、runner と同じプロセスを共有する）。
 * このカタログ取得は exec フォールバックを経由しない（app-server 専用）— 失敗はそのまま available:false。
 */
export function makeCodexCatalogFetcher(getClient: () => CodexModelListClient): CatalogFetcher {
  return async () => {
    const fetchedAt = new Date().toISOString();
    try {
      const rows = await getClient().listModels();
      return { available: true, models: rows.map(toCodexCatalogModel), fetchedAt };
    } catch (err) {
      return { available: false, reason: reasonOf(err), models: [], fetchedAt };
    }
  };
}

// ---------------------------------------------------------------------------
// local fetcher: OpenAI 互換 GET {baseUrl}/models
// ---------------------------------------------------------------------------

const LOCAL_FETCH_TIMEOUT_MS = 4_000;

type LocalModelsResponse = { data?: Array<{ id?: unknown }> };

/**
 * ローカル接続（Ollama/LM Studio 等の OpenAI 互換 /models）からモデル一覧を取る。
 * getBaseUrl は呼び出し都度の現在の baseUrl を返す（未設定なら null）— index.ts では
 * 保存済み llm_settings.baseUrl（openai-compat 選択中）→ 無ければ env OPENAI_COMPAT_BASE_URL の順で解決する。
 */
export function makeLocalCatalogFetcher(
  getBaseUrl: () => string | null,
  fetchFn: typeof fetch = fetch,
): CatalogFetcher {
  return async () => {
    const fetchedAt = new Date().toISOString();
    const baseUrl = getBaseUrl();
    if (!baseUrl) {
      return { available: false, reason: "ローカル接続(baseUrl)が未設定です", models: [], fetchedAt };
    }
    try {
      const res = await fetchFn(`${baseUrl.replace(/\/+$/, "")}/models`, {
        signal: AbortSignal.timeout(LOCAL_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { available: false, reason: `local models fetch failed: ${res.status}`, models: [], fetchedAt };
      }
      const data = (await res.json()) as LocalModelsResponse;
      const models: CatalogModel[] = (data.data ?? [])
        .filter((m): m is { id: string } => typeof m?.id === "string")
        .map((m) => ({ id: m.id, displayName: m.id, description: "" }));
      return { available: true, models, fetchedAt };
    } catch (err) {
      return { available: false, reason: reasonOf(err), models: [], fetchedAt };
    }
  };
}
