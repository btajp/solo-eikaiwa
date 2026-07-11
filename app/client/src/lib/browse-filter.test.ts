import { describe, expect, test } from "bun:test";
import {
  BROWSE_PAGE_SIZE, filterBrowseChunks, filterBrowseSentences, matchesBrowseQuery, paginateBrowseItems,
  type BrowseFilters,
} from "./browse-filter";
import type { ChunkListItem, SentenceItem } from "../api";

function sentence(no: number, overrides: Partial<SentenceItem> = {}): SentenceItem {
  return {
    no, category_no: no % 2 ? 1 : 2, category: no % 2 ? "Requests" : "Plans",
    domain: no % 3 === 0 ? "it" : no % 3 === 1 ? "daily" : "business",
    en: `English phrase ${no}`, ja: `日本語の表現 ${no}`, note: `note ${no}`,
    srs: no % 2 ? null : { stage: 2, due: "2026-07-12", reviews: 1 },
    ...overrides,
  };
}

function chunk(id: number, reviews: number): ChunkListItem {
  return {
    id, created: "2026-07-11T00:00:00.000Z", source: "ae",
    promptText: `prompt ${id}`, en: `phrase ${id}`, note: "note",
    srs: { stage: 1, due: "2026-07-12", reviews },
  };
}

const ALL: BrowseFilters = { query: "", domain: "all", category: "all", study: "all" };

describe("例文一覧の検索・ページ分割", () => {
  test("英文・日本語・番号・カテゴリを同じ検索欄で見つけられる", () => {
    const items = [
      sentence(12, { en: "Could you reschedule the meeting?", ja: "会議の日程を変更できますか", category: "Requests" }),
      sentence(13, { en: "I will send the plan.", category: "Plans" }),
    ];

    expect(filterBrowseSentences(items, { ...ALL, query: "reschedule" }).map((item) => item.no)).toEqual([12]);
    expect(filterBrowseSentences(items, { ...ALL, query: "日程" }).map((item) => item.no)).toEqual([12]);
    expect(filterBrowseSentences(items, { ...ALL, query: "13" }).map((item) => item.no)).toEqual([13]);
    expect(filterBrowseSentences(items, { ...ALL, query: "plans" }).map((item) => item.no)).toEqual([13]);
  });

  test("カテゴリ・学習状態の絞り込みとマイフレーズの検索を行う", () => {
    const items = [sentence(1), sentence(2)];
    expect(filterBrowseSentences(items, { ...ALL, category: 2 }).map((item) => item.no)).toEqual([2]);
    expect(filterBrowseSentences(items, { ...ALL, study: "new" }).map((item) => item.no)).toEqual([1]);
    expect(matchesBrowseQuery({ id: 8, promptText: "I go office", en: "I went to the office", note: "tense" }, "office")).toBe(true);
  });

  test("未学習・復習済みの絞り込みはマイフレーズにも同じ意味で適用する", () => {
    const chunks = [chunk(1, 0), chunk(2, 1)];

    expect(filterBrowseChunks(chunks, { ...ALL, study: "new" }).map((item) => item.id)).toEqual([1]);
    expect(filterBrowseChunks(chunks, { ...ALL, study: "scheduled" }).map((item) => item.id)).toEqual([2]);
  });

  test("390件でも初期ページは40件だけを返す", () => {
    const items = Array.from({ length: 390 }, (_, index) => sentence(index + 1));
    const first = paginateBrowseItems(items, 1);
    const last = paginateBrowseItems(items, 99);

    expect(first.items).toHaveLength(BROWSE_PAGE_SIZE);
    expect(first.pageCount).toBe(10);
    expect(last.page).toBe(10);
    expect(last.items).toHaveLength(30);
  });
});
