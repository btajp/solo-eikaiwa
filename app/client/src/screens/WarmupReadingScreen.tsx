import { useEffect, useRef, useState } from "react";
import { fetchPrepPack, playTtsCached, type ContentItem, type PrepPack } from "../api";
import { stopPlayback } from "../audio";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { ChunkList } from "../ui/ChunkList";

type State = "loading" | "ready" | "error";

/**
 * セッション冒頭の低負荷な音読ウォームアップ。今日のトピックの表現チャンクと骨組みを
 * 声に出して読むだけ（録音・採点なし）。この後の4/3/2で同じ素材を使う下地作り。
 */
export function WarmupReadingScreen(props: { topic: ContentItem }) {
  const [state, setState] = useState<State>("loading");
  const [prep, setPrep] = useState<PrepPack | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [playErr, setPlayErr] = useState("");
  const [playingIdx, setPlayingIdx] = useState<number | null>(null);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false); // StrictMode の二重マウントで prep を二重フェッチしない

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      load();
    }
    return () => {
      aliveRef.current = false;
      stopPlayback();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setState("loading");
    setErrorMsg("");
    try {
      const pack = await fetchPrepPack(props.topic.id);
      if (!aliveRef.current) return;
      setPrep(pack);
      setState("ready");
    } catch (err) {
      if (!aliveRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setState("error");
    }
  }

  async function playChunk(i: number, text: string) {
    setPlayErr("");
    setPlayingIdx(i);
    try {
      await playTtsCached(text);
    } catch (err) {
      if (!aliveRef.current) return;
      setPlayErr(err instanceof Error ? err.message : String(err));
    } finally {
      if (aliveRef.current) setPlayingIdx(null);
    }
  }

  const chunks = prep?.chunks.filter((c) => typeof c.en === "string" && c.en) ?? [];

  return (
    <div className="stack">
      <p className="text-muted">
        声に出して読みましょう（各フレーズ2回ずつ）。🔊でお手本を聞けます。このあとの 4/3/2 で実際に使います。
      </p>
      {state === "loading" && <p>コーチが表現チャンクを用意しています…</p>}
      {state === "error" && (
        <div>
          <Banner kind="error" action={<Button onClick={load}>再試行</Button>}>
            {errorMsg}
          </Banner>
          {props.topic.hints.length > 0 && (
            <div>
              <h4>代わりにこちらを声に出して読みましょう</h4>
              <ChunkList chunks={props.topic.hints.map((h) => ({ en: h }))} playingIdx={null} />
            </div>
          )}
        </div>
      )}
      {state === "ready" && prep && (
        <div className="stack">
          {chunks.length > 0 && <ChunkList chunks={chunks} playingIdx={playingIdx} onPlay={playChunk} />}
          {playErr && <Banner kind="error">{playErr}</Banner>}
          {prep.outline.length > 0 && (
            <Card header="今日の話の骨組み">
              <ol>
                {prep.outline.map((o, i) => (
                  <li key={i}>{o}</li>
                ))}
              </ol>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
