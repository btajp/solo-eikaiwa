import type { MenuBlock } from "../api";
import { STR, type Lang } from "../i18n";

/** ブロックの表示タイトルを言語別に組み立てる。titleKey の無い旧キャッシュ（デプロイ当日など）は従来の JA title をそのまま使う。
 * 未知の titleKey（server/client の型が将来ズレた場合や旧バンドルのタブ）もクラッシュせず JA title へフォールバックする */
export function blockTitle(block: MenuBlock, lang: Lang): string {
  if (!block.titleKey) return block.title;
  return STR[lang].menuTitle[block.titleKey]?.(block.topicTitle ?? "") ?? block.title;
}
