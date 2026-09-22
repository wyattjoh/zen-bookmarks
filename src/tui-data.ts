import type { BookmarkCandidate } from "./bookmark-candidates.ts";
import {
  canonicalLinkUrl,
  indexBookmarkLinks,
  type LinkClassifier,
  type LinkContentLoader,
} from "./link-index.ts";
import {
  loadSavedBookmarkData,
  placesPathForSession,
  type SavedBookmarkData,
  type SavedBookmarkFolder,
  type SavedBookmarkTreeBookmark,
} from "./places-bookmarks.ts";
import type { CachedLinkRecord, SearchCache } from "./search-cache.ts";
import {
  buildSidebarTree,
  type SidebarBookmark,
  type SidebarFolder,
  type SidebarWorkspace,
  type ZenSession,
} from "./sidebar.ts";

/**
 * Origin of a bookmark or folder shown in the interactive browser.
 */
export type BookmarkSource = "saved" | "sidebar";

/**
 * Unified saved or sidebar bookmark displayed by the TUI.
 */
export type TuiBookmark = {
  kind: "bookmark";
  key: string;
  id: string;
  title: string;
  url: string;
  currentUrl: string | undefined;
  source: BookmarkSource;
  collection: string;
  folderPath: string[];
  parentKey: string | undefined;
  ancestorFolderKeys: string[];
  depth: number;
  position: number;
  cached: CachedLinkRecord | null;
};

/**
 * Unified saved or sidebar folder displayed by the TUI.
 */
export type TuiFolder = {
  kind: "folder";
  key: string;
  id: string;
  name: string;
  source: BookmarkSource;
  collection: string;
  folderPath: string[];
  parentKey: string | undefined;
  ancestorFolderKeys: string[];
  depth: number;
  position: number;
  bookmarkCount: number;
};

/**
 * Selectable entry in the interactive bookmark tree.
 */
export type TuiEntry = TuiBookmark | TuiFolder;

/**
 * Result of loading bookmark sources for the TUI.
 */
export type TuiBookmarkLoadResult = {
  entries: TuiEntry[];
  bookmarks: TuiBookmark[];
  folders: TuiFolder[];
  warnings: string[];
};

/**
 * Parsed cached classification fields suitable for display.
 */
export type CachedClassificationSummary = {
  resourceKind: string | undefined;
  purpose: string | undefined;
  topics: Array<{ name: string; probability: number }>;
};

type TreeValue<T> = {
  kind: "folder" | "bookmark";
  position: number;
  value: T;
};

function cachedBookmark(
  bookmark: Omit<TuiBookmark, "cached">,
  cache: SearchCache,
): TuiBookmark {
  return {
    ...bookmark,
    cached: cache.getLink(canonicalLinkUrl(bookmark.url)),
  };
}

function byPosition(
  left: { kind: "folder" | "bookmark"; position: number },
  right: { kind: "folder" | "bookmark"; position: number },
): number {
  return (
    left.position - right.position ||
    (left.kind === right.kind ? 0 : left.kind === "folder" ? -1 : 1)
  );
}

function groupedByParent<T extends { parentId: string | undefined }>(
  values: T[],
): Map<string | undefined, T[]> {
  const grouped = new Map<string | undefined, T[]>();
  for (const value of values) {
    const siblings = grouped.get(value.parentId) ?? [];
    siblings.push(value);
    grouped.set(value.parentId, siblings);
  }
  return grouped;
}

function savedBookmarkCount(
  folderId: string,
  foldersByParent: Map<string | undefined, SavedBookmarkFolder[]>,
  bookmarksByParent: Map<string | undefined, SavedBookmarkTreeBookmark[]>,
  visited = new Set<string>(),
): number {
  if (visited.has(folderId)) return 0;
  const nextVisited = new Set(visited).add(folderId);
  return (
    (bookmarksByParent.get(folderId)?.length ?? 0) +
    (foldersByParent.get(folderId) ?? []).reduce(
      (total, folder) =>
        total + savedBookmarkCount(folder.id, foldersByParent, bookmarksByParent, nextVisited),
      0,
    )
  );
}

function savedEntries(data: SavedBookmarkData, cache: SearchCache): TuiEntry[] {
  const foldersByParent = groupedByParent(data.folders);
  const bookmarksByParent = groupedByParent(
    data.bookmarks.map((bookmark) => ({ ...bookmark, parentId: bookmark.folderId })),
  );
  const entries: TuiEntry[] = [];
  const walk = (
    parentId: string | undefined,
    folderPath: string[],
    ancestorFolderKeys: string[],
    depth: number,
  ): void => {
    const children: Array<TreeValue<SavedBookmarkFolder | SavedBookmarkTreeBookmark>> = [
      ...(foldersByParent.get(parentId) ?? []).map((folder) => ({
        kind: "folder" as const,
        position: folder.position,
        value: folder,
      })),
      ...(bookmarksByParent.get(parentId) ?? []).map((bookmark) => ({
        kind: "bookmark" as const,
        position: bookmark.position,
        value: bookmark,
      })),
    ].sort(byPosition);

    for (const child of children) {
      if (child.kind === "bookmark") {
        const bookmark = child.value as SavedBookmarkTreeBookmark;
        entries.push(
          cachedBookmark(
            {
              kind: "bookmark",
              key: `saved:${bookmark.id}`,
              id: bookmark.id,
              title: bookmark.title,
              url: bookmark.url,
              currentUrl: undefined,
              source: "saved",
              collection: "Saved Bookmarks",
              folderPath,
              parentKey: parentId ? `saved-folder:${parentId}` : undefined,
              ancestorFolderKeys,
              depth,
              position: bookmark.position,
            },
            cache,
          ),
        );
        continue;
      }

      const folder = child.value as SavedBookmarkFolder;
      const key = `saved-folder:${folder.id}`;
      entries.push({
        kind: "folder",
        key,
        id: folder.id,
        name: folder.name,
        source: "saved",
        collection: "Saved Bookmarks",
        folderPath,
        parentKey: parentId ? `saved-folder:${parentId}` : undefined,
        ancestorFolderKeys,
        depth,
        position: folder.position,
        bookmarkCount: savedBookmarkCount(
          folder.id,
          foldersByParent,
          bookmarksByParent,
        ),
      });
      walk(
        folder.id,
        [...folderPath, folder.name],
        [...ancestorFolderKeys, key],
        depth + 1,
      );
    }
  };
  walk(undefined, [], [], 0);
  return entries;
}

function sidebarFolderPosition(folder: SidebarFolder): number {
  return Math.min(
    ...folder.bookmarks.map((bookmark) => bookmark.index),
    ...folder.folders.map(sidebarFolderPosition),
    Number.MAX_SAFE_INTEGER,
  );
}

function sidebarBookmarkCount(folder: SidebarFolder): number {
  return (
    folder.bookmarks.length +
    folder.folders.reduce((total, child) => total + sidebarBookmarkCount(child), 0)
  );
}

function sidebarEntries(workspace: SidebarWorkspace, cache: SearchCache): TuiEntry[] {
  const entries: TuiEntry[] = [];
  const walk = (
    folders: SidebarFolder[],
    bookmarks: SidebarBookmark[],
    folderPath: string[],
    ancestorFolderKeys: string[],
    depth: number,
    parentKey: string | undefined,
  ): void => {
    const children: Array<TreeValue<SidebarFolder | SidebarBookmark>> = [
      ...folders.map((folder) => ({
        kind: "folder" as const,
        position: sidebarFolderPosition(folder),
        value: folder,
      })),
      ...bookmarks.map((bookmark) => ({
        kind: "bookmark" as const,
        position: bookmark.index,
        value: bookmark,
      })),
    ].sort(byPosition);

    for (const child of children) {
      if (child.kind === "bookmark") {
        const bookmark = child.value as SidebarBookmark;
        entries.push(
          cachedBookmark(
            {
              kind: "bookmark",
              key: `sidebar:${bookmark.id}`,
              id: bookmark.id,
              title: bookmark.title,
              url: bookmark.url,
              currentUrl: bookmark.currentUrl,
              source: "sidebar",
              collection: workspace.name,
              folderPath,
              parentKey,
              ancestorFolderKeys,
              depth,
              position: bookmark.index,
            },
            cache,
          ),
        );
        continue;
      }

      const folder = child.value as SidebarFolder;
      const key = `sidebar-folder:${folder.id}`;
      entries.push({
        kind: "folder",
        key,
        id: folder.id,
        name: folder.name,
        source: "sidebar",
        collection: workspace.name,
        folderPath,
        parentKey,
        ancestorFolderKeys,
        depth,
        position: sidebarFolderPosition(folder),
        bookmarkCount: sidebarBookmarkCount(folder),
      });
      walk(
        folder.folders,
        folder.bookmarks,
        [...folderPath, folder.name],
        [...ancestorFolderKeys, key],
        depth + 1,
        key,
      );
    }
  };
  walk(workspace.folders, workspace.bookmarks, [], [], 0, undefined);
  return entries;
}

/**
 * Load saved Places and pinned sidebar bookmarks and folders into one view model.
 *
 * @param session - Parsed Zen session
 * @param sessionPath - Path to the source `zen-sessions.jsonlz4`
 * @param cache - Persistent link metadata cache
 * @returns Unified tree entries plus non-fatal source warnings
 */
export function loadTuiBookmarks(
  session: ZenSession,
  sessionPath: string,
  cache: SearchCache,
): TuiBookmarkLoadResult {
  const warnings: string[] = [];
  let saved: TuiEntry[] = [];
  try {
    saved = savedEntries(
      loadSavedBookmarkData(placesPathForSession(sessionPath)),
      cache,
    );
  } catch (error) {
    warnings.push(
      `Saved bookmarks unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const sidebar = buildSidebarTree(session).workspaces.flatMap((workspace) =>
    sidebarEntries(workspace, cache),
  );
  const entries = [...saved, ...sidebar];
  return {
    entries,
    bookmarks: entries.filter((entry): entry is TuiBookmark => entry.kind === "bookmark"),
    folders: entries.filter((entry): entry is TuiFolder => entry.kind === "folder"),
    warnings,
  };
}

function searchableBookmarkText(bookmark: TuiBookmark): string {
  const classification = bookmark.cached
    ? cachedClassificationSummary(bookmark.cached.classificationJson)
    : undefined;
  return [
    bookmark.title,
    bookmark.url,
    bookmark.currentUrl ?? "",
    bookmark.source,
    bookmark.collection,
    ...bookmark.folderPath,
    bookmark.cached?.pageTitle ?? "",
    bookmark.cached?.description ?? "",
    bookmark.cached?.summary ?? "",
    classification?.resourceKind ?? "",
    classification?.purpose ?? "",
    ...(classification?.topics.map((topic) => topic.name) ?? []),
  ]
    .join(" ")
    .toLowerCase();
}

function searchableEntryText(entry: TuiEntry): string {
  if (entry.kind === "bookmark") return searchableBookmarkText(entry);
  return [entry.name, entry.source, entry.collection, ...entry.folderPath]
    .join(" ")
    .toLowerCase();
}

function fuzzyScore(text: string, query: string): number | undefined {
  let score = 0;
  let searchFrom = 0;
  let previous = -2;
  for (const character of query) {
    const index = text.indexOf(character, searchFrom);
    if (index < 0) return undefined;
    score += index === previous + 1 ? 4 : 1;
    if (index === 0 || /[\s/_.:-]/.test(text[index - 1] ?? "")) score += 3;
    score -= Math.min(index - searchFrom, 10) * 0.05;
    previous = index;
    searchFrom = index + 1;
  }
  return score - text.length * 0.0001;
}

/**
 * Collect every folder key so a newly loaded profile starts fully collapsed.
 *
 * @param entries - Unified bookmark and folder entries
 * @returns Set containing every folder key
 */
export function allFolderKeys(entries: TuiEntry[]): Set<string> {
  return new Set(
    entries
      .filter((entry): entry is TuiFolder => entry.kind === "folder")
      .map((folder) => folder.key),
  );
}

/**
 * List sidebar workspace names in their source order.
 *
 * @param entries - Unified bookmark and folder entries
 * @returns Unique sidebar workspace names
 */
export function sidebarWorkspaceNames(entries: TuiEntry[]): string[] {
  return [
    ...new Set(
      entries
        .filter((entry) => entry.source === "sidebar")
        .map((entry) => entry.collection),
    ),
  ];
}

/**
 * Select the next or previous sidebar workspace with wraparound.
 *
 * @param names - Available workspace names
 * @param currentName - Active workspace name
 * @param direction - `1` for next or `-1` for previous
 * @returns Cycled workspace name, or `undefined` when none exist
 */
export function cycleWorkspaceName(
  names: string[],
  currentName: string | undefined,
  direction: 1 | -1,
): string | undefined {
  if (names.length === 0) return undefined;
  const currentIndex = currentName ? names.indexOf(currentName) : -1;
  const startIndex = currentIndex >= 0 ? currentIndex : direction === 1 ? -1 : 0;
  return names[(startIndex + direction + names.length) % names.length];
}

/**
 * Keep global saved bookmarks and one active sidebar workspace.
 *
 * @param entries - Unified bookmark and folder entries
 * @param workspaceName - Active sidebar workspace
 * @returns Entries visible in that workspace view
 */
export function entriesForWorkspace(
  entries: TuiEntry[],
  workspaceName: string | undefined,
): TuiEntry[] {
  return entries.filter(
    (entry) =>
      entry.source === "saved" ||
      workspaceName === undefined ||
      entry.collection === workspaceName,
  );
}

/**
 * Filter tree entries and hide descendants of collapsed folders.
 *
 * @param entries - Unified bookmark and folder entries
 * @param query - User-entered fuzzy filter
 * @param collapsedFolderKeys - Folder keys whose descendants are hidden
 * @returns Visible selectable entries
 */
export function filterTuiEntries(
  entries: TuiEntry[],
  query: string,
  collapsedFolderKeys: ReadonlySet<string>,
): TuiEntry[] {
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return entries.filter((entry) =>
      entry.ancestorFolderKeys.every((key) => !collapsedFolderKeys.has(key)),
    );
  }

  return entries
    .map((entry, index) => ({
      entry,
      index,
      score: fuzzyScore(searchableEntryText(entry), normalized),
    }))
    .filter(
      (result): result is { entry: TuiEntry; index: number; score: number } =>
        result.score !== undefined,
    )
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((result) => result.entry);
}

/**
 * Fuzzy-filter bookmarks against title, URL, location, and cached metadata.
 *
 * @param bookmarks - Unified bookmark view models
 * @param query - User-entered filter text
 * @returns Matching bookmarks ordered by fuzzy score and original order
 */
export function filterTuiBookmarks(
  bookmarks: TuiBookmark[],
  query: string,
): TuiBookmark[] {
  return filterTuiEntries(bookmarks, query, new Set()).filter(
    (entry): entry is TuiBookmark => entry.kind === "bookmark",
  );
}

/**
 * Convert a unified TUI bookmark to the existing link-index candidate shape.
 *
 * @param bookmark - TUI bookmark
 * @returns Candidate accepted by the link indexer
 */
export function tuiBookmarkCandidate(bookmark: TuiBookmark): BookmarkCandidate {
  return {
    bookmark: {
      id: bookmark.id,
      title: bookmark.title,
      url: bookmark.url,
      currentUrl: bookmark.currentUrl,
      workspaceId: bookmark.collection,
      folderId: undefined,
      index: bookmark.position,
    },
    workspaceName: bookmark.collection,
    folderPath: bookmark.folderPath,
  };
}

/**
 * Re-fetch and reclassify one bookmark, then return its updated cache record.
 *
 * @param bookmark - Bookmark selected in the TUI
 * @param cache - Persistent link cache
 * @param classifier - TypeSafe link classifier
 * @param loader - Public page loader
 * @returns Updated cache record
 */
export async function refreshTuiBookmark(
  bookmark: TuiBookmark,
  cache: SearchCache,
  classifier: LinkClassifier,
  loader: LinkContentLoader,
): Promise<CachedLinkRecord> {
  await indexBookmarkLinks(
    [tuiBookmarkCandidate(bookmark)],
    cache,
    classifier,
    loader,
    true,
    1,
  );
  const record = cache.getLink(canonicalLinkUrl(bookmark.url));
  if (!record) throw new Error(`Refresh did not cache ${bookmark.url}`);
  return record;
}

/**
 * Parse cached TypeSafe facets without failing the TUI on stale cache data.
 *
 * @param classificationJson - Cached classification JSON
 * @returns Human-readable classification fields
 */
export function cachedClassificationSummary(
  classificationJson: string,
): CachedClassificationSummary {
  try {
    const value = JSON.parse(classificationJson) as {
      resourceKind: { value: unknown } | undefined;
      purpose: { value: unknown } | undefined;
      topics: Record<string, unknown> | undefined;
    };
    const topics = Object.entries(value.topics ?? {})
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .filter(([, probability]) => probability >= 0.5)
      .sort((left, right) => right[1] - left[1])
      .map(([name, probability]) => ({ name, probability }));
    return {
      resourceKind:
        typeof value.resourceKind?.value === "string"
          ? value.resourceKind.value
          : undefined,
      purpose:
        typeof value.purpose?.value === "string" ? value.purpose.value : undefined,
      topics,
    };
  } catch {
    return { resourceKind: undefined, purpose: undefined, topics: [] };
  }
}
