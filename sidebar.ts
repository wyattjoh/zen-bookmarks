import { randomUUID } from "node:crypto";

/**
 * A URL entry stored in a Zen session tab.
 */
export type ZenEntry = {
  url: string | undefined;
  title: string | undefined;
  triggeringPrincipal_base64: string | undefined;
  hasUserInteraction: boolean | undefined;
  [key: string]: unknown;
};

/**
 * A tab record stored in `zen-sessions.jsonlz4`.
 */
export type ZenTab = {
  entries: ZenEntry[];
  lastAccessed: number;
  pinned: boolean;
  hidden: boolean;
  zenWorkspace: string | undefined;
  zenSyncId: string | undefined;
  zenEssential: boolean | undefined;
  zenDefaultUserContextId: string | null | undefined;
  zenPinnedIcon: string | null | undefined;
  zenIsEmpty: boolean | undefined;
  zenHasStaticIcon: boolean | undefined;
  zenGlanceId: string | null | undefined;
  zenIsGlance: boolean | undefined;
  zenLiveFolderItemId: string | null | undefined;
  groupId: string | undefined;
  index: number;
  _zenPinnedInitialState:
    | {
        entry: ZenEntry;
        image: string | null | undefined;
        [key: string]: unknown;
      }
    | undefined;
  [key: string]: unknown;
};

/**
 * A folder record stored in a Zen session.
 */
export type ZenFolder = {
  id: string;
  name: string;
  parentId: string | null;
  workspaceId: string;
  prevSiblingInfo: { type: string; id: string | null };
  emptyTabIds: string[];
  pinned: boolean;
  collapsed: boolean;
  splitViewGroup: boolean;
  saveOnWindowClose: boolean;
  userIcon: string;
  [key: string]: unknown;
};

/**
 * A group record corresponding to a Zen folder.
 */
export type ZenGroup = {
  id: string;
  name: string;
  pinned: boolean;
  splitView: boolean;
  color: string;
  collapsed: boolean;
  saveOnWindowClose: boolean;
  [key: string]: unknown;
};

/**
 * A workspace record stored in a Zen session.
 */
export type ZenWorkspace = {
  uuid: string;
  name: string;
  [key: string]: unknown;
};

/**
 * The subset of the Zen session document managed by this project.
 */
export type ZenSession = {
  spaces: ZenWorkspace[];
  folders: ZenFolder[];
  groups: ZenGroup[];
  tabs: ZenTab[];
  splitViewData: unknown[];
  [key: string]: unknown;
};

/**
 * A bookmark in the normalized sidebar tree.
 */
export type SidebarBookmark = {
  id: string;
  title: string;
  url: string;
  currentUrl: string | undefined;
  workspaceId: string;
  folderId: string | undefined;
  index: number;
};

/**
 * A folder in the normalized sidebar tree.
 */
export type SidebarFolder = {
  id: string;
  name: string;
  workspaceId: string;
  parentId: string | undefined;
  folders: SidebarFolder[];
  bookmarks: SidebarBookmark[];
};

/**
 * A workspace in the normalized sidebar tree.
 */
export type SidebarWorkspace = {
  id: string;
  name: string;
  folders: SidebarFolder[];
  bookmarks: SidebarBookmark[];
};

/**
 * The normalized Zen sidebar tree.
 */
export type SidebarTree = {
  workspaces: SidebarWorkspace[];
};

/**
 * A selector for one bookmark.
 */
export type BookmarkSelector = {
  id: string | undefined;
  url: string | undefined;
  workspace: string | undefined;
  folder: string | undefined;
};

/**
 * A parsed Netscape bookmark node.
 */
export type ImportNode =
  | { type: "folder"; name: string; children: ImportNode[] }
  | { type: "bookmark"; title: string; url: string };

/**
 * Serialize a content principal in the representation used by Zen session entries.
 *
 * @param url - URL for which to create a principal
 * @returns Serialized principal data
 */
export function contentPrincipal(url: string): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // Preserve non-standard URLs as-is.
  }
  return JSON.stringify({ "1": { "0": origin } });
}

/**
 * Validate that a parsed object has the core shape required by this tool.
 *
 * @param value - Parsed JSON value
 * @returns The validated Zen session
 */
export function parseSession(value: unknown): ZenSession {
  if (!value || typeof value !== "object") throw new Error("Zen session is not an object");
  const candidate = value as Partial<ZenSession>;
  for (const key of ["spaces", "folders", "groups", "tabs"] as const) {
    if (!Array.isArray(candidate[key])) throw new Error(`Zen session is missing array: ${key}`);
  }
  if (!Array.isArray(candidate.splitViewData)) candidate.splitViewData = [];
  return candidate as ZenSession;
}

/**
 * Return the pinned target and current URL data for a tab.
 *
 * @param tab - Zen tab record
 * @returns Bookmark data, or undefined for a non-bookmark tab
 */
export function bookmarkData(
  tab: ZenTab,
): { title: string; url: string; currentUrl: string | undefined } | undefined {
  if (!tab.pinned || tab.zenIsEmpty) return undefined;
  const pinned = tab._zenPinnedInitialState?.entry;
  const current = tab.entries.at(-1);
  const url = pinned?.url ?? current?.url;
  if (!url || url === "about:blank") return undefined;
  const title = pinned?.title ?? current?.title ?? url;
  return {
    title,
    url,
    currentUrl: current?.url && current.url !== url ? current.url : undefined,
  };
}

/**
 * Convert a raw Zen session into a normalized workspace tree.
 *
 * @param session - Parsed Zen session
 * @returns Normalized sidebar tree
 */
export function buildSidebarTree(session: ZenSession): SidebarTree {
  const roots = new Map<string, SidebarWorkspace>();
  for (const workspace of session.spaces) {
    roots.set(workspace.uuid, {
      id: workspace.uuid,
      name: workspace.name ?? workspace.uuid,
      folders: [],
      bookmarks: [],
    });
  }

  const folders = new Map<string, SidebarFolder>();
  for (const folder of session.folders) {
    folders.set(folder.id, {
      id: folder.id,
      name: folder.name ?? "(unnamed)",
      workspaceId: folder.workspaceId,
      parentId: folder.parentId ?? undefined,
      folders: [],
      bookmarks: [],
    });
  }

  const ensureWorkspace = (id: string | undefined): SidebarWorkspace => {
    const key = id ?? "(no workspace)";
    let workspace = roots.get(key);
    if (!workspace) {
      workspace = { id: key, name: key, folders: [], bookmarks: [] };
      roots.set(key, workspace);
    }
    return workspace;
  };

  for (const folder of folders.values()) {
    const parent = folder.parentId ? folders.get(folder.parentId) : undefined;
    if (parent) parent.folders.push(folder);
    else ensureWorkspace(folder.workspaceId).folders.push(folder);
  }

  for (const tab of session.tabs) {
    const data = bookmarkData(tab);
    if (!data) continue;
    const bookmark: SidebarBookmark = {
      id: tab.zenSyncId ?? `(tab-${session.tabs.indexOf(tab)})`,
      title: data.title,
      url: data.url,
      currentUrl: data.currentUrl,
      workspaceId: tab.zenWorkspace ?? "(no workspace)",
      folderId: tab.groupId,
      index: tab.index ?? 0,
    };
    const folder = tab.groupId ? folders.get(tab.groupId) : undefined;
    if (folder) folder.bookmarks.push(bookmark);
    else ensureWorkspace(tab.zenWorkspace).bookmarks.push(bookmark);
  }

  const folderPosition = new Map(session.folders.map((folder, index) => [folder.id, index]));
  const folderSortKey = (folder: SidebarFolder): number => {
    const bookmarkIndexes = folder.bookmarks.map((bookmark) => bookmark.index);
    const childIndexes = folder.folders.map(folderSortKey);
    return Math.min(
      ...bookmarkIndexes,
      ...childIndexes,
      Number.MAX_SAFE_INTEGER - session.folders.length + (folderPosition.get(folder.id) ?? 0),
    );
  };
  const sortContainer = (container: {
    folders: SidebarFolder[];
    bookmarks: SidebarBookmark[];
  }): void => {
    container.bookmarks.sort((left, right) => left.index - right.index);
    container.folders.sort((left, right) => folderSortKey(left) - folderSortKey(right));
    for (const folder of container.folders) sortContainer(folder);
  };
  for (const workspace of roots.values()) sortContainer(workspace);

  const ordered = session.spaces
    .map((space) => roots.get(space.uuid))
    .filter((workspace): workspace is SidebarWorkspace => Boolean(workspace));
  for (const workspace of roots.values()) {
    if (!ordered.includes(workspace)) ordered.push(workspace);
  }
  return { workspaces: ordered };
}

/**
 * Resolve a workspace by UUID or exact name, defaulting to the first workspace.
 *
 * @param session - Zen session
 * @param selector - Workspace UUID or name
 * @returns Matching workspace
 */
export function resolveWorkspace(
  session: ZenSession,
  selector: string | undefined,
): ZenWorkspace {
  if (session.spaces.length === 0) throw new Error("Session has no workspaces");
  if (!selector) return session.spaces[0];
  const matches = session.spaces.filter(
    (space) => space.uuid === selector || space.name === selector,
  );
  if (matches.length === 0) {
    throw new Error(
      `Workspace "${selector}" not found. Available: ${session.spaces.map((space) => space.name).join(", ")}`,
    );
  }
  if (matches.length > 1) throw new Error(`Workspace selector "${selector}" is ambiguous`);
  return matches[0];
}

/**
 * Resolve a folder by ID or exact name within a workspace.
 *
 * @param session - Zen session
 * @param workspaceId - Workspace containing the folder
 * @param selector - Folder ID or name
 * @returns Matching folder, or undefined for the workspace root
 */
export function resolveFolder(
  session: ZenSession,
  workspaceId: string,
  selector: string | undefined,
): ZenFolder | undefined {
  if (!selector) return undefined;
  const matches = session.folders.filter(
    (folder) =>
      folder.workspaceId === workspaceId &&
      (folder.id === selector || folder.name === selector),
  );
  if (matches.length === 0) throw new Error(`Folder "${selector}" not found in that workspace`);
  if (matches.length > 1) {
    throw new Error(
      `Folder "${selector}" is ambiguous (${matches.length} matches); target it with --id`,
    );
  }
  return matches[0];
}

/**
 * Generate a unique Zen session identifier.
 *
 * @param session - Zen session
 * @returns Unique identifier
 */
export function freshSessionId(session: ZenSession): string {
  const used = new Set<string>();
  for (const folder of session.folders) used.add(folder.id);
  for (const tab of session.tabs) if (tab.zenSyncId) used.add(tab.zenSyncId);
  const base = Date.now();
  let counter = 0;
  let id = `${base}-${++counter}`;
  while (used.has(id)) id = `${base}-${++counter}`;
  return id;
}

function maxTabIndex(session: ZenSession): number {
  return session.tabs.reduce((maximum, tab) => Math.max(maximum, tab.index ?? 0), 0);
}

function makeBookmarkTab(
  session: ZenSession,
  workspaceId: string,
  folderId: string | undefined,
  title: string,
  url: string,
): ZenTab {
  const entry: ZenEntry = {
    url,
    title,
    triggeringPrincipal_base64: contentPrincipal(url),
    hasUserInteraction: false,
  };
  return {
    entries: [entry],
    lastAccessed: Date.now(),
    pinned: true,
    hidden: false,
    zenWorkspace: workspaceId,
    zenSyncId: freshSessionId(session),
    zenEssential: false,
    zenDefaultUserContextId: "true",
    zenPinnedIcon: null,
    zenIsEmpty: false,
    zenHasStaticIcon: false,
    zenGlanceId: null,
    zenIsGlance: false,
    _zenPinnedInitialState: { entry: { ...entry }, image: null },
    zenLiveFolderItemId: null,
    groupId: folderId,
    index: maxTabIndex(session) + 1,
    searchMode: null,
    userContextId: 0,
    attributes: {},
    userTypedValue: "",
    userTypedClear: 0,
  };
}

function makeEmptyTab(session: ZenSession, workspaceId: string, folderId: string): ZenTab {
  const entry: ZenEntry = {
    url: "about:blank",
    title: undefined,
    triggeringPrincipal_base64: '{"3":{}}',
    hasUserInteraction: undefined,
  };
  return {
    entries: [entry],
    lastAccessed: Date.now(),
    pinned: true,
    hidden: false,
    zenWorkspace: workspaceId,
    zenSyncId: freshSessionId(session),
    zenEssential: false,
    zenDefaultUserContextId: null,
    zenPinnedIcon: null,
    zenIsEmpty: true,
    zenHasStaticIcon: false,
    zenGlanceId: null,
    zenIsGlance: false,
    _zenPinnedInitialState: { entry: { ...entry }, image: null },
    zenLiveFolderItemId: null,
    groupId: folderId,
    index: maxTabIndex(session) + 1,
    searchMode: null,
    userContextId: 0,
    attributes: {},
    userTypedValue: "",
    userTypedClear: 0,
    image: null,
  };
}

function folderDescendants(session: ZenSession, rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of session.folders) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id);
        changed = true;
      }
    }
  }
  return ids;
}

function assertNoSplitReferences(session: ZenSession, ids: Set<string>): void {
  const serialized = JSON.stringify(session.splitViewData ?? []);
  const referenced = [...ids].find((id) => serialized.includes(id));
  if (referenced) {
    throw new Error(
      `Cannot remove or move item ${referenced} because split-view data references it`,
    );
  }
}

function lastSiblingAnchor(
  session: ZenSession,
  workspaceId: string,
  parentId: string | null,
  excludedFolderIds: Set<string> = new Set(),
): { type: string; id: string | null } {
  const tabs = session.tabs
    .filter(
      (tab) =>
        tab.pinned &&
        !tab.zenIsEmpty &&
        tab.zenWorkspace === workspaceId &&
        (tab.groupId ?? null) === parentId,
    )
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
  const folders = session.folders.filter(
    (folder) =>
      folder.workspaceId === workspaceId &&
      (folder.parentId ?? null) === parentId &&
      !excludedFolderIds.has(folder.id),
  );
  if (tabs.length > 0) return { type: "tab", id: tabs.at(-1)?.zenSyncId ?? null };
  if (folders.length > 0) return { type: "group", id: folders.at(-1)?.id ?? null };
  return { type: "start", id: null };
}

function selectedFolder(
  session: ZenSession,
  input: { id: string | undefined; folder: string | undefined; workspace: string | undefined },
): ZenFolder {
  if (input.id) {
    const match = session.folders.find((folder) => folder.id === input.id);
    if (!match) throw new Error(`Folder ID "${input.id}" not found`);
    if (input.workspace) {
      const workspace = resolveWorkspace(session, input.workspace);
      if (match.workspaceId !== workspace.uuid) {
        throw new Error(`Folder ${input.id} is not in workspace "${workspace.name}"`);
      }
    }
    return match;
  }
  const workspace = resolveWorkspace(session, input.workspace);
  const match = resolveFolder(session, workspace.uuid, input.folder);
  if (!match) throw new Error("Folder selector requires --id or --folder");
  return match;
}

function matchingBookmarks(session: ZenSession, selector: BookmarkSelector): ZenTab[] {
  const workspaceId = selector.workspace
    ? resolveWorkspace(session, selector.workspace).uuid
    : undefined;
  const folderId =
    selector.folder && workspaceId
      ? resolveFolder(session, workspaceId, selector.folder)?.id
      : undefined;
  if (selector.folder && !workspaceId) {
    throw new Error("--folder requires --workspace when selecting a bookmark");
  }
  return session.tabs.filter((tab) => {
    const data = bookmarkData(tab);
    if (!data) return false;
    if (selector.id && tab.zenSyncId !== selector.id) return false;
    if (selector.url && data.url !== selector.url && data.currentUrl !== selector.url) return false;
    if (workspaceId && tab.zenWorkspace !== workspaceId) return false;
    if (selector.folder && tab.groupId !== folderId) return false;
    return Boolean(selector.id || selector.url);
  });
}

function oneBookmark(session: ZenSession, selector: BookmarkSelector): ZenTab {
  const matches = matchingBookmarks(session, selector);
  if (matches.length === 0) throw new Error("No sidebar bookmark matched the selector");
  if (matches.length > 1) {
    throw new Error(`Bookmark selector matched ${matches.length} items; use --id to disambiguate`);
  }
  return matches[0];
}

/**
 * Add a pinned sidebar bookmark.
 *
 * @param session - Session to mutate
 * @param input - Bookmark properties and destination
 * @returns Human-readable mutation summary
 */
export function addBookmark(
  session: ZenSession,
  input: {
    url: string;
    title: string | undefined;
    workspace: string | undefined;
    folder: string | undefined;
  },
): string {
  const workspace = resolveWorkspace(session, input.workspace);
  const folder = resolveFolder(session, workspace.uuid, input.folder);
  const title = input.title ?? input.url;
  const tab = makeBookmarkTab(session, workspace.uuid, folder?.id, title, input.url);
  session.tabs.push(tab);
  return `Added bookmark ${tab.zenSyncId}: "${title}" to workspace "${workspace.name}"`;
}

/**
 * Update a pinned sidebar bookmark.
 *
 * @param session - Session to mutate
 * @param selector - Bookmark selector
 * @param changes - New bookmark values
 * @returns Human-readable mutation summary
 */
export function updateBookmark(
  session: ZenSession,
  selector: BookmarkSelector,
  changes: { title: string | undefined; url: string | undefined },
): string {
  if (changes.title === undefined && changes.url === undefined) {
    throw new Error("bookmark update requires --title or --url");
  }
  const tab = oneBookmark(session, selector);
  const old = bookmarkData(tab);
  if (!old) throw new Error("Matched tab is not a sidebar bookmark");
  const nextTitle = changes.title ?? old.title;
  const nextUrl = changes.url ?? old.url;
  const initial = tab._zenPinnedInitialState ?? {
    entry: {
      url: old.url,
      title: old.title,
      triggeringPrincipal_base64: contentPrincipal(old.url),
      hasUserInteraction: false,
    },
    image: null,
  };
  initial.entry.url = nextUrl;
  initial.entry.title = nextTitle;
  initial.entry.triggeringPrincipal_base64 = contentPrincipal(nextUrl);
  tab._zenPinnedInitialState = initial;
  const current = tab.entries.at(-1);
  if (current && (!current.url || current.url === old.url)) {
    current.url = nextUrl;
    current.title = nextTitle;
    current.triggeringPrincipal_base64 = contentPrincipal(nextUrl);
  }
  if (changes.url) {
    tab.zenPinnedIcon = null;
    tab.zenHasStaticIcon = false;
    tab.image = null;
  }
  tab.lastAccessed = Date.now();
  return `Updated bookmark ${tab.zenSyncId}: "${nextTitle}" (${nextUrl})`;
}

/**
 * Move a pinned sidebar bookmark, appending it to the destination container.
 *
 * @param session - Session to mutate
 * @param selector - Bookmark selector
 * @param destination - Target workspace and folder
 * @returns Human-readable mutation summary
 */
export function moveBookmark(
  session: ZenSession,
  selector: BookmarkSelector,
  destination: { workspace: string | undefined; folder: string | undefined },
): string {
  const tab = oneBookmark(session, selector);
  if (tab.zenSyncId) assertNoSplitReferences(session, new Set([tab.zenSyncId]));
  const currentWorkspace = resolveWorkspace(session, tab.zenWorkspace);
  const workspace = destination.workspace
    ? resolveWorkspace(session, destination.workspace)
    : currentWorkspace;
  const folder = resolveFolder(session, workspace.uuid, destination.folder);
  tab.zenWorkspace = workspace.uuid;
  tab.groupId = folder?.id;
  tab.index = maxTabIndex(session) + 1;
  return `Moved bookmark ${tab.zenSyncId} to workspace "${workspace.name}"${folder ? `, folder "${folder.name}"` : ""}`;
}

/**
 * Remove one or more pinned sidebar bookmarks.
 *
 * @param session - Session to mutate
 * @param selector - Bookmark selector
 * @param removeAll - Whether an ambiguous selector may remove every match
 * @returns Human-readable mutation summary
 */
export function removeBookmark(
  session: ZenSession,
  selector: BookmarkSelector,
  removeAll: boolean,
): string {
  const matches = matchingBookmarks(session, selector);
  if (matches.length === 0) throw new Error("No sidebar bookmark matched the selector");
  if (matches.length > 1 && !removeAll) {
    throw new Error(`Bookmark selector matched ${matches.length} items; use --id or --all`);
  }
  const ids = new Set(matches.map((tab) => tab.zenSyncId));
  assertNoSplitReferences(session, new Set([...ids].filter((id): id is string => Boolean(id))));
  session.tabs = session.tabs.filter((tab) => !matches.includes(tab));
  return `Removed ${matches.length} bookmark${matches.length === 1 ? "" : "s"}`;
}

/**
 * Add a folder to a workspace.
 *
 * @param session - Session to mutate
 * @param input - Folder name and destination
 * @returns Human-readable mutation summary
 */
export function addFolder(
  session: ZenSession,
  input: { name: string; workspace: string | undefined; parent: string | undefined },
): string {
  const workspace = resolveWorkspace(session, input.workspace);
  const parent = resolveFolder(session, workspace.uuid, input.parent);
  const id = freshSessionId(session);
  const folder: ZenFolder = {
    id,
    name: input.name,
    parentId: parent?.id ?? null,
    workspaceId: workspace.uuid,
    prevSiblingInfo: lastSiblingAnchor(session, workspace.uuid, parent?.id ?? null),
    emptyTabIds: [],
    pinned: true,
    collapsed: false,
    splitViewGroup: false,
    saveOnWindowClose: true,
    userIcon: "",
  };
  session.folders.push(folder);
  const emptyTab = makeEmptyTab(session, workspace.uuid, id);
  folder.emptyTabIds = [emptyTab.zenSyncId as string];
  const group: ZenGroup = {
    id,
    name: input.name,
    pinned: true,
    splitView: false,
    color: "zen-workspace-color",
    collapsed: false,
    saveOnWindowClose: true,
  };
  session.groups.push(group);
  session.tabs.push(emptyTab);
  return `Added folder ${id}: "${input.name}" to workspace "${workspace.name}"`;
}

/**
 * Rename a folder.
 *
 * @param session - Session to mutate
 * @param input - Folder selector and new name
 * @returns Human-readable mutation summary
 */
export function updateFolder(
  session: ZenSession,
  input: { id: string | undefined; folder: string | undefined; workspace: string | undefined; name: string },
): string {
  const folder = selectedFolder(session, input);
  const oldName = folder.name;
  folder.name = input.name;
  const group = session.groups.find((candidate) => candidate.id === folder.id);
  if (group) group.name = input.name;
  return `Renamed folder ${folder.id}: "${oldName}" -> "${input.name}"`;
}

/**
 * Move a folder and all of its descendants, appending it to the destination.
 *
 * @param session - Session to mutate
 * @param input - Source selector and destination
 * @returns Human-readable mutation summary
 */
export function moveFolder(
  session: ZenSession,
  input: {
    id: string | undefined;
    folder: string | undefined;
    workspace: string | undefined;
    toWorkspace: string | undefined;
    parent: string | undefined;
  },
): string {
  const folder = selectedFolder(session, input);
  const sourceWorkspace = resolveWorkspace(session, folder.workspaceId);
  const destinationWorkspace = input.toWorkspace
    ? resolveWorkspace(session, input.toWorkspace)
    : sourceWorkspace;
  const parent = resolveFolder(session, destinationWorkspace.uuid, input.parent);
  const descendants = folderDescendants(session, folder.id);
  if (parent && descendants.has(parent.id)) throw new Error("Cannot move a folder into itself or a descendant");
  assertNoSplitReferences(session, descendants);
  folder.parentId = parent?.id ?? null;
  folder.workspaceId = destinationWorkspace.uuid;
  folder.prevSiblingInfo = lastSiblingAnchor(
    session,
    destinationWorkspace.uuid,
    parent?.id ?? null,
    descendants,
  );
  for (const candidate of session.folders) {
    if (descendants.has(candidate.id)) candidate.workspaceId = destinationWorkspace.uuid;
  }
  for (const tab of session.tabs) {
    if (tab.groupId && descendants.has(tab.groupId)) tab.zenWorkspace = destinationWorkspace.uuid;
  }
  return `Moved folder ${folder.id} to workspace "${destinationWorkspace.name}"${parent ? ` under "${parent.name}"` : ""}`;
}

/**
 * Remove a folder, requiring `recursive` when it contains children or bookmarks.
 *
 * @param session - Session to mutate
 * @param input - Folder selector and removal policy
 * @returns Human-readable mutation summary
 */
export function removeFolder(
  session: ZenSession,
  input: {
    id: string | undefined;
    folder: string | undefined;
    workspace: string | undefined;
    recursive: boolean;
  },
): string {
  const folder = selectedFolder(session, input);
  const ids = folderDescendants(session, folder.id);
  const tabs = session.tabs.filter((tab) => tab.groupId && ids.has(tab.groupId));
  const nonEmptyTabs = tabs.filter((tab) => !tab.zenIsEmpty);
  if (!input.recursive && (ids.size > 1 || nonEmptyTabs.length > 0)) {
    throw new Error("Folder is not empty; pass --recursive to remove its contents");
  }
  assertNoSplitReferences(
    session,
    new Set([...ids, ...tabs.map((tab) => tab.zenSyncId).filter((id): id is string => Boolean(id))]),
  );
  session.folders = session.folders.filter((candidate) => !ids.has(candidate.id));
  session.groups = session.groups.filter((group) => !ids.has(group.id));
  session.tabs = session.tabs.filter((tab) => !tab.groupId || !ids.has(tab.groupId));
  return `Removed folder ${folder.id} and ${ids.size - 1} descendant folder${ids.size === 2 ? "" : "s"}`;
}

/**
 * Add a workspace using Zen's current session fields.
 *
 * @param session - Session to mutate
 * @param name - Workspace name
 * @returns Human-readable mutation summary
 */
export function addWorkspace(session: ZenSession, name: string): string {
  if (session.spaces.some((space) => space.name === name)) {
    throw new Error(`Workspace "${name}" already exists`);
  }
  const uuid = randomUUID();
  session.spaces.push({
    uuid,
    name,
    icon: "",
    containerTabId: 0,
    position: session.spaces.length,
    theme: null,
    hasCollapsedPinnedTabs: false,
  });
  return `Added workspace ${uuid}: "${name}"`;
}

/**
 * Rename a workspace.
 *
 * @param session - Session to mutate
 * @param selector - Workspace UUID or name
 * @param name - New name
 * @returns Human-readable mutation summary
 */
export function updateWorkspace(
  session: ZenSession,
  selector: string | undefined,
  name: string,
): string {
  const workspace = resolveWorkspace(session, selector);
  if (session.spaces.some((candidate) => candidate !== workspace && candidate.name === name)) {
    throw new Error(`Workspace "${name}" already exists`);
  }
  const oldName = workspace.name;
  workspace.name = name;
  return `Renamed workspace ${workspace.uuid}: "${oldName}" -> "${name}"`;
}

/**
 * Reorder a workspace.
 *
 * @param session - Session to mutate
 * @param selector - Workspace UUID or name
 * @param index - Zero-based destination index
 * @returns Human-readable mutation summary
 */
export function moveWorkspace(
  session: ZenSession,
  selector: string | undefined,
  index: number,
): string {
  const workspace = resolveWorkspace(session, selector);
  if (!Number.isInteger(index) || index < 0 || index >= session.spaces.length) {
    throw new Error(`Workspace index must be between 0 and ${session.spaces.length - 1}`);
  }
  const oldIndex = session.spaces.indexOf(workspace);
  session.spaces.splice(oldIndex, 1);
  session.spaces.splice(index, 0, workspace);
  session.spaces.forEach((space, position) => {
    if ("position" in space) space.position = position;
  });
  return `Moved workspace ${workspace.uuid} from index ${oldIndex} to ${index}`;
}

/**
 * Remove a workspace, requiring `recursive` when it owns tabs or folders.
 *
 * @param session - Session to mutate
 * @param selector - Workspace UUID or name
 * @param recursive - Whether owned state may be removed
 * @returns Human-readable mutation summary
 */
export function removeWorkspace(
  session: ZenSession,
  selector: string | undefined,
  recursive: boolean,
): string {
  if (session.spaces.length === 1) throw new Error("Cannot remove the last workspace");
  const workspace = resolveWorkspace(session, selector);
  const folderIds = new Set(
    session.folders.filter((folder) => folder.workspaceId === workspace.uuid).map((folder) => folder.id),
  );
  const tabs = session.tabs.filter((tab) => tab.zenWorkspace === workspace.uuid);
  if (!recursive && (folderIds.size > 0 || tabs.length > 0)) {
    throw new Error("Workspace is not empty; pass --recursive to remove its tabs and folders");
  }
  assertNoSplitReferences(
    session,
    new Set([
      ...folderIds,
      ...tabs.map((tab) => tab.zenSyncId).filter((id): id is string => Boolean(id)),
    ]),
  );
  session.spaces = session.spaces.filter((space) => space !== workspace);
  session.folders = session.folders.filter((folder) => !folderIds.has(folder.id));
  session.groups = session.groups.filter((group) => !folderIds.has(group.id));
  session.tabs = session.tabs.filter((tab) => tab.zenWorkspace !== workspace.uuid);
  session.spaces.forEach((space, position) => {
    if ("position" in space) space.position = position;
  });
  return `Removed workspace ${workspace.uuid}: "${workspace.name}"`;
}

/**
 * Decode entities used in Netscape bookmark exports.
 *
 * @param text - Encoded text
 * @returns Decoded text
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse a line-oriented Netscape bookmark document.
 *
 * @param html - Netscape bookmark HTML
 * @returns Parsed nodes
 */
export function parseNetscape(html: string): ImportNode[] {
  const root: ImportNode[] = [];
  const stack: ImportNode[][] = [root];
  let pendingFolder: Extract<ImportNode, { type: "folder" }> | undefined;
  for (const line of html.split("\n")) {
    const heading = line.match(/<H3[^>]*>(.*?)<\/H3>/i);
    const anchor = line.match(/<A\s+HREF="([^"]*)"[^>]*>(.*?)<\/A>/i);
    if (heading) {
      const folder: Extract<ImportNode, { type: "folder" }> = {
        type: "folder",
        name: decodeEntities(heading[1]),
        children: [],
      };
      stack.at(-1)?.push(folder);
      pendingFolder = folder;
    } else if (anchor) {
      stack.at(-1)?.push({
        type: "bookmark",
        title: decodeEntities(anchor[2]),
        url: decodeEntities(anchor[1]),
      });
    }
    if (/<DL>/i.test(line) && pendingFolder) {
      stack.push(pendingFolder.children);
      pendingFolder = undefined;
    }
    if (/<\/DL>/i.test(line) && stack.length > 1) stack.pop();
  }
  return root;
}

/**
 * Replace one workspace's pinned sidebar tree from parsed import nodes.
 *
 * @param session - Session to mutate
 * @param workspaceSelector - Workspace UUID or name
 * @param nodes - Imported folder and bookmark nodes
 * @returns Human-readable mutation summary
 */
export function importWorkspace(
  session: ZenSession,
  workspaceSelector: string | undefined,
  nodes: ImportNode[],
): string {
  const workspace = resolveWorkspace(session, workspaceSelector);
  const top = nodes.length === 1 && nodes[0].type === "folder" ? nodes[0].children : nodes;
  const existing = session.tabs.filter(
    (tab) => tab.pinned && !tab.zenIsEmpty && tab.zenWorkspace === workspace.uuid,
  );
  const pool = new Map<string, ZenTab[]>();
  for (const tab of existing) {
    const data = bookmarkData(tab);
    if (!data) continue;
    const matches = pool.get(data.url) ?? [];
    matches.push(tab);
    pool.set(data.url, matches);
  }

  const oldFolderIds = new Set(
    session.folders.filter((folder) => folder.workspaceId === workspace.uuid).map((folder) => folder.id),
  );
  assertNoSplitReferences(session, oldFolderIds);
  session.tabs = session.tabs.filter(
    (tab) => !(tab.pinned && tab.zenWorkspace === workspace.uuid),
  );
  session.folders = session.folders.filter((folder) => folder.workspaceId !== workspace.uuid);
  session.groups = session.groups.filter((group) => !oldFolderIds.has(group.id));

  let reused = 0;
  let created = 0;
  const emit = (children: ImportNode[], parentId: string | undefined): void => {
    for (const child of children) {
      if (child.type === "bookmark") {
        const candidates = pool.get(child.url);
        const tab = candidates?.shift();
        if (tab) {
          tab.zenWorkspace = workspace.uuid;
          tab.groupId = parentId;
          tab.index = maxTabIndex(session) + 1;
          session.tabs.push(tab);
          reused += 1;
        } else {
          session.tabs.push(
            makeBookmarkTab(session, workspace.uuid, parentId, child.title, child.url),
          );
          created += 1;
        }
        continue;
      }
      const id = freshSessionId(session);
      const folder: ZenFolder = {
        id,
        name: child.name,
        parentId: parentId ?? null,
        workspaceId: workspace.uuid,
        prevSiblingInfo: lastSiblingAnchor(session, workspace.uuid, parentId ?? null),
        emptyTabIds: [],
        pinned: true,
        collapsed: false,
        splitViewGroup: false,
        saveOnWindowClose: true,
        userIcon: "",
      };
      session.folders.push(folder);
      const emptyTab = makeEmptyTab(session, workspace.uuid, id);
      folder.emptyTabIds = [emptyTab.zenSyncId as string];
      session.groups.push({
        id,
        name: child.name,
        pinned: true,
        splitView: false,
        color: "zen-workspace-color",
        collapsed: false,
        saveOnWindowClose: true,
      });
      session.tabs.push(emptyTab);
      emit(child.children, id);
    }
  };
  emit(top, undefined);
  const dropped = [...pool.values()].reduce((count, tabs) => count + tabs.length, 0);
  return `Rebuilt workspace "${workspace.name}": ${reused} reused, ${created} created, ${dropped} dropped`;
}

/**
 * Check structural invariants before writing a Zen session.
 *
 * @param session - Session to validate
 * @returns Validation errors
 */
export function validateSession(session: ZenSession): string[] {
  const errors: string[] = [];
  const workspaceIds = new Set<string>();
  for (const workspace of session.spaces) {
    if (!workspace.uuid) errors.push("Workspace has no UUID");
    if (workspaceIds.has(workspace.uuid)) errors.push(`Duplicate workspace UUID: ${workspace.uuid}`);
    workspaceIds.add(workspace.uuid);
  }
  if (workspaceIds.size === 0) errors.push("Session has no workspaces");

  const folderIds = new Set<string>();
  for (const folder of session.folders) {
    if (folderIds.has(folder.id)) errors.push(`Duplicate folder ID: ${folder.id}`);
    folderIds.add(folder.id);
    if (!workspaceIds.has(folder.workspaceId)) {
      errors.push(`Folder ${folder.id} references missing workspace ${folder.workspaceId}`);
    }
  }
  for (const folder of session.folders) {
    if (folder.parentId && !folderIds.has(folder.parentId)) {
      errors.push(`Folder ${folder.id} references missing parent ${folder.parentId}`);
    }
    const visited = new Set<string>();
    let current: ZenFolder | undefined = folder;
    while (current?.parentId) {
      if (visited.has(current.id)) {
        errors.push(`Folder cycle includes ${folder.id}`);
        break;
      }
      visited.add(current.id);
      current = session.folders.find((candidate) => candidate.id === current?.parentId);
    }
  }
  const groupIds = new Set(session.groups.map((group) => group.id));
  for (const folder of session.folders) {
    if (!groupIds.has(folder.id)) errors.push(`Folder ${folder.id} has no matching group`);
  }

  const tabIds = new Set<string>();
  for (const tab of session.tabs) {
    if (tab.zenSyncId) {
      if (tabIds.has(tab.zenSyncId)) errors.push(`Duplicate tab sync ID: ${tab.zenSyncId}`);
      tabIds.add(tab.zenSyncId);
    }
    if (tab.zenWorkspace && !workspaceIds.has(tab.zenWorkspace)) {
      errors.push(`Tab ${tab.zenSyncId ?? "(unknown)"} references missing workspace ${tab.zenWorkspace}`);
    }
  }
  return errors;
}
