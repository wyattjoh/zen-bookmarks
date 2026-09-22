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
      cache.putSummary({
        url: "https://example.com/",
        contentHash: "content-hash",
        summary: "A reusable page summary.",
        createdAt: 2,
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
        summary: "A reusable page summary.",
        summaryAt: 2,
      });
      expect(
        cache.getRelevance("query-hash", "bookmark-hash", "test-model", 1),
      ).toBe(0.9);
      expect(
        cache.getRelevance("other-query", "bookmark-hash", "test-model", 1),
      ).toBeNull();

      cache.putLink({
        url: "https://example.com/",
        fetchedAt: 3,
        fetchStatus: "ok",
        finalUrl: "https://example.com/",
        pageTitle: "Updated example",
        description: "Updated description",
        text: "Updated text",
        classificationJson: "{}",
        contentHash: "updated-content-hash",
        error: null,
      });
      expect(cache.getLink("https://example.com/")?.summary).toBeNull();
    } finally {
      cache.close();
    }
  });
});
