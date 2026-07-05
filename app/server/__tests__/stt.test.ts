import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildWhisperArgs, parseWhisperJson, transcribeAudio, type SpawnFn } from "../stt";

type FakeSpawnResult = { exitCode: number; stderr: string };

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
        options.whisperJson ?? JSON.stringify({ transcription: [{ text: " Hi." }] }),
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

  test("parseWhisperJson は transcription の text を結合して trim する", () => {
    const json = JSON.stringify({
      transcription: [
        { text: " Hello, my name is", offsets: { from: 0, to: 1200 } },
        { text: " Shin.", offsets: { from: 1200, to: 2000 } },
      ],
    });
    expect(parseWhisperJson(json)).toBe("Hello, my name is Shin.");
  });

  test("parseWhisperJson は transcription が無ければ空文字", () => {
    expect(parseWhisperJson("{}")).toBe("");
  });

  test("transcribeAudio は注入したspawnFnでffmpeg→whisperの順に実行し、結果テキストを返す", async () => {
    const inputPath = "/in/input.webm";
    const { spawnFn, calls } = makeFakeSpawn({});

    const text = await transcribeAudio(inputPath, { spawnFn });

    expect(text).toBe("Hi.");
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

    await expect(transcribeAudio("/in/input.webm", { spawnFn })).rejects.toThrow(/ffmpeg failed/);
    expect(calls.length).toBe(1);
  });

  test("whisper が失敗したら whisper failed で reject される", async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      whisperResult: { exitCode: 1, stderr: "boom" },
    });

    await expect(transcribeAudio("/in/input.webm", { spawnFn })).rejects.toThrow(/whisper failed/);
    expect(calls.length).toBe(2);
  });

  test("失敗時は一時作業ディレクトリが掃除される", async () => {
    const { spawnFn, calls } = makeFakeSpawn({
      ffmpegResult: { exitCode: 1, stderr: "boom" },
    });

    await expect(transcribeAudio("/in/input.webm", { spawnFn })).rejects.toThrow(/ffmpeg failed/);

    const ffmpegCmd = calls[0];
    const wavPath = ffmpegCmd[ffmpegCmd.length - 2];
    const workDir = path.dirname(wavPath);
    expect(existsSync(workDir)).toBe(false);
  });
});
