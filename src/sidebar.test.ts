import { describe, expect, test } from "bun:test";
import {
  addBookmark,
  addFolder,
  addWorkspace,
  buildSidebarTree,
  importWorkspace,
  moveBookmark,
  moveFolder,
  moveWorkspace,
  removeBookmark,
  removeFolder,
  removeWorkspace,
  updateBookmark,
  updateFolder,
  updateWorkspace,
  validateSession,
  type ZenEntry,
  type ZenSession,
  type ZenTab,
} from "./sidebar.ts";

function entry(url: string, title: string): ZenEntry {
  return {
    url,
    title,
    triggeringPrincipal_base64: "principal",
    hasUserInteraction: false,
  };
}

function tab(
  id: string,
  url: string,
  workspace: string,
  folder: string | undefined,
  empty = false,
): ZenTab {
  const item = entry(url, empty ? "" : id);
  return {
    entries: [item],
    lastAccessed: 1,
    pinned: true,
    hidden: false,
    zenWorkspace: workspace,
    zenSyncId: id,
    zenEssential: false,
    zenDefaultUserContextId: null,
    zenPinnedIcon: null,
    zenIsEmpty: empty,
    zenHasStaticIcon: false,
    zenGlanceId: null,
    zenIsGlance: false,
    zenLiveFolderItemId: null,
    groupId: folder,
    index: id === "bookmark-1" ? 2 : 1,
    _zenPinnedInitialState: { entry: { ...item }, image: null },
  };
}

function fixture(): ZenSession {
  return {
    spaces: [
      { uuid: "workspace-1", name: "Personal", position: 0 },
      { uuid: "workspace-2", name: "Work", position: 1 },
    ],
    folders: [
      {
        id: "folder-1",
        name: "Reading",
        parentId: null,
        workspaceId: "workspace-1",
        prevSiblingInfo: { type: "start", id: null },
        emptyTabIds: ["empty-1"],
        pinned: true,
        collapsed: false,
        splitViewGroup: false,
        saveOnWindowClose: true,
        userIcon: "",
      },
    ],
    groups: [
      {
        id: "folder-1",
        name: "Reading",
        pinned: true,
        splitView: false,
        color: "zen-workspace-color",
        collapsed: false,
        saveOnWindowClose: true,
      },
    ],
    tabs: [
      tab("empty-1", "about:blank", "workspace-1", "folder-1", true),
      tab("bookmark-1", "https://example.com", "workspace-1", "folder-1"),
    ],
    splitViewData: [],
    lastCollected: 1,
  };
}

function clone(): ZenSession {
  return structuredClone(fixture());
}

describe("sidebar tree", () => {
  test("builds workspaces, folders, and stable bookmark IDs", () => {
    const tree = buildSidebarTree(fixture());
    expect(tree.workspaces).toHaveLength(2);
    expect(tree.workspaces[0].folders[0].name).toBe("Reading");
    expect(tree.workspaces[0].folders[0].bookmarks[0].id).toBe("bookmark-1");
  });
});

describe("bookmark CRUD", () => {
  test("adds, updates, moves, and removes a bookmark", () => {
    const session = clone();
    addBookmark(session, {
      url: "https://bun.sh",
      title: "Bun",
      workspace: "Personal",
      folder: undefined,
    });
    const added = session.tabs.find((candidate) => candidate._zenPinnedInitialState?.entry.url === "https://bun.sh");
    expect(added?.zenSyncId).toBeTruthy();

    updateBookmark(
      session,
      { id: added?.zenSyncId, url: undefined, workspace: undefined, folder: undefined },
      { title: "Bun Runtime", url: "https://bun.sh/docs" },
    );
    expect(added?._zenPinnedInitialState?.entry.title).toBe("Bun Runtime");

    moveBookmark(
      session,
      { id: added?.zenSyncId, url: undefined, workspace: undefined, folder: undefined },
      { workspace: "Work", folder: undefined },
    );
    expect(added?.zenWorkspace).toBe("workspace-2");

    removeBookmark(
      session,
      { id: added?.zenSyncId, url: undefined, workspace: undefined, folder: undefined },
      false,
    );
    expect(session.tabs).not.toContain(added);
    expect(validateSession(session)).toEqual([]);
  });
});

describe("folder CRUD", () => {
  test("adds, renames, moves, and recursively removes a folder", () => {
    const session = clone();
    const summary = addFolder(session, {
      name: "Projects",
      workspace: "Personal",
      parent: undefined,
    });
    const id = summary.match(/folder ([^:]+):/)?.[1];
    expect(id).toBeTruthy();
    expect(session.folders.find((folder) => folder.id === id)?.emptyTabIds).toHaveLength(1);

    updateFolder(session, {
      id,
      folder: undefined,
      workspace: "Personal",
      name: "Active Projects",
    });
    expect(session.groups.find((group) => group.id === id)?.name).toBe("Active Projects");

    moveFolder(session, {
      id,
      folder: undefined,
      workspace: "Personal",
      toWorkspace: "Work",
      parent: undefined,
    });
    expect(session.folders.find((folder) => folder.id === id)?.workspaceId).toBe("workspace-2");

    removeFolder(session, {
      id,
      folder: undefined,
      workspace: "Work",
      recursive: true,
    });
    expect(session.folders.some((folder) => folder.id === id)).toBe(false);
    expect(validateSession(session)).toEqual([]);
  });
});

describe("workspace CRUD", () => {
  test("adds, renames, reorders, and removes an empty workspace", () => {
    const session = clone();
    const summary = addWorkspace(session, "Research");
    const id = summary.match(/workspace ([^:]+):/)?.[1];
    expect(id).toBeTruthy();
    updateWorkspace(session, id, "R&D");
    moveWorkspace(session, id, 0);
    expect(session.spaces[0].name).toBe("R&D");
    removeWorkspace(session, id, false);
    expect(session.spaces.some((workspace) => workspace.uuid === id)).toBe(false);
    expect(validateSession(session)).toEqual([]);
  });

  test("requires recursive removal for non-empty workspaces", () => {
    const session = clone();
    expect(() => removeWorkspace(session, "Personal", false)).toThrow("not empty");
  });
});

describe("import", () => {
  test("reuses matching bookmarks and creates imported folders", () => {
    const session = clone();
    const summary = importWorkspace(session, "Personal", [
      {
        type: "folder",
        name: "Imported",
        children: [{ type: "bookmark", title: "Example", url: "https://example.com" }],
      },
      { type: "bookmark", title: "New", url: "https://new.example" },
    ]);
    expect(summary).toContain("1 reused");
    expect(summary).toContain("1 created");
    expect(session.folders.some((folder) => folder.name === "Imported")).toBe(true);
    expect(validateSession(session)).toEqual([]);
  });
});
