import { useEffect, useState } from "react";
import { serializeClientError } from "../api/http";
import { formatClientError } from "../lib/user-error";

/**
 * Tauri Phase 1 Task 3: 録音→STT 縦切りPoC専用ページ（dev限定・?poc=stt でのみ main.tsx から描画される）。
 * 本番UI（App.tsx）には一切組み込まない。WKWebViewでのMediaRecorder互換を実測し、
 * 対応mimeType一覧・選択結果・3秒録音→/api/stt の実応答を画面表示 + /api/dev/poc-result へ記録する。
 */

const CANDIDATE_MIME_TYPES = [
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/mp4",
  "audio/mp4;codecs=mp4a.40.2",
  "audio/aac",
  "audio/wav",
];

const RECORD_MS = 3000;

type SupportEntry = { mimeType: string; supported: boolean };
type SttOutcome = { ok: true; text: string } | { ok: false; error: string };
type PocResult = {
  supported: SupportEntry[];
  chosenMimeType: string | null;
  blobSize: number | null;
  stt: SttOutcome | null;
  getUserMediaError: string | null;
};

async function postPocResult(result: unknown): Promise<void> {
  try {
    await fetch("/api/dev/poc-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(result),
    });
  } catch {
    // 記録の失敗はPoC結果の画面表示自体を妨げない（画面表示が一次情報）
  }
}

async function runPoc(): Promise<PocResult> {
  const supported: SupportEntry[] = CANDIDATE_MIME_TYPES.map((mimeType) => ({
    mimeType,
    supported: typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(mimeType),
  }));
  const chosenMimeType = supported.find((s) => s.supported)?.mimeType ?? null;

  // getUserMediaはマイク許可(TCC)ダイアログでブロックされうるため、対応mimeType一覧だけは
  // 許可を待たずに先行記録する（PoCの核心である「WKWebViewはaudio/mp4系を録音できるか」は
  // これだけで判定できる）。最終レコード（下のreturn値）とは別の早期POST。
  void postPocResult({ phase: "support-matrix", supported, chosenMimeType });

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    return {
      supported, chosenMimeType, blobSize: null, stt: null,
      getUserMediaError: serializeClientError(err),
    };
  }

  if (!chosenMimeType) {
    stream.getTracks().forEach((t) => t.stop());
    return { supported, chosenMimeType: null, blobSize: null, stt: null, getUserMediaError: null };
  }

  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: chosenMimeType });
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  recorder.start();
  await new Promise((r) => setTimeout(r, RECORD_MS));
  recorder.stop();
  await stopped;
  stream.getTracks().forEach((t) => t.stop());

  const blob = new Blob(chunks, { type: chosenMimeType });
  let stt: SttOutcome;
  try {
    const res = await fetch("/api/stt", {
      method: "POST",
      headers: { "content-type": blob.type || chosenMimeType },
      body: blob,
    });
    if (!res.ok) throw new Error(`STT failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { text: string };
    stt = { ok: true, text: data.text };
  } catch (err) {
    stt = { ok: false, error: serializeClientError(err) };
  }

  return { supported, chosenMimeType, blobSize: blob.size, stt, getUserMediaError: null };
}

export function PocSttPage() {
  const [result, setResult] = useState<PocResult | null>(null);
  const [phase, setPhase] = useState<"running" | "done">("running");

  useEffect(() => {
    let cancelled = false;
    runPoc().then((r) => {
      if (cancelled) return;
      setResult(r);
      setPhase("done");
      void postPocResult(r);
    });
    return () => { cancelled = true; };
  }, []);

  return (
    <div style={{ fontFamily: "monospace", padding: 16, whiteSpace: "pre-wrap" }}>
      <h1>録音→STT PoC（dev専用・?poc=stt）</h1>
      <p>status: {phase}</p>
      {result && (
        <>
          <h2>MediaRecorder.isTypeSupported</h2>
          <ul>
            {result.supported.map((s) => (
              <li key={s.mimeType}>{s.supported ? "✓" : "×"} {s.mimeType}</li>
            ))}
          </ul>
          <p>chosenMimeType: {result.chosenMimeType ?? "(none supported)"}</p>
          <p>blobSize: {result.blobSize ?? "-"}</p>
          {result.getUserMediaError && <p>getUserMedia error: {formatClientError("ja", result.getUserMediaError, "record")}</p>}
          {result.stt && (
            result.stt.ok
              ? <p>STT text: "{result.stt.text}"</p>
              : <p>STT error: {formatClientError("ja", result.stt.error, "record")}</p>
          )}
        </>
      )}
    </div>
  );
}
