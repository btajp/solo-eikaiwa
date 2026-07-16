import { describe, expect, test } from "bun:test";
import { FreeTalkPipeline } from "./free-talk-flow";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let index = 0; index < 4; index++) await Promise.resolve();
}

test("STT失敗後は同じ録音だけを再送し、成功するまで発話を確定しない", async () => {
  const firstStt = deferred<string>();
  const secondStt = deferred<string>();
  const recordings: Blob[] = [];
  const users: string[] = [];
  let sttAttempt = 0;
  const pipeline = new FreeTalkPipeline({
    transcribe: (recording) => {
      recordings.push(recording);
      return sttAttempt++ === 0 ? firstStt.promise : secondStt.promise;
    },
    requestReply: async () => ({ replyText: "Hi there!", sessionId: "s1" }),
    createAudio: async () => new Blob(["audio"]),
    playAudio: async () => {},
    onUser: (text) => users.push(text),
  });
  const recording = new Blob(["recording"]);

  const first = pipeline.submitRecording(recording);
  expect(pipeline.state.phase).toBe("transcribing");
  firstStt.reject(new Error("STT unavailable"));
  await first;
  expect(pipeline.state.phase).toBe("stt-retry");
  expect(users).toEqual([]);

  const retry = pipeline.retry();
  expect(pipeline.state.phase).toBe("transcribing");
  secondStt.resolve("I need help.");
  await retry;
  expect(recordings).toEqual([recording, recording]);
  expect(users).toEqual(["I need help."]);
  expect(pipeline.state.phase).toBe("idle");
});

test("会話生成の失敗を再試行しても、確定済みのuser turnを二重追加しない", async () => {
  const firstReply = deferred<{ replyText: string; sessionId: string }>();
  const secondReply = deferred<{ replyText: string; sessionId: string }>();
  const users: string[] = [];
  const replies: string[] = [];
  const requests: Array<[string, string | undefined]> = [];
  let replyAttempt = 0;
  const pipeline = new FreeTalkPipeline({
    transcribe: async () => "Could you help me?",
    requestReply: (text, sessionId) => {
      requests.push([text, sessionId]);
      return replyAttempt++ === 0 ? firstReply.promise : secondReply.promise;
    },
    createAudio: async () => new Blob(["audio"]),
    playAudio: async () => {},
    onUser: (text) => users.push(text),
    onReply: (text) => replies.push(text),
  });

  const first = pipeline.submitRecording(new Blob(["recording"]));
  await flush();
  expect(pipeline.state.phase).toBe("thinking");
  expect(users).toEqual(["Could you help me?"]);
  firstReply.reject(new Error("LLM unavailable"));
  await first;
  expect(pipeline.state.phase).toBe("reply-retry");

  const retry = pipeline.retry();
  await flush();
  secondReply.resolve({ replyText: "Sure, I can help.", sessionId: "conversation-1" });
  await retry;
  expect(users).toEqual(["Could you help me?"]);
  expect(replies).toEqual(["Sure, I can help."]);
  expect(requests).toEqual([
    ["Could you help me?", undefined],
    ["Could you help me?", undefined],
  ]);
});

test("TTS失敗時はAI返答を保持し、音声だけを再取得して再試行する", async () => {
  const firstAudio = deferred<Blob>();
  const secondAudio = deferred<Blob>();
  const replies: string[] = [];
  let audioAttempt = 0;
  let replyCalls = 0;
  const pipeline = new FreeTalkPipeline({
    transcribe: async () => "Hello",
    requestReply: async () => { replyCalls++; return { replyText: "Hello!", sessionId: "s1" }; },
    createAudio: () => audioAttempt++ === 0 ? firstAudio.promise : secondAudio.promise,
    playAudio: async () => {},
    onReply: (text) => replies.push(text),
  });

  const first = pipeline.submitRecording(new Blob(["recording"]));
  await flush();
  firstAudio.reject(new Error("TTS unavailable"));
  await first;
  expect(pipeline.state.phase).toBe("audio-retry");
  expect(pipeline.state.replyText).toBe("Hello!");
  expect(replies).toEqual(["Hello!"]);

  const retry = pipeline.retry();
  await flush();
  secondAudio.resolve(new Blob(["audio"]));
  await retry;
  expect(replyCalls).toBe(1);
  expect(replies).toEqual(["Hello!"]);
  expect(pipeline.state.phase).toBe("idle");
});

test("再生失敗時は取得済みBlobを再生するだけで、TTSと会話をやり直さない", async () => {
  const firstPlayback = deferred<void>();
  const secondPlayback = deferred<void>();
  const audio = new Blob(["audio"]);
  let audioCalls = 0;
  let replyCalls = 0;
  let playbackCalls = 0;
  const pipeline = new FreeTalkPipeline({
    transcribe: async () => "Hello",
    requestReply: async () => { replyCalls++; return { replyText: "Hello!", sessionId: "s1" }; },
    createAudio: async () => { audioCalls++; return audio; },
    playAudio: () => playbackCalls++ === 0 ? firstPlayback.promise : secondPlayback.promise,
  });

  const first = pipeline.submitRecording(new Blob(["recording"]));
  await flush();
  firstPlayback.reject(new Error("Playback unavailable"));
  await first;
  expect(pipeline.state.phase).toBe("audio-retry");
  expect(pipeline.state.audioBlob).toBe(audio);

  const retry = pipeline.retry();
  await flush();
  secondPlayback.resolve();
  await retry;
  expect(replyCalls).toBe(1);
  expect(audioCalls).toBe(1);
  expect(playbackCalls).toBe(2);
});

test("処理中の再試行要求は、進行中の要求を無効化しない", async () => {
  const stt = deferred<string>();
  const users: string[] = [];
  const pipeline = new FreeTalkPipeline({
    transcribe: () => stt.promise,
    requestReply: async () => ({ replyText: "Hi!", sessionId: "s1" }),
    createAudio: async () => new Blob(["audio"]),
    playAudio: async () => {},
    onUser: (text) => users.push(text),
  });

  const submitting = pipeline.submitRecording(new Blob(["recording"]));
  await pipeline.retry();
  stt.resolve("Hello");
  await submitting;
  expect(users).toEqual(["Hello"]);
  expect(pipeline.state.phase).toBe("idle");
});

test("cancel() は進行中の会話要求のAbortSignalを中断する（#189）", async () => {
  const reply = deferred<{ replyText: string; sessionId: string }>();
  const signals: Array<AbortSignal | undefined> = [];
  const pipeline = new FreeTalkPipeline({
    transcribe: async () => "Hello",
    requestReply: (_text, _sessionId, signal) => {
      signals.push(signal);
      return reply.promise;
    },
    createAudio: async () => new Blob(["audio"]),
    playAudio: async () => {},
  });

  const run = pipeline.submitRecording(new Blob(["recording"]));
  await flush();
  expect(pipeline.state.phase).toBe("thinking");
  expect(signals[0]).toBeDefined();
  expect(signals[0]!.aborted).toBe(false);

  pipeline.cancel();
  expect(signals[0]!.aborted).toBe(true);

  reply.reject(new Error("aborted"));
  await run;
  // cancel後の失敗はUI状態へ反映しない（unmount済みの画面を触らない既存規約）
  expect(pipeline.state.failure).toBeNull();
});

test("reset() も進行中の会話要求を中断し、再試行の新要求は新しいsignalを持つ", async () => {
  const firstReply = deferred<{ replyText: string; sessionId: string }>();
  const signals: AbortSignal[] = [];
  let replyAttempt = 0;
  const pipeline = new FreeTalkPipeline({
    transcribe: async () => "Hello",
    requestReply: (_text, _sessionId, signal) => {
      signals.push(signal!);
      return replyAttempt++ === 0 ? firstReply.promise : Promise.resolve({ replyText: "Hi!", sessionId: "s1" });
    },
    createAudio: async () => new Blob(["audio"]),
    playAudio: async () => {},
  });

  const run = pipeline.submitRecording(new Blob(["recording"]));
  await flush();
  pipeline.reset();
  expect(signals[0].aborted).toBe(true);
  firstReply.reject(new Error("aborted"));
  await run;

  const second = pipeline.submitRecording(new Blob(["recording-2"]));
  await flush();
  expect(signals[1]).toBeDefined();
  expect(signals[1].aborted).toBe(false);
  await second;
  expect(pipeline.state.phase).toBe("idle");
});
