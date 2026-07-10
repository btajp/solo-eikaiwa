import type { Lang } from "./i18n";

export type LocalizedTitleInput = { title?: string | null; titleJa?: string | null };

/** UI言語に対応する教材題名を選び、対応題名が欠ける場合だけもう一方を使う。 */
export function localizedTitle(input: LocalizedTitleInput, lang: Lang): string {
  const primary = lang === "ja" ? input.titleJa : input.title;
  const fallback = lang === "ja" ? input.title : input.titleJa;
  return primary?.trim() || fallback?.trim() || "";
}
