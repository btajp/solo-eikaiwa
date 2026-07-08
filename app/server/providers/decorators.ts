/**
 * ClaudeRunner を包むデコレータ群。
 *
 * - withTimeout（このファイルで定義・テスト済み）: このタスクではまだどの経路にも適用しない。
 *   実際の配線（どの runner に何 ms で適用するか）は Task 5/8 でまとめて行う。
 * - withFallback（Task 5 で追加予定）: transport 起因の失敗（TransportError）に限り
 *   別 runner へフォールバックするデコレータ。まだ実装しない。
 */
import { TransportError } from "./errors";
import type { ClaudeRunner } from "../converse";

/**
 * runner の呼び出しにタイムアウトを課す。ms 以内に解決/拒否しなければ TransportError で reject する。
 * 元の Promise が後から解決/拒否しても、この関数が返す Promise には影響しない（先に決着した方が勝つ）。
 * タイマーは runner の Promise が解決・拒否どちらで決着しても、外側の Promise を決着させる直前に
 * 必ず clear する（残留させない。タイムアウト側が勝った場合はタイマー自体が既に発火済みなので clear 不要）。
 */
export function withTimeout(runner: ClaudeRunner, ms = 180_000): ClaudeRunner {
  return (prompt, resumeId, opts) =>
    new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new TransportError(`runner timed out after ${ms}ms`));
      }, ms);

      runner(prompt, resumeId, opts).then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
}
