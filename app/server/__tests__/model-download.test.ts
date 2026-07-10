import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createModelDownloadManager, type ModelRegistryEntry, type WhisperModelId,
} from "../model-download";

const flush = () => new Promise((r) => setTimeout(r, 0));

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeContent(size: number, fill = 7): Uint8Array {
  const b = new Uint8Array(size);
  b.fill(fill);
  return b;
}

/** small モデルのテスト用フェイクレジストリ（実サイズは使わずテスト用の小さいバイト列にする） */
function fakeRegistry(content: Uint8Array): Record<WhisperModelId, ModelRegistryEntry> {
  return {
    small: {
      id: "small", filename: "ggml-small.bin", url: "https://example.test/ggml-small.bin",
      sizeBytes: content.length, sha256: sha256Hex(content),
    },
    "large-v3-turbo": {
      id: "large-v3-turbo", filename: "ggml-large-v3-turbo.bin", url: "https://example.test/ggml-large-v3-turbo.bin",
      sizeBytes: content.length, sha256: sha256Hex(content),
    },
  };
}

function tmpModelsDir(): string {
  return mkdtempSync(path.join(tmpdir(), "models-"));
}

type FetchCall = { url: string; range: string | null };

/** シンプルな一発完了フェイクfetch: Rangeを見て該当部分を200/206で返す */
function makeSimpleFetch(content: Uint8Array, opts: { calls?: FetchCall[] } = {}): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const range = headers.Range ?? headers.range ?? null;
    opts.calls?.push({ url: String(url), range });
    if (range) {
      const m = /^bytes=(\d+)-$/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const slice = content.slice(start);
      return new Response(slice as unknown as BodyInit, {
        status: 206,
        headers: { "content-range": `bytes ${start}-${content.length - 1}/${content.length}` },
      });
    }
    return new Response(content as unknown as BodyInit, { status: 200 });
  }) as unknown as typeof fetch;
}

describe("model-download: 正常系ダウンロード→検証→原子rename", () => {
  test("成功: .part経由でダウンロードし、sha256一致で最終ファイル名へrenameされる", async () => {
    const content = makeContent(5000);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn: makeSimpleFetch(content) });

    const result = mgr.start("small");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await result.done;

    const state = mgr.getState();
    expect(state.status).toBe("done");
    expect(state.model).toBe("small");
    expect(state.receivedBytes).toBe(content.length);
    expect(state.totalBytes).toBe(content.length);
    expect(state.error).toBeNull();
    expect(state.resumable).toBe(false);

    const finalPath = path.join(dir, "ggml-small.bin");
    expect(existsSync(finalPath)).toBe(true);
    expect(existsSync(`${finalPath}.part`)).toBe(false);
    expect(readFileSync(finalPath)).toEqual(Buffer.from(content));
  });

  test("installedModels(): 成功後は対象モデルのみtrue", async () => {
    const content = makeContent(1000);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn: makeSimpleFetch(content) });

    expect(mgr.installedModels()).toEqual({ small: false, "large-v3-turbo": false });
    const result = mgr.start("small");
    if (result.ok) await result.done;
    expect(mgr.installedModels()).toEqual({ small: true, "large-v3-turbo": false });
  });
});

describe("model-download: バリデーション/前提条件", () => {
  test("未知のmodelは400相当のエラーで即座に返り、stateは変わらない", () => {
    const content = makeContent(10);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn: makeSimpleFetch(content) });

    const result = mgr.start("unknown-model" as WhisperModelId);
    expect(result).toEqual({ ok: false, status: 400, error: expect.stringContaining("unknown model") });
    expect(mgr.getState().status).toBe("idle");
  });

  test("空き容量不足なら507相当のエラーを返し、ダウンロードを開始しない", () => {
    const content = makeContent(1_000_000);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();
    const mgr = createModelDownloadManager({
      modelsDir: dir, registry, fetchFn: makeSimpleFetch(content),
      freeBytesFn: () => 100, // モデルサイズ×1.2よりずっと少ない
    });

    const result = mgr.start("small");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(507);
    expect(result.error).toContain("insufficient disk space");
    expect(mgr.getState().status).toBe("idle");
    expect(existsSync(path.join(dir, "ggml-small.bin.part"))).toBe(false);
  });

  test("同時実行拒否: ダウンロード中に再度startすると409相当で拒否され、進行中の状態は壊れない", async () => {
    const content = makeContent(3);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();

    let releaseCtrl!: ReadableStreamDefaultController<Uint8Array>;
    const gatedStream = new ReadableStream<Uint8Array>({ start(c) { releaseCtrl = c; } });
    const fetchFn: typeof fetch = (async () => new Response(gatedStream as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });

    const first = mgr.start("small");
    expect(first.ok).toBe(true);
    expect(mgr.getState().status).toBe("downloading");

    const second = mgr.start("small");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.status).toBe(409);

    // 後片付け: ストリームを閉じて完了させる
    releaseCtrl.close();
    if (first.ok) await first.done;
  });
});

describe("model-download: 進捗ポーリング（チャンク到着ごとのreceivedBytes更新）", () => {
  test("chunkが届くたびにgetState().receivedBytesが増える", async () => {
    const chunkA = makeContent(100, 1);
    const chunkB = makeContent(150, 2);
    const content = new Uint8Array([...chunkA, ...chunkB]);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();

    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    const fetchFn: typeof fetch = (async () => new Response(stream as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });

    const result = mgr.start("small");
    expect(result.ok).toBe(true);
    await flush();
    expect(mgr.getState().receivedBytes).toBe(0);

    ctrl.enqueue(chunkA);
    await flush();
    expect(mgr.getState().receivedBytes).toBe(chunkA.length);
    expect(mgr.getState().status).toBe("downloading");

    ctrl.enqueue(chunkB);
    ctrl.close();
    if (result.ok) await result.done;
    expect(mgr.getState().status).toBe("done");
    expect(mgr.getState().receivedBytes).toBe(content.length);
  });
});

describe("model-download: 中断→再開（Range）", () => {
  test("ネットワーク中断でerror+resumable=trueになり、再startで続きからRange取得して完了する", async () => {
    const chunkA = makeContent(200, 9);
    const chunkB = makeContent(300, 5);
    const content = new Uint8Array([...chunkA, ...chunkB]);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();
    const calls: FetchCall[] = [];

    let ctrl1!: ReadableStreamDefaultController<Uint8Array>;
    let firstCall = true;
    const fetchFn: typeof fetch = (async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const range = headers.Range ?? null;
      calls.push({ url: String(url), range });
      if (firstCall) {
        firstCall = false;
        // 1回目: 外部から制御できるストリームを返す（chunkAが実際に読み出された後で切断するため）
        const s = new ReadableStream<Uint8Array>({ start(c) { ctrl1 = c; } });
        return new Response(s as unknown as BodyInit, { status: 200 });
      }
      // 2回目: Rangeに応じた残りを返す
      const m = range ? /^bytes=(\d+)-$/.exec(range) : null;
      const start = m ? Number(m[1]) : 0;
      return new Response(content.slice(start) as unknown as BodyInit, {
        status: 206, headers: { "content-range": `bytes ${start}-${content.length - 1}/${content.length}` },
      });
    }) as unknown as typeof fetch;

    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });

    const first = mgr.start("small");
    expect(first.ok).toBe(true);
    await flush();
    ctrl1.enqueue(chunkA);
    await flush();
    expect(mgr.getState().receivedBytes).toBe(chunkA.length); // 切断前にchunkAが確実に書き込まれたことを確認
    ctrl1.error(new Error("simulated network drop"));
    if (first.ok) await first.done;

    const afterFail = mgr.getState();
    expect(afterFail.status).toBe("error");
    expect(afterFail.resumable).toBe(true);
    expect(afterFail.receivedBytes).toBe(chunkA.length);
    expect(existsSync(path.join(dir, "ggml-small.bin.part"))).toBe(true);

    const second = mgr.start("small");
    expect(second.ok).toBe(true);
    if (second.ok) await second.done;

    expect(calls[1]?.range).toBe(`bytes=${chunkA.length}-`);
    const final = mgr.getState();
    expect(final.status).toBe("done");
    expect(final.receivedBytes).toBe(content.length);
    const finalPath = path.join(dir, "ggml-small.bin");
    expect(readFileSync(finalPath)).toEqual(Buffer.from(content));
  });

  test("サーバがRangeを無視して200で全body返却した場合は最初から書き直して完了する", async () => {
    const chunkA = makeContent(50, 1);
    const content = new Uint8Array([...chunkA, ...makeContent(80, 2)]);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();

    let ctrl1!: ReadableStreamDefaultController<Uint8Array>;
    let firstCall = true;
    const fetchFn: typeof fetch = (async () => {
      if (firstCall) {
        firstCall = false;
        const s = new ReadableStream<Uint8Array>({ start(c) { ctrl1 = c; } });
        return new Response(s as unknown as BodyInit, { status: 200 });
      }
      // Rangeを送っても200で全体を返す（無視するサーバを模す）
      return new Response(content as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });
    const first = mgr.start("small");
    await flush();
    ctrl1.enqueue(chunkA);
    await flush();
    ctrl1.error(new Error("drop"));
    if (first.ok) await first.done;
    expect(mgr.getState().status).toBe("error");

    const second = mgr.start("small");
    if (second.ok) await second.done;
    const state = mgr.getState();
    expect(state.status).toBe("done");
    expect(state.receivedBytes).toBe(content.length);
    expect(readFileSync(path.join(dir, "ggml-small.bin"))).toEqual(Buffer.from(content));
  });
});

describe("model-download: checksum不一致", () => {
  test("sha256が一致しなければerror状態になり、.partは削除・resumable=false", async () => {
    const content = makeContent(500);
    const registry = fakeRegistry(content);
    registry.small.sha256 = "0".repeat(64); // わざと不一致にする
    const dir = tmpModelsDir();
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn: makeSimpleFetch(content) });

    const result = mgr.start("small");
    if (result.ok) await result.done;

    const state = mgr.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("checksum mismatch");
    expect(state.resumable).toBe(false);
    expect(existsSync(path.join(dir, "ggml-small.bin.part"))).toBe(false);
    expect(existsSync(path.join(dir, "ggml-small.bin"))).toBe(false);
  });
});

describe("model-download: 完了済み.partの416ループ回避（レビュー指摘の再発防止）", () => {
  test("既に.partが完了サイズ(sizeBytes)ならstart()は再ネットワーク取得せず検証から再開する", async () => {
    const content = makeContent(500);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();
    // 「verify中にcancelされた」「検証完了直前でプロセスが落ちた」状態を直接再現する:
    // .partは全バイト揃っているがrename前
    writeFileSync(path.join(dir, "ggml-small.bin.part"), content);

    let fetchCalls = 0;
    const fetchFn: typeof fetch = (async () => {
      fetchCalls++;
      return new Response(content as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });

    const result = mgr.start("small");
    expect(result.ok).toBe(true);
    // 修正前は最初の状態が"downloading"のままRange: bytes=500-を送り、実サーバなら416で
    // ループしていた。修正後は直ちに"verifying"へ入り、fetchは一切呼ばれない。
    expect(mgr.getState().status).toBe("verifying");
    if (result.ok) await result.done;

    expect(fetchCalls).toBe(0);
    const final = mgr.getState();
    expect(final.status).toBe("done");
    expect(existsSync(path.join(dir, "ggml-small.bin"))).toBe(true);
    expect(existsSync(path.join(dir, "ggml-small.bin.part"))).toBe(false);
  });

  test("416応答（既存.part>0）は検証にフォールバックする。内容が実際には不完全ならchecksum不一致で.partを片付け、ループを断つ", async () => {
    const full = makeContent(1000, 3);
    const partial = full.slice(0, 500); // .partは500バイトしか無い（本当は不完全）
    const registry = fakeRegistry(full); // sizeBytes=1000・sha256=full全体のハッシュ
    const dir = tmpModelsDir();
    writeFileSync(path.join(dir, "ggml-small.bin.part"), partial);

    // どんなRangeでも416を返す壊れたサーバを模す（start()の直行分岐が効かない状況、
    // 例えばレジストリのsizeBytesが実サーバとズレているケース、を再現するための直接的なfetch fake）
    const fetchFn: typeof fetch = (async () => new Response("range not satisfiable", { status: 416 })) as unknown as typeof fetch;
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });

    const result = mgr.start("small");
    expect(result.ok).toBe(true);
    expect(mgr.getState().status).toBe("downloading"); // existingBytes(500) < sizeBytes(1000) なので直行分岐は通らない
    if (result.ok) await result.done;

    const state = mgr.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("checksum mismatch");
    expect(state.resumable).toBe(false);
    // .partが削除されている = 次回start()はRangeを送らず最初から取得する（416ループが解消されている）
    expect(existsSync(path.join(dir, "ggml-small.bin.part"))).toBe(false);
  });
});

describe("model-download: 再開時の空き容量チェック", () => {
  test("既存.partの分を差し引いた残り必要分だけをチェックする（差し引かなければ通らない設定で検証）", () => {
    const content = makeContent(1000);
    const registry = fakeRegistry(content); // sizeBytes=1000
    const dir = tmpModelsDir();
    writeFileSync(path.join(dir, "ggml-small.bin.part"), content.slice(0, 900)); // 残り100バイト

    // 残り100バイト×1.2倍=120は満たすが、全体1000バイト×1.2倍=1200は満たさない空き容量
    const mgr = createModelDownloadManager({
      modelsDir: dir, registry, fetchFn: makeSimpleFetch(content), freeBytesFn: () => 150,
    });

    const result = mgr.start("small");
    expect(result.ok).toBe(true);
  });

  test("既存.partが無い場合は従来どおりsizeBytes全体×1.2倍で判定する", () => {
    const content = makeContent(1000);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();

    const mgr = createModelDownloadManager({
      modelsDir: dir, registry, fetchFn: makeSimpleFetch(content), freeBytesFn: () => 150,
    });

    const result = mgr.start("small");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(507);
  });
});

describe("model-download: cancel", () => {
  test("ダウンロード中にcancelすると即座にidleへ戻り、後続チャンクは無視される", async () => {
    const content = makeContent(100);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();

    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; } });
    const fetchFn: typeof fetch = (async () => new Response(stream as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });

    const result = mgr.start("small");
    expect(result.ok).toBe(true);
    await flush();

    mgr.cancel();
    expect(mgr.getState()).toEqual({
      status: "idle", model: null, receivedBytes: 0, totalBytes: 0, error: null, resumable: false,
    });

    // cancel後にchunkが届いても状態は汚染されない
    ctrl.enqueue(makeContent(10));
    ctrl.close();
    await flush();
    expect(mgr.getState().status).toBe("idle");
  });

  test("何もダウンロードしていない時のcancelはno-op", () => {
    const content = makeContent(10);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn: makeSimpleFetch(content) });
    mgr.cancel();
    expect(mgr.getState().status).toBe("idle");
  });
});

describe("model-download: HTTPエラー", () => {
  test("404等の非2xxはerror状態になりresumable=true（.partが無ければ次回は最初から）", async () => {
    const content = makeContent(10);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();
    const fetchFn: typeof fetch = (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch;
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });

    const result = mgr.start("small");
    if (result.ok) await result.done;
    const state = mgr.getState();
    expect(state.status).toBe("error");
    expect(state.error).toContain("404");
  });
});

describe("model-download: stream受信サイズ上限", () => {
  test("Content-Lengthなしのchunked responseが期待サイズを超えた時点で中止しpartを破棄する", async () => {
    const expected = makeContent(10, 1);
    const registry = fakeRegistry(expected);
    const dir = tmpModelsDir();
    let cancelled = false;
    let signal: AbortSignal | undefined;
    const fetchFn: typeof fetch = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(makeContent(6, 1));
          controller.enqueue(makeContent(5, 1));
        },
        cancel() { cancelled = true; },
      });
      return new Response(stream as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });

    const result = mgr.start("small");
    if (result.ok) await result.done;

    expect(mgr.getState()).toMatchObject({
      status: "error", receivedBytes: 0, resumable: false,
      error: expect.stringContaining("exceeds expected size"),
    });
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(existsSync(path.join(dir, "ggml-small.bin.part"))).toBe(false);
  });

  test("虚偽の小さいContent-Lengthでも実chunk累積値で上限超過を検出する", async () => {
    const expected = makeContent(10, 2);
    const registry = fakeRegistry(expected);
    const dir = tmpModelsDir();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(makeContent(11, 2));
        controller.close();
      },
    });
    const fetchFn: typeof fetch = (async () => new Response(stream as unknown as BodyInit, {
      status: 200,
      headers: { "content-length": "5" },
    })) as unknown as typeof fetch;
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });

    const result = mgr.start("small");
    if (result.ok) await result.done;

    expect(mgr.getState()).toMatchObject({ status: "error", receivedBytes: 0, resumable: false });
    expect(existsSync(path.join(dir, "ggml-small.bin.part"))).toBe(false);
  });

  test("上限超過を宣言したContent-Lengthはstreamを読む前に拒否する", async () => {
    const expected = makeContent(10, 3);
    const registry = fakeRegistry(expected);
    const dir = tmpModelsDir();
    let pulls = 0;
    let signal: AbortSignal | undefined;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(makeContent(11, 3));
        controller.close();
      },
    });
    const fetchFn: typeof fetch = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Response(stream as unknown as BodyInit, {
        status: 200,
        headers: { "content-length": "11" },
      });
    }) as unknown as typeof fetch;
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn });

    const result = mgr.start("small");
    if (result.ok) await result.done;

    expect(mgr.getState()).toMatchObject({ status: "error", receivedBytes: 0, resumable: false });
    expect(signal?.aborted).toBe(true);
    // ReadableStream自体の初期pull 1回を除き、managerはbodyを読み進めない。
    expect(pulls).toBe(1);
    expect(existsSync(path.join(dir, "ggml-small.bin.part"))).toBe(false);
  });
});

describe("model-download: diskFreeBytes", () => {
  test("freeBytesFnの値をそのまま返す", () => {
    const content = makeContent(10);
    const registry = fakeRegistry(content);
    const dir = tmpModelsDir();
    const mgr = createModelDownloadManager({ modelsDir: dir, registry, fetchFn: makeSimpleFetch(content), freeBytesFn: () => 123456 });
    expect(mgr.diskFreeBytes()).toBe(123456);
  });
});

describe("model-download: レジストリ既定値（実配布のURL/サイズ/sha256のピン留め）", () => {
  test("large-v3-turbo / small のURL・サイズ・sha256が既知の値と一致する", async () => {
    const { WHISPER_MODEL_REGISTRY } = await import("../model-download");
    expect(WHISPER_MODEL_REGISTRY["large-v3-turbo"]).toEqual({
      id: "large-v3-turbo",
      filename: "ggml-large-v3-turbo.bin",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin",
      sizeBytes: 1_624_555_275,
      sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
    });
    expect(WHISPER_MODEL_REGISTRY.small).toEqual({
      id: "small",
      filename: "ggml-small.bin",
      url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
      sizeBytes: 487_601_967,
      sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    });
  });
});
