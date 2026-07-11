import type { LibraryStore } from "../db";
import { json, exact, type RouteEntry } from "./http";

export type LibraryRoutesDeps = {
  /** モデルトークの記録と一覧（実体は db.ts、テストはフェイク/インメモリ） */
  libraryStore: LibraryStore;
  /** 現行教材の題名一覧。旧ライブラリ記録に日本語題名がない場合も画面で補完する。 */
  libraryTopics: () => Map<string, { title: string; titleJa: string }>;
};

export function makeLibraryRoutes(deps: LibraryRoutesDeps): RouteEntry[] {
  return [
    exact("GET", "/api/library/model-talks", () => {
      const entries = deps.libraryStore.listModelTalks();
      if (entries.length === 0) return json({ entries });
      const topics = deps.libraryTopics();
      return json({ entries: entries.map((entry) => {
        const topic = topics.get(entry.topicId);
        return topic ? { ...entry, topicTitle: topic.title, topicTitleJa: topic.titleJa } : entry;
      }) });
    }),
  ];
}
