import { describe, expect, test } from "bun:test";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { App, BookmarkList } from "./tui.tsx";
import type { TuiBookmark } from "./tui-data.ts";

function bookmark(id: string, title: string): TuiBookmark {
  return {
    kind: "bookmark",
    key: `saved:${id}`,
    id,
    title,
    url: `https://example.com/${id}`,
    currentUrl: undefined,
    source: "saved",
    collection: "Saved Bookmarks",
    folderPath: ["Bookmarks Toolbar"],
    parentKey: "saved-folder:toolbar_____",
    ancestorFolderKeys: ["saved-folder:toolbar_____"],
    depth: 0,
    position: 0,
    cached: null,
  };
}

describe("bookmark TUI", () => {
  test("keeps short and long bookmark rows aligned", async () => {
    const setup = await testRender(
      <BookmarkList
        entries={[
          bookmark("short", "Short title"),
          bookmark("long", `Long bookmark title ${"word ".repeat(20)}`),
        ]}
        selectedIndex={0}
        query=""
        focused
        collapsedFolderKeys={new Set()}
        onFocus={() => {}}
        onSelect={() => {}}
        onToggleFolder={() => {}}
      />,
      { width: 48, height: 10 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      const lines = setup.captureCharFrame().split("\n");
      const shortTitleLine = lines.findIndex((line) => line.includes("Short title"));
      const shortUrlLine = lines.findIndex((line) => line.includes("/short"));
      const longTitleLine = lines.findIndex((line) =>
        line.includes("Long bookmark"),
      );
      const longUrlLine = lines.findIndex((line) => line.includes("/long"));

      expect(shortUrlLine).toBe(shortTitleLine + 1);
      expect(longUrlLine).toBe(longTitleLine + 1);
      expect(lines[shortTitleLine].indexOf("Short")).toBe(
        lines[longTitleLine].indexOf("Long"),
      );
      expect(lines[shortUrlLine].indexOf("https")).toBe(
        lines[longUrlLine].indexOf("https"),
      );
    } finally {
      act(() => setup.renderer.destroy());
    }
  });

  test("cycles workspaces and fuzzy-searches through the focused input", async () => {
    const setup = await testRender(
      <App
        initialEntries={[
          bookmark("saved", "Global saved bookmark"),
          bookmark("personal", "Personal only bookmark"),
          bookmark("work", "Work only bookmark"),
        ].map((entry, index) =>
          index === 0
            ? entry
            : {
                ...entry,
                key: `sidebar:${entry.id}`,
                source: "sidebar" as const,
                collection: index === 1 ? "Personal" : "Work",
                folderPath: [],
                parentKey: undefined,
                ancestorFolderKeys: [],
              },
        )}
        warnings={[]}
        onRefresh={async () => {
          throw new Error("not used");
        }}
        onReload={async () => {
          throw new Error("not used");
        }}
        onExit={() => {}}
      />,
      { width: 120, height: 30 },
    );

    try {
      await act(async () => {
        await setup.renderOnce();
      });
      expect(setup.captureCharFrame()).toContain("Personal only bookmark");
      expect(setup.captureCharFrame()).not.toContain("Work only bookmark");

      await act(async () => {
        await setup.mockInput.pressKeys(["TAB"]);
      });
      await setup.waitForFrame((frame) => frame.includes("Work only bookmark"));
      expect(setup.captureCharFrame()).toContain("Work only bookmark");
      expect(setup.captureCharFrame()).not.toContain("Personal only bookmark");

      await act(async () => {
        await setup.mockInput.pressKeys(["/"]);
      });
      await setup.flush();
      await act(async () => {
        await setup.mockInput.typeText("Work only");
      });
      await setup.waitForFrame((frame) => !frame.includes("Global saved bookmark"));
      const searched = setup.captureCharFrame();
      expect(searched).toContain("Work only bookmark");
      expect(searched).not.toContain("Global saved bookmark");

      await act(async () => {
        await setup.mockInput.pressKeys(Array(9).fill("BACKSPACE"));
      });
      await setup.waitForFrame((frame) => frame.includes("Global saved bookmark"));
      await act(async () => {
        setup.mockInput.pressEnter();
      });
      await setup.waitForFrame((frame) => frame.includes("Right details"));
      await act(async () => {
        setup.mockInput.pressArrow("down");
      });
      await setup.waitForFrame(
        (frame) => (frame.match(/Work only bookmark/g) ?? []).length >= 2,
      );

      await act(async () => {
        setup.mockInput.pressArrow("right");
      });
      await setup.waitForFrame((frame) => frame.includes("Left bookmarks"));
    } finally {
      act(() => setup.renderer.destroy());
    }
  });
});
