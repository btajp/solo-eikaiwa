import { reportClientError, type ClientErrorCode } from "../api/http";
import { STR, type Lang } from "../i18n";

export type ErrorAction = "load" | "save" | "apply" | "submit" | "record" | "play" | "request";

/** 内部エラーを利用者が次の操作を選べる日英メッセージへ変換する。 */
export function formatClientError(lang: Lang, error: unknown, action: ErrorAction): string {
  const detail = reportClientError(error);
  const t = STR[lang].errors;
  return `${t.action[action]} ${t.category[detail.code as ClientErrorCode]} ${t.reference(detail.correlationId)}`;
}
