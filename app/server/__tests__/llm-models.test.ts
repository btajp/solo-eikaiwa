import { describe, expect, test } from "bun:test";
import { makeFetchHandler } from "../routes";
import { makeTestDeps } from "./helpers/route-deps";
import { getReq } from "./helpers/http";
import {
  makeModelCatalogCache,
  makeClaudeCatalogFetcher,
  makeCodexCatalogFetcher,
  makeLocalCatalogFetcher,
  type CatalogResult,
  type CatalogQueryFn,
} from "../providers/model-catalog";
import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

describe("GET /api/llm-models", () => {
  test("claude/codex/localの3ソースをdeps.getModelCatalog経由で合成して返す", async () => {
    const calls: Array<{ provider: string; refresh: boolean }> = [];
    const RESULT: CatalogResult = { available: true, models: [], fetchedAt: "2026-07-08T00:00:00.000Z" };
    const { deps } = makeTestDeps({
      getModelCatalog: async (provider, refresh) => {
        calls.push({ provider, refresh });
        return RESULT;
      },
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-models?refresh=1"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: RESULT, codex: RESULT, local: RESULT });
    expect(calls.sort((a, b) => a.provider.localeCompare(b.provider))).toEqual([
      { provider: "claude", refresh: true },
      { provider: "codex", refresh: true },
      { provider: "local", refresh: true },
    ]);
  });

  test("refreshクエリが無ければfalseで呼ぶ", async () => {
    const refreshes: boolean[] = [];
    const { deps } = makeTestDeps({
      getModelCatalog: async (_provider, refresh) => {
        refreshes.push(refresh);
        return { available: false, reason: "x", models: [], fetchedAt: "t" };
      },
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-models"));
    expect(res.status).toBe(200);
    expect(refreshes).toEqual([false, false, false]);
  });

  test("ソース失敗時もHTTP 200のままavailable:falseを返す(劣化パス)", async () => {
    const { deps } = makeTestDeps({
      getModelCatalog: async (provider) =>
        provider === "codex"
          ? { available: false, reason: "codex app-server exited", models: [], fetchedAt: "t" }
          : { available: true, models: [], fetchedAt: "t" },
    });
    const res = await makeFetchHandler(deps)(getReq("/api/llm-models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { codex: CatalogResult };
    expect(body.codex).toEqual({ available: false, reason: "codex app-server exited", models: [], fetchedAt: "t" });
  });
});

describe("makeModelCatalogCache", () => {
  test("正常系: fetcherの結果をそのまま返す", async () => {
    const cache = makeModelCatalogCache({
      claude: async () => ({ available: true, models: [{ id: "sonnet", displayName: "Sonnet", description: "" }], fetchedAt: "t1" }),
      codex: async () => ({ available: true, models: [], fetchedAt: "t1" }),
      local: async () => ({ available: true, models: [], fetchedAt: "t1" }),
    });
    const result = await cache.get("claude", false);
    expect(result.available).toBe(true);
    expect(result.models[0]).toEqual({ id: "sonnet", displayName: "Sonnet", description: "" });
  });

  test("ソース失敗はavailable:false,reasonを返す(throwしない)", async () => {
    const cache = makeModelCatalogCache({
      claude: async () => ({ available: false, reason: "boom", models: [], fetchedAt: "t1" }),
      codex: async () => ({ available: true, models: [], fetchedAt: "t1" }),
      local: async () => ({ available: true, models: [], fetchedAt: "t1" }),
    });
    const result = await cache.get("claude", false);
    expect(result).toEqual({ available: false, reason: "boom", models: [], fetchedAt: "t1" });
  });

  test("TTLキャッシュが2回目のfetcher呼び出しを抑止する", async () => {
    let calls = 0;
    let now = 0;
    const cache = makeModelCatalogCache(
      {
        claude: async () => { calls++; return { available: true, models: [], fetchedAt: "t" }; },
        codex: async () => ({ available: true, models: [], fetchedAt: "t" }),
        local: async () => ({ available: true, models: [], fetchedAt: "t" }),
      },
      { ttlMs: 1000, now: () => now },
    );
    await cache.get("claude", false);
    now += 500;
    await cache.get("claude", false);
    expect(calls).toBe(1); // TTL内なのでfetcherは呼ばれない

    now += 600; // 合計1100ms > ttl 1000ms
    await cache.get("claude", false);
    expect(calls).toBe(2);
  });

  test("refresh=1は常に強制再取得する", async () => {
    let calls = 0;
    const cache = makeModelCatalogCache({
      claude: async () => { calls++; return { available: true, models: [], fetchedAt: "t" }; },
      codex: async () => ({ available: true, models: [], fetchedAt: "t" }),
      local: async () => ({ available: true, models: [], fetchedAt: "t" }),
    });
    await cache.get("claude", false);
    await cache.get("claude", true);
    expect(calls).toBe(2);
  });

  test("失敗はキャッシュを汚さない: 強制refreshが失敗しても直前の成功キャッシュは残り、次の非refreshはfetcherを呼び直さない", async () => {
    let calls = 0;
    const cache = makeModelCatalogCache({
      claude: async () => {
        calls++;
        return calls === 1
          ? { available: true, models: [{ id: "sonnet", displayName: "S", description: "" }], fetchedAt: "t1" }
          : { available: false, reason: "boom", models: [], fetchedAt: "t2" };
      },
      codex: async () => ({ available: true, models: [], fetchedAt: "t" }),
      local: async () => ({ available: true, models: [], fetchedAt: "t" }),
    });
    const first = await cache.get("claude", false);
    expect(first.available).toBe(true);

    const second = await cache.get("claude", true); // 強制refresh→失敗。既存の成功キャッシュを上書きしない
    expect(second).toEqual({ available: false, reason: "boom", models: [], fetchedAt: "t2" });
    expect(calls).toBe(2);

    const third = await cache.get("claude", false); // 非refresh: 汚染されていない成功キャッシュがそのまま返る
    expect(third).toEqual(first);
    expect(calls).toBe(2); // fetcherは呼ばれ直さない
  });

  test("同一providerへの並行get()はfetcherを1回だけ呼ぶ(in-flightデデュープ・レビュー指摘: 連打での二重起動防止)", async () => {
    let calls = 0;
    let resolveFetch!: (r: CatalogResult) => void;
    const pending = new Promise<CatalogResult>((resolve) => { resolveFetch = resolve; });
    const cache = makeModelCatalogCache({
      claude: async () => { calls++; return pending; },
      codex: async () => ({ available: true, models: [], fetchedAt: "t" }),
      local: async () => ({ available: true, models: [], fetchedAt: "t" }),
    });
    const p1 = cache.get("claude", false);
    const p2 = cache.get("claude", false);
    resolveFetch({ available: true, models: [], fetchedAt: "t1" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(calls).toBe(1);
    expect(r1).toEqual(r2);
  });

  test("進行中のfetchにrefresh=1が来ても新規fetcher呼び出しを増やさず相乗りする(選んだ意味論)", async () => {
    let calls = 0;
    let resolveFetch!: (r: CatalogResult) => void;
    const pending = new Promise<CatalogResult>((resolve) => { resolveFetch = resolve; });
    const cache = makeModelCatalogCache({
      claude: async () => { calls++; return pending; },
      codex: async () => ({ available: true, models: [], fetchedAt: "t" }),
      local: async () => ({ available: true, models: [], fetchedAt: "t" }),
    });
    const p1 = cache.get("claude", false);
    const p2 = cache.get("claude", true); // 進行中のfetchに相乗りする
    resolveFetch({ available: true, models: [], fetchedAt: "t1" });
    await Promise.all([p1, p2]);
    expect(calls).toBe(1);
  });

  test("in-flightのfetchが完了した後は次のget()が新しいfetcher呼び出しを開始する", async () => {
    let calls = 0;
    const cache = makeModelCatalogCache({
      claude: async () => { calls++; return { available: true, models: [], fetchedAt: `t${calls}` }; },
      codex: async () => ({ available: true, models: [], fetchedAt: "t" }),
      local: async () => ({ available: true, models: [], fetchedAt: "t" }),
    });
    await cache.get("claude", true);
    await cache.get("claude", true);
    expect(calls).toBe(2);
  });
});

describe("makeClaudeCatalogFetcher", () => {
  test("正常系: supportedModelsの結果をCatalogModelへ写像し、interruptで即クローズする(ターンを送らない)", async () => {
    const promptIterables: AsyncIterable<unknown>[] = [];
    let interruptCalls = 0;
    const MODELS: ModelInfo[] = [
      {
        value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet",
        description: "Balanced model", supportedEffortLevels: ["low", "medium", "high"],
      },
      { value: "haiku", displayName: "Haiku", description: "Fast model" },
    ];
    const queryFn: CatalogQueryFn = (args) => {
      promptIterables.push(args.prompt);
      return {
        supportedModels: async () => MODELS,
        interrupt: async () => { interruptCalls++; },
      };
    };

    const fetcher = makeClaudeCatalogFetcher(queryFn);
    const result = await fetcher();

    expect(result.available).toBe(true);
    expect(result.models).toEqual([
      {
        id: "sonnet", displayName: "Sonnet", description: "Balanced model", resolvedModel: "claude-sonnet-5",
        efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }],
      },
      { id: "haiku", displayName: "Haiku", description: "Fast model" },
    ]);
    expect(typeof result.fetchedAt).toBe("string");
    expect(interruptCalls).toBe(1);

    // プロンプトは何もyieldせず、fetcher完了時点で既にclose済み(=ターン未送信・トークン未消費)であることを確認する
    const iterator = promptIterables[0]![Symbol.asyncIterator]();
    const step = await iterator.next();
    expect(step.done).toBe(true);
  });

  test("supportedModelsの失敗はavailable:falseとreasonを返す(throwしない)", async () => {
    const queryFn: CatalogQueryFn = () => ({
      supportedModels: async () => { throw new Error("cli not found"); },
      interrupt: async () => {},
    });
    const fetcher = makeClaudeCatalogFetcher(queryFn);
    const result = await fetcher();
    expect(result).toMatchObject({ available: false, reason: "cli not found", models: [] });
  });

  test("queryFn自体の同期throwもavailable:falseに変換する", async () => {
    const queryFn: CatalogQueryFn = () => { throw new Error("spawn failed"); };
    const fetcher = makeClaudeCatalogFetcher(queryFn);
    const result = await fetcher();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("spawn failed");
  });

  test("タイムアウトで打ち切りavailable:falseを返す(ハングでルートを止めない)", async () => {
    const queryFn: CatalogQueryFn = () => ({
      supportedModels: () => new Promise(() => {}), // 永久に解決しない
      interrupt: async () => {},
    });
    const fetcher = makeClaudeCatalogFetcher(queryFn, { timeoutMs: 20 });
    const result = await fetcher();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/timed out/);
  });

  test("opts.claudeExecutablePath指定時はoptions.pathToClaudeCodeExecutableとしてqueryFnに渡る（sidecarモードのSDK CLI解決注入）", async () => {
    const calls: Array<{ options?: { pathToClaudeCodeExecutable?: string } }> = [];
    const queryFn: CatalogQueryFn = (args) => {
      calls.push(args);
      return { supportedModels: async () => [], interrupt: async () => {} };
    };
    const fetcher = makeClaudeCatalogFetcher(queryFn, { claudeExecutablePath: "/opt/homebrew/bin/claude" });
    await fetcher();
    expect(calls[0]!.options).toEqual({ pathToClaudeCodeExecutable: "/opt/homebrew/bin/claude" });
  });

  test("opts.claudeExecutablePath未指定時はoptions自体を渡さない（非sidecarモードでバイト等価）", async () => {
    const calls: Array<{ options?: unknown }> = [];
    const queryFn: CatalogQueryFn = (args) => {
      calls.push(args);
      return { supportedModels: async () => [], interrupt: async () => {} };
    };
    const fetcher = makeClaudeCatalogFetcher(queryFn);
    await fetcher();
    expect(calls[0]!.options).toBeUndefined();
  });
});

describe("makeCodexCatalogFetcher", () => {
  test("正常系: Model[]をCatalogModelへ写像する(id/model→resolvedModel/displayName/description/efforts/defaultEffort/tiers/defaultTier/isDefault)", async () => {
    const ROWS: Record<string, unknown>[] = [
      {
        id: "gpt-5.6-codex", model: "gpt-5.6", displayName: "GPT-5.6 Codex", description: "Latest codex model",
        supportedReasoningEfforts: [
          { reasoningEffort: "low", description: "fast" },
          { reasoningEffort: "high", description: "thorough" },
        ],
        defaultReasoningEffort: "medium",
        serviceTiers: [{ id: "fast", name: "Fast", description: "低レイテンシ" }],
        defaultServiceTier: "fast",
        isDefault: true,
      },
    ];
    const fetcher = makeCodexCatalogFetcher(() => ({ listModels: async () => ROWS }));
    const result = await fetcher();
    expect(result.available).toBe(true);
    expect(result.models).toEqual([
      {
        id: "gpt-5.6-codex", displayName: "GPT-5.6 Codex", description: "Latest codex model", resolvedModel: "gpt-5.6",
        efforts: [{ id: "low", description: "fast" }, { id: "high", description: "thorough" }],
        defaultEffort: "medium",
        tiers: [{ id: "fast", name: "Fast", description: "低レイテンシ" }],
        defaultTier: "fast",
        isDefault: true,
      },
    ]);
  });

  test("失敗(app-server不可)はavailable:falseを返す(execフォールバックしない)", async () => {
    const fetcher = makeCodexCatalogFetcher(() => ({
      listModels: async () => { throw new Error("codex app-server exited"); },
    }));
    const result = await fetcher();
    expect(result).toMatchObject({ available: false, reason: "codex app-server exited", models: [] });
  });

  test("listModelsのページネーション上限超過(throw)もavailable:falseへ変換する(部分リストをavailable:trueで返さない・レビュー指摘)", async () => {
    const fetcher = makeCodexCatalogFetcher(() => ({
      listModels: async () => { throw new Error("codex model/list: pagination did not terminate within 10 pages"); },
    }));
    const result = await fetcher();
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/pagination/);
    expect(result.models).toEqual([]);
  });
});

describe("makeLocalCatalogFetcher", () => {
  test("baseUrl未設定はavailable:falseで理由がローカル未設定を示す", async () => {
    const fetcher = makeLocalCatalogFetcher(() => null);
    const result = await fetcher();
    expect(result.available).toBe(false);
    expect(result.reason).toContain("未設定");
  });

  test("正常系: GET {baseUrl}/modelsのdata[].idをCatalogModelへ写像する", async () => {
    const calls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: "llama3" }, { id: "qwen2.5" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const fetcher = makeLocalCatalogFetcher(() => "http://localhost:11434/v1", fetchFn);
    const result = await fetcher();
    expect(result.available).toBe(true);
    expect(result.models).toEqual([
      { id: "llama3", displayName: "llama3", description: "" },
      { id: "qwen2.5", displayName: "qwen2.5", description: "" },
    ]);
    expect(calls[0]).toBe("http://localhost:11434/v1/models");
  });

  test("非2xxはavailable:falseを返す", async () => {
    const fetchFn = (async () => new Response("err", { status: 500 })) as unknown as typeof fetch;
    const fetcher = makeLocalCatalogFetcher(() => "http://localhost:11434/v1", fetchFn);
    const result = await fetcher();
    expect(result.available).toBe(false);
  });

  test("fetch自体の失敗もavailable:falseに変換する(throwしない)", async () => {
    const fetchFn = (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const fetcher = makeLocalCatalogFetcher(() => "http://localhost:11434/v1", fetchFn);
    const result = await fetcher();
    expect(result).toMatchObject({ available: false, reason: "ECONNREFUSED" });
  });
});
