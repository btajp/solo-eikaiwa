import { useEffect, useRef, useState } from "react";
import { fetchSettings, saveSettings } from "../api";
import { STR, type Lang } from "../i18n";
import { formatClientError } from "../lib/user-error";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import {
  ANCHOR_MAX_CHARS,
  anchorDraftTooLong,
  anchorLoadFailed,
  anchorLoaded,
  anchorSaveFailed,
  anchorSaveSucceeded,
  beginAnchorSave,
  canSaveAnchor,
  editAnchorDraft,
  initialHabitAnchorForm,
  retryAnchorLoad,
  savedAnchorText,
  type HabitAnchorForm,
} from "./habit-anchor-form";

export type HabitAnchor = {
  form: HabitAnchorForm;
  loadError: unknown;
  saveError: unknown;
  edit: (value: string) => void;
  save: () => void;
  reloadAnchor: () => void;
};

/**
 * 習慣アンカー（#184）の読込・保存を持つフック。状態遷移は habit-anchor-form.ts の純ロジックに委ねる。
 * ホームでの控えめな再提示（HabitAnchorReminder）と設定カード（HabitAnchorCard）で同じ状態を共有する。
 */
export function useHabitAnchor(): HabitAnchor {
  const [form, setForm] = useState(initialHabitAnchorForm);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [saveError, setSaveError] = useState<unknown>(null);
  const aliveRef = useRef(true);
  const fetchedRef = useRef(false);

  function load() {
    setLoadError(null);
    fetchSettings()
      .then((s) => { if (aliveRef.current) setForm((f) => anchorLoaded(f, s.anchor)); })
      .catch((err) => {
        if (!aliveRef.current) return;
        setLoadError(err);
        setForm(anchorLoadFailed);
      });
  }

  useEffect(() => {
    aliveRef.current = true;
    if (!fetchedRef.current) {
      fetchedRef.current = true;
      load();
    }
    return () => { aliveRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // StrictMode の updater 二重実行で保存が二重送信されないよう、副作用は setForm の外で行う
  function save() {
    if (!canSaveAnchor(form)) return;
    const saving = beginAnchorSave(form);
    setForm(saving);
    setSaveError(null);
    saveSettings({ anchor: savedAnchorText(saving) })
      .then(() => { if (aliveRef.current) setForm(anchorSaveSucceeded); })
      .catch((err) => {
        if (!aliveRef.current) return;
        setSaveError(err);
        setForm(anchorSaveFailed);
      });
  }

  return {
    form,
    loadError,
    saveError,
    edit: (value: string) => setForm((f) => editAnchorDraft(f, value)),
    save,
    reloadAnchor: () => { setForm(retryAnchorLoad); load(); },
  };
}

/** 設定済みアンカーのホームでの控えめな再提示。未設定・読込前・読込失敗のときは何も出さない（警告にしない）。 */
export function HabitAnchorReminder({ anchor, lang }: { anchor: HabitAnchor; lang: Lang }) {
  const t = STR[lang].habitAnchor;
  if (anchor.form.load !== "ready" || !anchor.form.saved) return null;
  return (
    <p className="text-sm text-muted">
      {t.reminderLabel} {anchor.form.saved}
    </p>
  );
}

/** 任意の一文（if-then）を設定するカード。通知・ノルマ・警告なし。効果の個人差は正直に明記する（#184）。 */
export function HabitAnchorCard({ anchor, lang }: { anchor: HabitAnchor; lang: Lang }) {
  const t = STR[lang].habitAnchor;
  const { form } = anchor;
  const tooLong = anchorDraftTooLong(form);
  return (
    <Card header={t.title}>
      <div className="stack">
        <p className="text-sm text-muted">{t.desc}</p>
        <p className="text-sm text-muted">{t.individualNote}</p>
        {form.load === "loading" && <p className="text-muted">{t.loading}</p>}
        {form.load === "error" && (
          <Banner kind="error" action={<Button onClick={anchor.reloadAnchor}>{t.retry}</Button>}>
            {formatClientError(lang, anchor.loadError, "load")}
          </Banner>
        )}
        {form.load === "ready" && (
          <>
            <label className="llm-field">
              <span className="text-sm text-muted">{t.inputLabel}</span>
              <input
                className="llm-input"
                value={form.draft}
                placeholder={t.placeholder}
                disabled={form.save === "saving"}
                onChange={(e) => anchor.edit(e.target.value)}
              />
            </label>
            {tooLong && <p className="text-sm text-muted" role="status">{t.tooLong(ANCHOR_MAX_CHARS)}</p>}
            {form.save === "error" && (
              <Banner kind="error" action={<Button onClick={anchor.save}>{t.retry}</Button>}>
                {formatClientError(lang, anchor.saveError, "save")}
              </Banner>
            )}
            <div>
              <Button
                variant="secondary"
                loading={form.save === "saving"}
                disabled={!canSaveAnchor(form)}
                onClick={anchor.save}
              >
                {form.save === "saving" ? t.saving : t.save}
              </Button>
            </div>
            {form.save === "saved" && <p className="text-sm text-muted" role="status">{t.saved}</p>}
          </>
        )}
      </div>
    </Card>
  );
}
