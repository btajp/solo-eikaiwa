import type { SttSegment } from "./stt";

export type UtteranceMetrics = {
  words: number;
  totalMs: number;
  speechMs: number;
  /** 総経過時間ベースの発話速度（ポーズ込み） */
  speechRateWpm: number;
  /** 発話時間ベースの調音速度（ポーズ除外） */
  articulationRateWpm: number;
  pauses: { count: number; totalMs: number; longestMs: number };
  /** 隣接同一語と反復bigramの割合 0..1（言い直し・詰まりの近似） */
  repetitionRatio: number;
};

/** セグメント間ギャップがこれを超えたらポーズと数える（whisperのセグメント割りに合わせた保守値） */
const PAUSE_THRESHOLD_MS = 300;

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z']+/).filter((t) => t.length > 0);
}

export function computeUtteranceMetrics(segments: SttSegment[]): UtteranceMetrics {
  const tokens = tokenize(segments.map((s) => s.text).join(" "));
  const words = tokens.length;
  const totalMs = segments.length ? segments[segments.length - 1].toMs : 0;
  const speechMs = segments.reduce((a, s) => a + Math.max(0, s.toMs - s.fromMs), 0);

  let pauseCount = 0, pauseTotal = 0, pauseLongest = 0;
  for (let i = 1; i < segments.length; i++) {
    const gap = segments[i].fromMs - segments[i - 1].toMs;
    if (gap > PAUSE_THRESHOLD_MS) {
      pauseCount++;
      pauseTotal += gap;
      if (gap > pauseLongest) pauseLongest = gap;
    }
  }

  let adjacent = 0;
  for (let i = 1; i < tokens.length; i++) if (tokens[i] === tokens[i - 1]) adjacent++;
  const bigramCounts = new Map<string, number>();
  for (let i = 1; i < tokens.length; i++) {
    const bg = `${tokens[i - 1]} ${tokens[i]}`;
    bigramCounts.set(bg, (bigramCounts.get(bg) ?? 0) + 1);
  }
  let repeatedBigrams = 0;
  for (const c of bigramCounts.values()) if (c > 1) repeatedBigrams += c - 1;
  const repetitionRatio = words === 0 ? 0 : Math.min(1, (adjacent + repeatedBigrams) / words);

  const wpm = (w: number, ms: number) => (ms <= 0 ? 0 : Math.round((w / (ms / 60000)) * 10) / 10);
  return {
    words, totalMs, speechMs,
    speechRateWpm: wpm(words, totalMs),
    articulationRateWpm: wpm(words, speechMs),
    pauses: { count: pauseCount, totalMs: pauseTotal, longestMs: pauseLongest },
    repetitionRatio: Math.round(repetitionRatio * 1000) / 1000,
  };
}
