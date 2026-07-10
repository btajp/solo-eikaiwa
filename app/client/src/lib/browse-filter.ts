import type { ChunkListItem, SentenceItem } from "../api";

export const BROWSE_PAGE_SIZE = 40;

export type BrowseStudyFilter = "all" | "new" | "scheduled";
export type BrowseFilters = {
  query: string;
  domain: "all" | SentenceItem["domain"];
  category: "all" | number;
  study: BrowseStudyFilter;
};

type SearchableItem = Pick<SentenceItem, "no" | "category" | "en" | "ja" | "note"> | Pick<ChunkListItem, "id" | "promptText" | "en" | "note">;

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function matchesBrowseQuery(item: SearchableItem, query: string): boolean {
  const needle = normalized(query);
  if (!needle) return true;
  const fields = "no" in item
    ? [String(item.no), item.category, item.en, item.ja, item.note]
    : [String(item.id), item.promptText, item.en, item.note];
  return fields.some((field) => normalized(field).includes(needle));
}

export function filterBrowseSentences(items: SentenceItem[], filters: BrowseFilters): SentenceItem[] {
  return items.filter((item) => {
    if (filters.domain !== "all" && item.domain !== filters.domain) return false;
    if (filters.category !== "all" && item.category_no !== filters.category) return false;
    if (filters.study === "new" && item.srs !== null) return false;
    if (filters.study === "scheduled" && item.srs === null) return false;
    return matchesBrowseQuery(item, filters.query);
  });
}

export function paginateBrowseItems<T>(items: T[], requestedPage: number, pageSize = BROWSE_PAGE_SIZE): {
  items: T[];
  page: number;
  pageCount: number;
} {
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const page = Math.max(1, Math.min(requestedPage, pageCount));
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), page, pageCount };
}
