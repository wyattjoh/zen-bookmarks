import { describe, expect, test } from "bun:test";
import type { LinkClassification } from "./link-index.ts";
import { openSearchCache } from "./search-cache.ts";
import type { SidebarTree } from "./sidebar.ts";
import { searchSidebarBookmarks } from "./typesafe-search.ts";

const tree: SidebarTree = {
  workspaces: [
    {
      id: "workspace-1",
      name: "Work",
      bookmarks: [
        {
          id: "bookmark-1",
          title: "Calendar",
          url: "https://calendar.example.com",
          currentUrl: undefined,
          workspaceId: "workspace-1",
          folderId: undefined,
          index: 0,
        },
      ],
      folders: [
        {
          id: "folder-1",
          name: "References",
          workspaceId: "workspace-1",
          parentId: undefined,
          folders: [],
          bookmarks: [
            {
              id: "bookmark-2",
              title: "TypeScript Handbook",
              url: "https://typescriptlang.org/docs",
              currentUrl: "https://typescriptlang.org/docs/handbook",
              workspaceId: "workspace-1",
              folderId: "folder-1",
              index: 1,
            },
          ],
        },
      ],
    },
  ],
};

function classification(): LinkClassification {
  return {
    version: 1,
    model: "test-model",
    resourceKind: { value: "documentation", confidence: 1, probabilities: {} },
    purpose: { value: "learn", confidence: 1, probabilities: {} },
    topics: {
      aiAgents: 0,
      softwareDevelopment: 1,
      identitySecurity: 0,
      cloudInfrastructure: 0,
      data: 0,
      design: 0,
      productivity: 0,
      businessFinance: 0,
      personalLifestyle: 0,
      food: 0,
      hardware: 0,
      entertainment: 0,
    },
  };
}

describe("TypeSafe bookmark search", () => {
  test("indexes once and caches repeated relevance judgments", async () => {
    const cache = openSearchCache(":memory:");
    let loaderCalls = 0;
    let classifierCalls = 0;
    let judgeCalls = 0;
    let summarizerCalls = 0;
    const dependencies = {
      cache,
      loader: async () => {
        loaderCalls += 1;
        return {
          fetchStatus: "ok" as const,
          finalUrl: null,
          pageTitle: null,
          description: null,
          text: "",
          error: null,
        };
      },
      classifier: {
        model: "test-model",
        async classify() {
          classifierCalls += 1;
          return classification();
        },
      },
      judge: {
        model: "test-model",
        async score(state: { bookmark: { title: string } }) {
          judgeCalls += 1;
          return state.bookmark.title === "TypeScript Handbook" ? 0.94 : 0.08;
        },
      },
      summarizer: {
        async summarize(url: string) {
          summarizerCalls += 1;
          expect(url).toBe("https://typescriptlang.org/docs");
          return "The TypeScript language reference.";
        },
      },
      debug: undefined,
    };

    try {
      const first = await searchSidebarBookmarks(tree, "language documentation", dependencies, {
        limit: 1,
        minimumRelevance: 0.5,
        shortlistSize: 2,
        indexConcurrency: 2,
        rerankConcurrency: 2,
      });
      const second = await searchSidebarBookmarks(tree, "language documentation", dependencies, {
        limit: 1,
        minimumRelevance: 0.5,
        shortlistSize: 2,
        indexConcurrency: 2,
        rerankConcurrency: 2,
      });

      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        id: "bookmark-2",
        workspaceName: "Work",
        folderPath: ["References"],
        relevance: 0.94,
        summary: "The TypeScript language reference.",
      });
      expect(second).toEqual(first);
      expect(loaderCalls).toBe(2);
      expect(classifierCalls).toBe(2);
      expect(judgeCalls).toBe(2);
      expect(summarizerCalls).toBe(1);
    } finally {
      cache.close();
    }
  });

  test("summarizes every returned result above the relevance threshold", async () => {
    const cache = openSearchCache(":memory:");
    const rankedTree: SidebarTree = {
      workspaces: [
        {
          id: "workspace-1",
          name: "Work",
          folders: [],
          bookmarks: [1, 2, 3, 4].map((rank) => ({
            id: `bookmark-${rank}`,
            title: `Reference ${rank}`,
            url: `https://example.com/${rank}`,
            currentUrl: undefined,
            workspaceId: "workspace-1",
            folderId: undefined,
            index: rank,
          })),
        },
      ],
    };
    const summarized: string[] = [];
    try {
      const results = await searchSidebarBookmarks(
        rankedTree,
        "reference",
        {
          cache,
          loader: async (url) => ({
            fetchStatus: "ok",
            finalUrl: url,
            pageTitle: "Reference",
            description: "Reference page",
            text: "reference",
            error: null,
          }),
          classifier: {
            model: "test-model",
            async classify() {
              return classification();
            },
          },
          judge: {
            model: "test-model",
            async score(state) {
              return 1 - Number(state.bookmark.title.at(-1)) / 10;
            },
          },
          summarizer: {
            async summarize(url) {
              summarized.push(url);
              return `Summary for ${url}`;
            },
          },
          debug: undefined,
        },
        {
          limit: 4,
          minimumRelevance: 0,
          shortlistSize: 4,
          indexConcurrency: 2,
          rerankConcurrency: 2,
        },
      );

      expect(summarized).toEqual([
        "https://example.com/1",
        "https://example.com/2",
        "https://example.com/3",
        "https://example.com/4",
      ]);
      expect(results.map((result) => result.summary)).toEqual([
        "Summary for https://example.com/1",
        "Summary for https://example.com/2",
        "Summary for https://example.com/3",
        "Summary for https://example.com/4",
      ]);
    } finally {
      cache.close();
    }
  });

  test("rejects invalid limits before indexing", async () => {
    const cache = openSearchCache(":memory:");
    try {
      await expect(
        searchSidebarBookmarks(
          tree,
          "anything",
          {
            cache,
            loader: async () => {
              throw new Error("unexpected loader call");
            },
            classifier: {
              model: "test-model",
              async classify() {
                throw new Error("unexpected classifier call");
              },
            },
            judge: {
              model: "test-model",
              async score() {
                throw new Error("unexpected judge call");
              },
            },
            summarizer: {
              async summarize() {
                throw new Error("unexpected summarizer call");
              },
            },
            debug: undefined,
          },
          {
            limit: 0,
            minimumRelevance: 0.5,
            shortlistSize: 2,
            indexConcurrency: 1,
            rerankConcurrency: 1,
          },
        ),
      ).rejects.toThrow("positive integer");
    } finally {
      cache.close();
    }
  });
});
