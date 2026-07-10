import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  anyWhisperModelInstalled, buildWhisperArgs, detectAudioContainer, parseWhisperJson,
  resolveWhisperModelPath, selectConverter, transcribeAudio, UnsupportedAudioContainerError, type SpawnFn,
} from "../stt";
import { realSpawn } from "../spawn";

type FakeSpawnResult = { exitCode: number; stderr: string };
const fakeFfmpegAvailable = (binary: string) => binary === "ffmpeg" ? "/fake/ffmpeg" : null;

/**
 * ffmpeg/whisper の実行をシミュレートする fake spawnFn を作る。
 * whisper 呼び出しが成功する場合は `-of` の次の引数（outBase）に
 * `${outBase}.json` を実際に書き出し、transcribeAudio の readFileSync を満たす。
 */
function makeFakeSpawn(options: {
  ffmpegResult?: FakeSpawnResult;
  whisperResult?: FakeSpawnResult;
  whisperJson?: string;
}): { spawnFn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawnFn: SpawnFn = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === "ffmpeg") {
      return options.ffmpegResult ?? { exitCode: 0, stderr: "" };
    }
    const whisperResult = options.whisperResult ?? { exitCode: 0, stderr: "" };
    if (whisperResult.exitCode === 0) {
      const ofIndex = cmd.indexOf("-of");
      const outBase = cmd[ofIndex + 1];
      writeFileSync(
        `${outBase}.json`,
        options.whisperJson ?? JSON.stringify({ transcription: [{ text: " Hi.", offsets: { from: 0, to: 800 } }] }),
      );
    }
    return whisperResult;
  };
  return { spawnFn, calls };
}

describe("stt", () => {
  test("buildWhisperArgs は英語専用・JSON出力の引数列を組み立てる", () => {
    const args = buildWhisperArgs("/m/model.bin", "/tmp/in.wav", "/tmp/out");
    expect(args).toEqual([
      "-m", "/m/model.bin",
      "-f", "/tmp/in.wav",
      "-l", "en",
      "-oj",
      "-of", "/tmp/out",
      "-np",
    ]);
  });

  test("parseWhisperJson は text と segments を両方返す", () => {
    const json = JSON.stringify({
      transcription: [
        { text: " Hello there", offsets: { from: 0, to: 1200 } },
        { text: " how are you", offsets: { from: 1500, to: 2800 } },
      ],
    });
    expect(parseWhisperJson(json)).toEqual({
      text: "Hello there how are you",
      segments: [
        { fromMs: 0, toMs: 1200, text: " Hello there" },
        { fromMs: 1500, toMs: 2800, text: " how are you" },
      ],
    });
  });

  test("parseWhisperJson は offsets 欠落を 0 で補い、transcription 欠落は空を返す", () => {
    expect(parseWhisperJson(JSON.stringify({ transcription: [{ text: "Hi" }] }))).toEqual({
      text: "Hi",
      segments: [{ fromMs: 0, toMs: 0, text: "Hi" }],
    });
    expect(parseWhisperJson(JSON.stringify({}))).toEqual({ text: "", segments: [] });
  });

  test("transcribeAudio は注入したspawnFnでffmpeg→whisperの順に実行し、結果テキストを返す", async () => {
    const inputPath = "/in/input.webm";
    const { spawnFn, calls } = makeFakeSpawn({});

    const result = await transcribeAudio(inputPath, { spawnFn, whichFn: fakeFfmpegAvailable });

    expect(result.text).toBe("Hi.");
    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual([
      "ffmpeg", "-i", inputPath,
      "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
      expect.stringMatching(/in\.wav$/),
      "-y",
    ]);
    expect(calls[1]).toContain("-l");
    expect(calls[1]).toContain("en");
    expect(calls[1]).toContain("-oj");
  });

  test("ffmpeg が失敗したら ffmpeg failed で reject される", async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      ffmpegResult: { exitCode: 1, stderr: "boom" },
    });

    await expect(transcribeAudio("/in/input.webm", { spawnFn, whichFn: fakeFfmpegAvailable }))
      .rejects.toThrow(/ffmpeg failed/);
    expect(calls.length).toBe(1);
  });

  test("whisper が失敗したら whisper failed で reject される", async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      whisperResult: { exitCode: 1, stderr: "boom" },
    });

    await expect(transcribeAudio("/in/input.webm", { spawnFn, whichFn: fakeFfmpegAvailable }))
      .rejects.toThrow(/whisper failed/);
    expect(calls.length).toBe(2);
  });

  test("失敗時は一時作業ディレクトリが掃除される", async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      ffmpegResult: { exitCode: 1, stderr: "boom" },
    });

    await expect(transcribeAudio("/in/input.webm", { spawnFn, whichFn: fakeFfmpegAvailable }))
      .rejects.toThrow(/ffmpeg failed/);

    const ffmpegCmd = calls[0];
    const wavPath = ffmpegCmd[ffmpegCmd.length - 2];
    const workDir = path.dirname(wavPath);
    expect(existsSync(workDir)).toBe(false);
  });
});

/**
 * ffmpeg/afconvert/whisper の実行をシミュレートする fake spawnFn（変換器バイナリを明示的に選べる版）。
 * makeFakeSpawn は cmd[0]==="ffmpeg" 固定判定のため afconvert 経路のテストには使えない。
 */
function makeFakeConverterSpawn(options: {
  converterBin: "ffmpeg" | "afconvert";
  converterResult?: FakeSpawnResult;
  whisperResult?: FakeSpawnResult;
  whisperJson?: string;
}): { spawnFn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const spawnFn: SpawnFn = async (cmd) => {
    calls.push(cmd);
    if (cmd[0] === options.converterBin) {
      return options.converterResult ?? { exitCode: 0, stderr: "" };
    }
    const whisperResult = options.whisperResult ?? { exitCode: 0, stderr: "" };
    if (whisperResult.exitCode === 0) {
      const ofIndex = cmd.indexOf("-of");
      const outBase = cmd[ofIndex + 1];
      writeFileSync(
        `${outBase}.json`,
        options.whisperJson ?? JSON.stringify({ transcription: [{ text: " Hi.", offsets: { from: 0, to: 800 } }] }),
      );
    }
    return whisperResult;
  };
  return { spawnFn, calls };
}

describe("detectAudioContainer", () => {
  test("content-type ヘッダを最優先で判定する", () => {
    expect(detectAudioContainer("audio/webm", new Uint8Array())).toBe("webm");
    expect(detectAudioContainer("audio/webm;codecs=opus", new Uint8Array())).toBe("webm");
    expect(detectAudioContainer("audio/mp4", new Uint8Array())).toBe("mp4");
    expect(detectAudioContainer("audio/mp4;codecs=mp4a.40.2", new Uint8Array())).toBe("mp4");
    expect(detectAudioContainer("audio/x-m4a", new Uint8Array())).toBe("mp4");
    expect(detectAudioContainer("audio/mpeg", new Uint8Array())).toBe("mp3");
    expect(detectAudioContainer("audio/wav", new Uint8Array())).toBe("wav");
  });

  test("content-type が無い/汎用な場合はマジックナンバーで判定する", () => {
    // ftyp ボックス（`say -o` で生成した実m4aの先頭12バイトと同形）
    const ftyp = new Uint8Array([0x00, 0x00, 0x00, 0x1c, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20]);
    expect(detectAudioContainer(null, ftyp)).toBe("mp4");
    expect(detectAudioContainer("application/octet-stream", ftyp)).toBe("mp4");

    const ebml = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
    expect(detectAudioContainer(null, ebml)).toBe("webm");

    const riff = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(detectAudioContainer(null, riff)).toBe("wav");

    const id3 = new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0]);
    expect(detectAudioContainer(null, id3)).toBe("mp3");

    expect(detectAudioContainer(null, new Uint8Array([1, 2, 3]))).toBe("unknown");
    expect(detectAudioContainer(null, new Uint8Array())).toBe("unknown");
  });
});

describe("selectConverter", () => {
  test("ffmpeg があれば container によらず ffmpeg を選ぶ（従来経路優先）", () => {
    const which = (b: string) => (b === "ffmpeg" ? "/usr/bin/ffmpeg" : null);
    expect(selectConverter("webm", { whichFn: which })).toBe("ffmpeg");
    expect(selectConverter("mp4", { whichFn: which })).toBe("ffmpeg");
    expect(selectConverter("mp3", { whichFn: which })).toBe("ffmpeg");
    expect(selectConverter("wav", { whichFn: which })).toBe("ffmpeg");
    expect(selectConverter("unknown", { whichFn: which })).toBe("ffmpeg");
  });

  test("ffmpeg が無ければ mp4/mp3 は afconvert・webm/wav/unknown は変換器なし", () => {
    const noFfmpeg = () => null;
    expect(selectConverter("mp4", { whichFn: noFfmpeg })).toBe("afconvert");
    expect(selectConverter("mp3", { whichFn: noFfmpeg })).toBe("afconvert");
    expect(selectConverter("webm", { whichFn: noFfmpeg })).toBeNull();
    expect(selectConverter("wav", { whichFn: noFfmpeg })).toBeNull();
    expect(selectConverter("unknown", { whichFn: noFfmpeg })).toBeNull();
  });
});

describe("transcribeAudio: 変換器選択（ffmpeg不在時の afconvert 経路 / webm拒否）", () => {
  test("ffmpegが無くwebm入力ならUnsupportedAudioContainerErrorでrejectされ、spawnは一切呼ばれない", async () => {
    const calls: string[][] = [];
    const spawnFn: SpawnFn = async (cmd) => { calls.push(cmd); return { exitCode: 0, stderr: "" }; };

    await expect(
      transcribeAudio("/in/input.webm", { spawnFn, whichFn: () => null, container: "webm" }),
    ).rejects.toThrow(UnsupportedAudioContainerError);
    expect(calls.length).toBe(0);
  });

  test("エラーメッセージはこの環境でmp4録音が必要である旨を明示する", async () => {
    const spawnFn: SpawnFn = async () => ({ exitCode: 0, stderr: "" });
    await expect(
      transcribeAudio("/in/input.webm", { spawnFn, whichFn: () => null, container: "webm" }),
    ).rejects.toThrow(/mp4 録音が必要/);
  });

  test("ffmpegが無くmp4入力ならafconvertコマンドを組み立てて実行し、結果テキストを返す", async () => {
    const { spawnFn, calls } = makeFakeConverterSpawn({ converterBin: "afconvert" });

    const result = await transcribeAudio(
      "/in/input.mp4", { spawnFn, whichFn: () => null, container: "mp4" },
    );

    expect(result.text).toBe("Hi.");
    expect(calls[0]).toEqual([
      "afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1",
      "/in/input.mp4", expect.stringMatching(/in\.wav$/),
    ]);
  });

  test("afconvertが失敗したらafconvert failedでrejectされる", async () => {
    const { spawnFn, calls } = makeFakeConverterSpawn({
      converterBin: "afconvert",
      converterResult: { exitCode: 1, stderr: "boom" },
    });

    await expect(
      transcribeAudio("/in/input.mp4", { spawnFn, whichFn: () => null, container: "mp4" }),
    ).rejects.toThrow(/afconvert failed/);
    expect(calls.length).toBe(1);
  });

  test("ffmpegがあればcontainerがmp4でもffmpegを使う（従来経路が優先される）", async () => {
    const { spawnFn, calls } = makeFakeSpawn({});

    const result = await transcribeAudio(
      "/in/input.mp4",
      { spawnFn, whichFn: (b) => (b === "ffmpeg" ? "/usr/bin/ffmpeg" : null), container: "mp4" },
    );

    expect(result.text).toBe("Hi.");
    expect(calls[0][0]).toBe("ffmpeg");
  });
});

describe("resolveWhisperModelPath: Tauri Phase 2 Task 4 の初回DLモデル選択に対応した優先順位解決", () => {
  test("large-v3-turboが存在すれば最優先で返す（smallも存在していても）", () => {
    const p = resolveWhisperModelPath("/models", (path) =>
      path === "/models/ggml-large-v3-turbo.bin" || path === "/models/ggml-small.bin");
    expect(p).toBe("/models/ggml-large-v3-turbo.bin");
  });

  test("large-v3-turboが無くsmallのみ存在するならsmallを返す", () => {
    const p = resolveWhisperModelPath("/models", (path) => path === "/models/ggml-small.bin");
    expect(p).toBe("/models/ggml-small.bin");
  });

  test("どちらも存在しない場合は従来どおりlarge-v3-turboのパスを返す（未導入時のエラー箇所を変えないため）", () => {
    const p = resolveWhisperModelPath("/models", () => false);
    expect(p).toBe("/models/ggml-large-v3-turbo.bin");
  });
});

describe("anyWhisperModelInstalled: health.modelFile用（サポート対象のいずれか1つでも導入済みか）", () => {
  test("large-v3-turboのみ存在 → true", () => {
    expect(anyWhisperModelInstalled("/models", (p) => p === "/models/ggml-large-v3-turbo.bin")).toBe(true);
  });

  test("smallのみ存在 → true", () => {
    expect(anyWhisperModelInstalled("/models", (p) => p === "/models/ggml-small.bin")).toBe(true);
  });

  test("どちらも無い → false", () => {
    expect(anyWhisperModelInstalled("/models", () => false)).toBe(false);
  });
});

describe("afconvert: 実ファイル検証（`say -o` で生成した実m4aフィクスチャ）", () => {
  test("実afconvertが実m4aを16kHzモノラルWAVへ変換できる（whisper呼び出しはフェイクでモデル依存を避ける）", async () => {
    const work = mkdtempSync(path.join(tmpdir(), "stt-afconvert-fixture-"));
    const m4aPath = path.join(work, "fixture.m4a");
    try {
      execFileSync("say", [
        "-o", m4aPath, "--file-format=m4af", "--data-format=aac", "afconvert unit test fixture.",
      ]);
      expect(existsSync(m4aPath)).toBe(true);

      const hybridSpawn: SpawnFn = async (cmd) => {
        if (cmd[0] === "afconvert") return realSpawn(cmd); // ここだけ実プロセスで変換を検証する
        const ofIndex = cmd.indexOf("-of");
        const outBase = cmd[ofIndex + 1];
        writeFileSync(`${outBase}.json`, JSON.stringify({ transcription: [{ text: " ok", offsets: { from: 0, to: 100 } }] }));
        return { exitCode: 0, stderr: "" };
      };

      const result = await transcribeAudio(m4aPath, { spawnFn: hybridSpawn, whichFn: () => null, container: "mp4" });
      expect(result.text).toBe("ok");
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 15000);
});
