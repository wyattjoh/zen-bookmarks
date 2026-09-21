import { describe, expect, test } from "bun:test";
import type { LinkClassification } from "./link-index.ts";
import { openSearchCache } from "./search-cache.ts";
import {
  allFolderKeys,
  cachedClassificationSummary,
  cycleWorkspaceName,
  entriesForWorkspace,
  filterTuiBookmarks,
  filterTuiEntries,
  loadTuiBookmarks,
  refreshTuiBookmark,
  sidebarWorkspaceNames,
  type TuiBookmark,
  type TuiFolder,
} from "./tui-data.ts";
import type { ZenSession } from "./sidebar.ts";

function bookmark(overrides: Partial<TuiBookmark> = {}): TuiBookmark {
  return {
    kind: "bookmark",
    key: "saved:one",
    id: "one",
    title: "OpenTUI documentation",
    url: "https://example.com/opentui",
    currentUrl: undefined,
    source: "saved",
    collection: "Saved Bookmarks",
    folderPath: ["Bookmarks Toolbar", "Development"],
    parentKey: "saved-folder:development",
    ancestorFolderKeys: [
      "saved-folder:toolbar_____",
      "saved-folder:development",
    ],
    depth: 2,
    position: 0,
    cached: null,
    ...overrides,
  };
}

const classification: LinkClassification = {
  version: 1,
  model: "test-model",
  resourceKind: { value: "documentation", confidence: 1, probabilities: {} },
  purpose: { value: "reference", confidence: 1, probabilities: {} },
  topics: {
    aiAgents: 0.1,
    softwareDevelopment: 0.9,
    identitySecurity: 0,
    cloudInfrastructure: 0,
    data: 0,
    design: 0.7,
    productivity: 0,
    businessFinance: 0,
    personalLifestyle: 0,
    food: 0,
    hardware: 0,
    entertainment: 0,
  },
};

describe("TUI bookmark data", () => {
  test("includes empty sidebar folders", () => {
    const session: ZenSession = {
      spaces: [{ uuid: "workspace-1", name: "Personal" }],
      folders: [
        {
          id: "empty-folder",
          name: "Empty",
          parentId: null,
          workspaceId: "workspace-1",
          prevSiblingInfo: { type: "tab", id: null },
          emptyTabIds: [],
          pinned: true,
          collapsed: false,
          splitViewGroup: false,
          saveOnWindowClose: true,
          userIcon: "",
        },
      ],
      groups: [],
      tabs: [],
      splitViewData: [],
    };
    const cache = openSearchCache(":memory:");
    try {
      expect(
        loadTuiBookmarks(session, "/missing/zen-sessions.jsonlz4", cache).folders,
      ).toEqual([
        expect.objectContaining({
          key: "sidebar-folder:empty-folder",
          name: "Empty",
          bookmarkCount: 0,
        }),
      ]);
    } finally {
      cache.close();
    }
  });

  test("hides descendants of collapsed folders", () => {
    const folder: TuiFolder = {
      kind: "folder",
      key: "saved-folder:development",
      id: "development",
      name: "Development",
      source: "saved",
      collection: "Saved Bookmarks",
      folderPath: ["Bookmarks Toolbar"],
      parentKey: "saved-folder:toolbar_____",
      ancestorFolderKeys: ["saved-folder:toolbar_____"],
      depth: 1,
      position: 0,
      bookmarkCount: 1,
    };

    const entries = [folder, bookmark()];
    expect(allFolderKeys(entries)).toEqual(new Set([folder.key]));
    expect(filterTuiEntries(entries, "", allFolderKeys(entries))).toEqual([
      folder,
    ]);
  });

  test("cycles sidebar workspaces while keeping saved bookmarks visible", () => {
    const saved = bookmark();
    const personal = bookmark({
      key: "sidebar:personal",
      id: "personal",
      source: "sidebar",
      collection: "Personal",
    });
    const work = bookmark({
      key: "sidebar:work",
      id: "work",
      source: "sidebar",
      collection: "Work",
    });
    const entries = [saved, personal, work];
    const names = sidebarWorkspaceNames(entries);

    expect(names).toEqual(["Personal", "Work"]);
    expect(cycleWorkspaceName(names, "Personal", 1)).toBe("Work");
    expect(cycleWorkspaceName(names, "Personal", -1)).toBe("Work");
    expect(entriesForWorkspace(entries, "Personal")).toEqual([saved, personal]);
  });

  test("fuzzy-filters across bookmark location and cached metadata", () => {
    const values = [
      bookmark(),
      bookmark({
        key: "sidebar:two",
        id: "two",
        title: "Dinner ideas",
        url: "https://example.com/recipes",
        source: "sidebar",
        collection: "Personal",
        folderPath: ["Food"],
      }),
    ];

    expect(filterTuiBookmarks(values, "otui doc").map((value) => value.id)).toEqual([
      "one",
    ]);
    expect(filterTuiBookmarks(values, "prsnl fod").map((value) => value.id)).toEqual([
      "two",
    ]);
  });

  test("refreshes page data and TypeSafe classification in the cache", async () => {
    const cache = openSearchCache(":memory:");
    try {
      const record = await refreshTuiBookmark(
        bookmark(),
        cache,
        {
          model: "test-model",
          async classify() {
            return classification;
          },
        },
        async () => ({
          fetchStatus: "ok",
          finalUrl: "https://example.com/opentui",
          pageTitle: "OpenTUI",
          description: "Terminal UI documentation",
          text: "Build terminal interfaces with React.",
          error: null,
        }),
      );

      expect(record.pageTitle).toBe("OpenTUI");
      expect(cachedClassificationSummary(record.classificationJson)).toEqual({
        resourceKind: "documentation",
        purpose: "reference",
        topics: [
          { name: "softwareDevelopment", probability: 0.9 },
          { name: "design", probability: 0.7 },
        ],
      });
    } finally {
      cache.close();
    }
  });
});
