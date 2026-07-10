import { useEffect, useRef, useState } from "react";
import { makeLatestGeneration } from "./lib/latest-generation";

export type LoadState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: string };

/**
 * マウント時に fn() を1回だけ実行し、loading/ready/error を管理する。
 * StrictMode の二重マウント（once ガード）とアンマウント後の setState（alive ガード）を内蔵し、
 * 各画面が手書きしていた aliveRef + fetchedRef + LoadState + エラー整形を一本化する。
 * reload() は fn() を再実行する（再試行ボタン用）。
 */
export function useLoad<T>(fn: () => Promise<T>): { state: LoadState<T>; reload: () => void } {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);
  const generationRef = useRef(makeLatestGeneration());
  // fn は呼び出しごとに新参照になりうるため ref に保持し、effect の依存から外す（挙動は「マウント時1回」）
  const fnRef = useRef(fn);
  fnRef.current = fn;

  function run() {
    const generation = generationRef.current.begin();
    setState({ status: "loading" });
    fnRef.current()
      .then((data) => {
        if (aliveRef.current && generationRef.current.isCurrent(generation)) setState({ status: "ready", data });
      })
      .catch((err) => {
        if (aliveRef.current && generationRef.current.isCurrent(generation)) {
          setState({ status: "error", error: err instanceof Error ? err.message : String(err) });
        }
      });
  }

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      run();
    }
    return () => { aliveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { state, reload: run };
}
