import { describe, expect, test } from "bun:test";
import { openSearchCache } from "./search-cache.ts";

describe("search cache", () => {
  test("persists links and query-specific relevance scores", () => {
    const cache = openSearchCache(":memory:");
    try {
      cache.putLink({
        url: "https://example.com/",
        fetchedAt: 1,
        fetchStatus: "ok",
        finalUrl: "https://example.com/",
        pageTitle: "Example",
        description: "Example description",
        text: "Example text",
        classificationJson: "{}",
        contentHash: "content-hash",
        error: null,
      });
      cache.putRelevance({
        queryHash: "query-hash",
        query: "example",
        bookmarkHash: "bookmark-hash",
        model: "test-model",
        questionVersion: 1,
        score: 0.9,
        createdAt: 2,
      });

      expect(cache.getLink("https://example.com/")).toMatchObject({
        pageTitle: "Example",
        contentHash: "content-hash",
      });
      expect(
        cache.getRelevance("query-hash", "bookmark-hash", "test-model", 1),
      ).toBe(0.9);
      expect(
        cache.getRelevance("other-query", "bookmark-hash", "test-model", 1),
      ).toBeNull();
    } finally {
      cache.close();
    }
  });
});
