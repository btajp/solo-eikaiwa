import { useEffect, useRef, useState } from "react";
import { playTtsCached } from "./api";
import { reportClientError, serializeClientError } from "./api/http";
import { stopPlayback } from "./audio";

/**
 * リスト各行の音声再生（テキスト単位TTS）の共通フック。再生中の行キーを保持し、
 * 再生失敗を error 文字列へ整形する。アンマウント時に stopPlayback する。
 * K は行を一意に識別する値の型（例文の no・チャンクの id・チャンクリストの index 等）。
 */
export function usePlayRow<K>(): {
  playingKey: K | null;
  error: string;
  play: (key: K, text: string) => Promise<void>;
  stop: () => void;
} {
  const [playingKey, setPlayingKey] = useState<K | null>(null);
  const [error, setError] = useState("");
  const aliveRef = useRef(true);
  // 停止・再生し直し後に古い再生の finally が新しい表示を消さないよう、世代で所有者を区別する。
  const generationRef = useRef(0);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      generationRef.current++;
      stopPlayback();
    };
  }, []);

  function stop() {
    generationRef.current++;
    stopPlayback();
    if (!aliveRef.current) return;
    setPlayingKey(null);
    setError("");
  }

  async function play(key: K, text: string) {
    const generation = ++generationRef.current;
    setError("");
    setPlayingKey(key);
    try {
      await playTtsCached(text);
    } catch (err) {
      if (!aliveRef.current || generationRef.current !== generation) return;
      const safeError = serializeClientError(err);
      reportClientError(safeError);
      setError(safeError);
    } finally {
      if (aliveRef.current && generationRef.current === generation) setPlayingKey(null);
    }
  }
  return { playingKey, error, play, stop };
}
