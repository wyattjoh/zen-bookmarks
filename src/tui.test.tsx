import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App, SearchResults } from "./tui.tsx";
import type { BookmarkSearchResult } from "./typesafe-search.ts";

function result(
  id: string,
  title: string,
  overrides: Partial<BookmarkSearchResult> = {},
): BookmarkSearchResult {
  return {
    id,
    title,
    url: `https://example.com/${id}`,
    currentUrl: undefined,
    workspaceId: "workspace-1",
    folderId: "folder-1",
    index: 0,
    workspaceName: "Work",
    folderPath: ["References"],
    retrievalScore: 4.2,
    relevance: 0.91,
    summary: `Summary for ${title}`,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("bookmark search TUI", () => {
  test("renders rich result cards with stable title and metadata alignment", async () => {
    const setup = await testRender(
      <SearchResults
        results={[
          result("short", "Short title"),
          result("long", `Long bookmark title ${"word ".repeat(20)}`),
        ]}
        selectedIndex={0}
        focused
        onFocus={() => {}}
        onSelect={() => {}}
      />,
      { width: 72, height: 20 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const frame = setup.captureCharFrame();
      expect(frame).toContain("▶ Short title");
      expect(frame).toContain("91% relevant");
      expect(frame).toContain("Work / References");
      expect(frame).toContain("https://example.com/short");
      expect(frame).toContain("Summary for Short title");
      expect(frame).toContain("Long bookmark title");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("submits a natural-language query and navigates returned results", async () => {
    const searches: string[] = [];
    const setup = await testRender(
      <App
        onSearch={async (query) => {
          searches.push(query);
          return [
            result("typescript", "TypeScript Handbook"),
            result("opentui", "OpenTUI Documentation", {
              relevance: 0.82,
              summary: "Build terminal interfaces with React.",
            }),
          ];
        }}
        onExit={() => {}}
      />,
      { width: 100, height: 28 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const initial = setup.captureCharFrame();
      expect(initial).toContain("Search your pinned Zen bookmarks");
      expect(initial).toContain("› What are you looking for?");

      await act(async () => {
        await setup.mockInput.typeText("  terminal   UI docs  ");
      });
      await act(async () => setup.mockInput.pressEnter());
      await flush();
      await setup.waitForFrame((frame) => frame.includes("TypeScript Handbook"));

      expect(searches).toEqual(["terminal UI docs"]);
      const searched = setup.captureCharFrame();
      expect(searched).toContain("you › terminal UI docs");
      expect(searched).toContain("2 relevant bookmarks");
      expect(searched).toContain("▶ TypeScript Handbook");
      expect(searched).toContain("OpenTUI Documentation");
      expect(searched).toContain("↑/↓ navigate");

      await act(async () => {
        setup.mockInput.pressArrow("down");
      });
      await setup.waitForFrame((frame) => frame.includes("▶ OpenTUI Documentation"));
      const moved = setup.captureCharFrame();
      expect(moved).toContain("▶ OpenTUI Documentation");
      expect(moved).not.toContain("▶ TypeScript Handbook");

      await act(async () => {
        await setup.mockInput.pressKeys(["/"]);
      });
      await setup.waitForFrame((frame) => frame.includes("Enter search · ↓ results"));
      await act(async () => {
        await setup.mockInput.typeText("authentication references");
      });
      await setup.waitForFrame((frame) =>
        frame.includes("authentication references"),
      );
      expect(setup.captureCharFrame()).toContain("authentication references");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("shows search errors without discarding the submitted query", async () => {
    const setup = await testRender(
      <App
        onSearch={async () => {
          throw new Error(
            "TypeSafe and Firecrawl API keys are required; run `zen-bookmarks login`",
          );
        }}
        onExit={() => {}}
      />,
      { width: 100, height: 20 },
    );

    try {
      await act(async () => {
        await setup.mockInput.typeText("design systems");
      });
      await act(async () => setup.mockInput.pressEnter());
      await flush();
      await setup.waitForFrame((frame) => frame.includes("API keys are required"));
      const frame = setup.captureCharFrame();
      expect(frame).toContain("you › design systems");
      expect(frame).toContain("API keys are required");
      expect(frame).toContain("Enter search · ↓ results");
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
});
