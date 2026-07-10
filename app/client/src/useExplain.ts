import { useEffect, useRef, useState } from "react";
import { reportClientError } from "./api/http";

/**
 * 「もっと詳しく／解説」ボタンの非同期状態機械。判別可能ユニオンで idle/loading/error/done を表し、
 * 旧来の文字列センチネル（"loading"/"error" と本文の混同・エラー文を本文へ流用して再試行不能）を排する。
 * アンマウント後の setState はガードする。
 */
export type ExplainState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "done"; text: string };

export function useExplain(fetcher: () => Promise<string>): { state: ExplainState; request: () => void } {
  const [state, setState] = useState<ExplainState>({ status: "idle" });
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  function request() {
    setState({ status: "loading" });
    fetcher()
      .then((text) => { if (aliveRef.current) setState({ status: "done", text }); })
      .catch((error) => {
        reportClientError(error);
        if (aliveRef.current) setState({ status: "error" });
      });
  }
  return { state, request };
}
