import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { cancelWhisperModelDownload, getSetupStatus, startWhisperModelDownload, type SetupStatus, type WhisperModelId } from "../api/setup";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { rovingTargetIndex } from "../lib/roving-focus";
import { SetupStatusPoller } from "../lib/setup-status-poller";
import { formatBytes, isDownloadActive, progressPercent } from "../lib/whisper-setup";
import { Banner } from "./Banner";
import { Button } from "./Button";

const POLL_MS = 1000;
const MODEL_CHOICES: WhisperModelId[] = ["large-v3-turbo", "small"];

/**
 * health.modelFile===false のときだけ App.tsx から表示される、whisperモデルの初回セットアップバナー。
 * GET /api/setup/status をポーリングして進捗を追い、完了したら onModelReady() で親に health 再取得を促す
 * （health.modelFile が true に変わり、バナー自体は shouldShowSetupBanner の条件不成立で自然に消える）。
 */
export function SetupBanner({
  lang, onDismiss, onModelReady,
}: {
  lang: Lang; onDismiss: () => void; onModelReady: () => void;
}) {
  const t = STR[lang].setup;
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [selected, setSelected] = useState<WhisperModelId>("large-v3-turbo");
  const [busy, setBusy] = useState(false);
  const [pollError, setPollError] = useState(false);
  const mountedRef = useRef(false);
  const readyNotifiedRef = useRef(false);
  const onModelReadyRef = useRef(onModelReady);
  onModelReadyRef.current = onModelReady;

  const pollerRef = useRef<SetupStatusPoller | null>(null);
  if (pollerRef.current === null) {
    pollerRef.current = new SetupStatusPoller({
      load: getSetupStatus,
      onStatus: (nextStatus) => {
        setStatus(nextStatus);
        setPollError(false);
        if (nextStatus.status === "done" && !readyNotifiedRef.current) {
          readyNotifiedRef.current = true;
          onModelReadyRef.current();
        }
      },
      onError: () => { setPollError(true); },
      intervalMs: POLL_MS,
    });
  }
  const poller = pollerRef.current;

  useEffect(() => {
    mountedRef.current = true;
    poller.start();
    return () => {
      mountedRef.current = false;
      poller.stop();
    };
  }, [poller]);

  async function onStart() {
    setBusy(true);
    try {
      poller.accept(await startWhisperModelDownload(selected));
    } catch {
      if (mountedRef.current) setPollError(true);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  async function onCancel() {
    setBusy(true);
    try {
      poller.accept(await cancelWhisperModelDownload());
    } catch {
      if (mountedRef.current) setPollError(true);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }

  const st = status?.status ?? "idle";
  const showChoice = st === "idle" || st === "error";
  const pct = status ? progressPercent(status.receivedBytes, status.totalBytes) : 0;

  // WAI-ARIA APG準拠の radiogroup（#211）: 矢印キーで選択を移し、選択中の radio だけを tab stop にする
  const radioRefs = useRef<Array<HTMLButtonElement | null>>([]);
  function onRadioKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = rovingTargetIndex(e.key, MODEL_CHOICES.indexOf(selected), MODEL_CHOICES.length, "both");
    if (target === null) return;
    e.preventDefault();
    setSelected(MODEL_CHOICES[target]);
    radioRefs.current[target]?.focus();
  }

  return (
    <Banner
      kind={st === "error" ? "warn" : "info"}
      action={<Button variant="ghost" ariaLabel={t.dismissAriaLabel} onClick={onDismiss}>×</Button>}
    >
      <div className="stack setup-banner">
        <div>{t.intro}</div>

        {showChoice && (
          <>
            <div className="lang-toggle" role="radiogroup" aria-label={t.modelChoiceLabel} onKeyDown={onRadioKeyDown}>
              {MODEL_CHOICES.map((m, i) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={selected === m}
                  tabIndex={selected === m ? 0 : -1}
                  ref={(el) => { radioRefs.current[i] = el; }}
                  className={selected === m ? "is-active" : ""}
                  onClick={() => setSelected(m)}
                >
                  {m === "large-v3-turbo" ? t.modelLarge : t.modelSmall}
                </button>
              ))}
            </div>
            <p className="text-sm text-muted">
              {selected === "large-v3-turbo" ? t.modelLargeNote : t.modelSmallNote}
            </p>
            {st === "error" && status?.error && (
              <div className="level-edit-error">{formatClientError(lang, status.error, "request")}</div>
            )}
            <Button variant="primary" loading={busy} onClick={onStart}>
              {st === "error" && status?.resumable ? t.resumeButton : t.startButton}
            </Button>
          </>
        )}

        {isDownloadActive(st) && status && (
          <>
            <div
              className="gauge" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
              aria-label={t.modelChoiceLabel}
            >
              <div className="gauge-fill" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-sm text-muted">
              {st === "verifying" ? t.verifying : t.progress(formatBytes(status.receivedBytes), formatBytes(status.totalBytes))}
            </div>
            <Button variant="secondary" loading={busy} onClick={onCancel}>{t.cancelButton}</Button>
          </>
        )}

        {pollError && <div className="level-edit-error">{t.pollError}</div>}
      </div>
    </Banner>
  );
}
