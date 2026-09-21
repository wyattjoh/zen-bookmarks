import { createCliRenderer, type ScrollBoxRenderable } from "@opentui/core";
import {
  createRoot,
  useKeyboard,
  useRenderer,
  useTerminalDimensions,
} from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getTypeSafeApiKey } from "./credential-store.ts";
import {
  createTypeSafeLinkClassifier,
  fetchPublicLinkContent,
} from "./link-index.ts";
import {
  openSearchCache,
  type CachedLinkRecord,
} from "./search-cache.ts";
import { loadSession, resolveSessionPath } from "./session-store.ts";
import {
  allFolderKeys,
  cachedClassificationSummary,
  cycleWorkspaceName,
  entriesForWorkspace,
  filterTuiEntries,
  loadTuiBookmarks,
  refreshTuiBookmark,
  sidebarWorkspaceNames,
  type TuiBookmark,
  type TuiBookmarkLoadResult,
  type TuiEntry,
  type TuiFolder,
} from "./tui-data.ts";

type AppProps = {
  initialEntries: TuiEntry[];
  warnings: string[];
  onRefresh: (bookmark: TuiBookmark) => Promise<CachedLinkRecord>;
  onReload: () => Promise<TuiBookmarkLoadResult>;
  onExit: () => void;
};

type FocusTarget = "workspaces" | "search" | "bookmarks" | "details";

type RefreshState =
  | { status: "idle"; message: string }
  | { status: "loading"; message: string }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

function sourceLabel(entry: TuiEntry): string {
  return entry.source === "saved" ? "SAVED" : "SIDEBAR";
}

function sourceColor(entry: TuiEntry): string {
  return entry.source === "saved" ? "cyan" : "magenta";
}

function entryLocation(entry: TuiEntry): string {
  return [
    entry.collection,
    ...entry.folderPath,
    ...(entry.kind === "folder" ? [entry.name] : []),
  ].join(" / ");
}

function bookmarkDetailLines(bookmark: TuiBookmark): Array<[string, string]> {
  const lines: Array<[string, string]> = [
    ["Source", sourceLabel(bookmark)],
    ["Location", entryLocation(bookmark)],
    ["URL", bookmark.url],
  ];
  if (bookmark.currentUrl) lines.push(["Current URL", bookmark.currentUrl]);
  if (!bookmark.cached) {
    lines.push(["Cache", "Not cached"]);
    return lines;
  }

  const classification = cachedClassificationSummary(
    bookmark.cached.classificationJson,
  );
  lines.push(
    [
      "Cache",
      `${bookmark.cached.fetchStatus} · ${new Date(bookmark.cached.fetchedAt).toLocaleString()}`,
    ],
    ["Page title", bookmark.cached.pageTitle ?? "—"],
    ["Description", bookmark.cached.description ?? "—"],
    ["Resource", classification.resourceKind ?? "—"],
    ["Purpose", classification.purpose ?? "—"],
  );
  if (bookmark.cached.finalUrl && bookmark.cached.finalUrl !== bookmark.url) {
    lines.push(["Final URL", bookmark.cached.finalUrl]);
  }
  if (bookmark.cached.error) lines.push(["Fetch note", bookmark.cached.error]);
  return lines;
}

function topicLabel(name: string): string {
  const words = name.replace(/([a-z])([A-Z])/g, "$1 $2");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function folderDetailLines(folder: TuiFolder): Array<[string, string]> {
  return [
    ["Source", sourceLabel(folder)],
    ["Location", entryLocation(folder)],
    ["Bookmarks", String(folder.bookmarkCount)],
  ];
}

type DetailPaneProps = {
  entry: TuiEntry | undefined;
  focused: boolean;
  onFocus: () => void;
};

function DetailPane({ entry, focused, onFocus }: DetailPaneProps) {
  const scrollbox = useRef<ScrollBoxRenderable | null>(null);

  useEffect(() => {
    scrollbox.current?.scrollTo(0);
  }, [entry?.key]);

  useKeyboard((key) => {
    if (!focused) return;
    if (key.name === "up" || key.name === "k") {
      key.preventDefault();
      scrollbox.current?.scrollBy(-1);
      return;
    }
    if (key.name === "down" || key.name === "j") {
      key.preventDefault();
      scrollbox.current?.scrollBy(1);
      return;
    }
    if (key.name === "pageup") {
      key.preventDefault();
      scrollbox.current?.scrollBy(-8);
      return;
    }
    if (key.name === "pagedown") {
      key.preventDefault();
      scrollbox.current?.scrollBy(8);
    }
  });

  if (!entry) {
    return (
      <box
        border
        title="Details"
        borderColor={focused ? "cyan" : "gray"}
        padding={1}
        flexGrow={1}
        onMouseDown={onFocus}
        onMouseScroll={onFocus}
      >
        <text fg="gray">No matching entries.</text>
      </box>
    );
  }

  const lines =
    entry.kind === "bookmark"
      ? bookmarkDetailLines(entry)
      : folderDetailLines(entry);
  const classification =
    entry.kind === "bookmark" && entry.cached
      ? cachedClassificationSummary(entry.cached.classificationJson)
      : undefined;
  const cachedText = entry.kind === "bookmark" ? entry.cached?.text.trim() : undefined;
  return (
    <box
      border
      title="Details"
      titleColor="cyan"
      borderColor={focused ? "cyan" : "gray"}
      padding={1}
      flexDirection="column"
      flexGrow={1}
      onMouseDown={onFocus}
      onMouseScroll={onFocus}
    >
      <scrollbox ref={scrollbox} flexGrow={1}>
        <box flexDirection="column" gap={1}>
          <text fg="white" wrapMode="word">
            {entry.kind === "bookmark" ? entry.title : entry.name}
          </text>
          {lines.map(([label, value]) => (
            <box key={label} flexDirection="column">
              <text fg="gray">{label}</text>
              <text fg="white" wrapMode="word">
                {value}
              </text>
            </box>
          ))}
          {classification && classification.topics.length > 0 ? (
            <box
              border
              borderColor="gray"
              title="Topics"
              titleColor="cyan"
              flexDirection="column"
              paddingX={1}
            >
              <box flexDirection="row">
                <text fg="cyan" width="70%">Topic</text>
                <text fg="cyan" width="30%">Confidence</text>
              </box>
              {classification.topics.map((topic) => (
                <box key={topic.name} flexDirection="row">
                  <text fg="white" width="70%" truncate>
                    {topicLabel(topic.name)}
                  </text>
                  <text fg="gray" width="30%">
                    {Math.round(topic.probability * 100)}%
                  </text>
                </box>
              ))}
            </box>
          ) : null}
          {cachedText ? (
            <box flexDirection="column">
              <text fg="gray">Cached text</text>
              <text fg="white" wrapMode="word">
                {cachedText}
              </text>
            </box>
          ) : null}
        </box>
      </scrollbox>
    </box>
  );
}

type BookmarkListProps = {
  entries: TuiEntry[];
  selectedIndex: number;
  query: string;
  focused: boolean;
  collapsedFolderKeys: ReadonlySet<string>;
  onFocus: () => void;
  onSelect: (index: number) => void;
  onToggleFolder: (folder: TuiFolder) => void;
};

/**
 * Render the grouped, selectable bookmark-and-folder tree used by the TUI.
 *
 * @param props - Tree entries, selection state, collapse state, and callbacks
 * @returns OpenTUI bookmark-list elements
 */
export function BookmarkList({
  entries,
  selectedIndex,
  query,
  focused,
  collapsedFolderKeys,
  onFocus,
  onSelect,
  onToggleFolder,
}: BookmarkListProps) {
  const renderer = useRenderer();
  const scrollbox = useRef<ScrollBoxRenderable | null>(null);
  const textSelectionDragged = useRef(false);
  const bookmarkCount = entries.filter((entry) => entry.kind === "bookmark").length;

  useEffect(() => {
    scrollbox.current?.scrollChildIntoView(`bookmark-row-${selectedIndex}`);
  }, [entries, selectedIndex]);

  const finishMouseSelection = (): void => {
    const dragged = textSelectionDragged.current;
    textSelectionDragged.current = false;
    queueMicrotask(() => {
      if (dragged) return;
      const selectedText = renderer.getSelectionContainer()?.getSelectedText() ?? "";
      if ([...selectedText].length <= 1) renderer.clearSelection();
    });
  };

  let previousGroup = "";
  return (
    <box
      border
      title={`Bookmarks (${bookmarkCount})`}
      titleColor="cyan"
      borderColor={focused ? "cyan" : "gray"}
      padding={1}
      flexDirection="column"
      flexGrow={1}
      onMouseDown={onFocus}
      onMouseScroll={onFocus}
    >
      <scrollbox
        ref={scrollbox}
        flexGrow={1}
        scrollX={false}
        focused={focused}
        onMouseScroll={onFocus}
      >
        {entries.map((entry, index) => {
          const group = query
            ? "Matches"
            : `${sourceLabel(entry)} · ${entry.collection}`;
          const showGroup = group !== previousGroup;
          previousGroup = group;
          const selected = index === selectedIndex;
          const paddingLeft = 1 + entry.depth * 2;
          return (
            <box
              key={entry.key}
              id={`bookmark-row-${index}`}
              flexDirection="column"
              width="100%"
              minWidth={0}
            >
              {showGroup ? (
                <text fg="cyan" selectable={false}>
                  {group}
                </text>
              ) : null}
              {entry.kind === "folder" ? (
                <box
                  backgroundColor={selected ? "#334155" : undefined}
                  paddingLeft={paddingLeft}
                  flexDirection="row"
                  width="100%"
                  minWidth={0}
                  onMouseDown={() => {
                    onFocus();
                    onSelect(index);
                    onToggleFolder(entry);
                  }}
                >
                  <box width={2} flexShrink={0}>
                    <text fg={selected ? "green" : sourceColor(entry)} selectable={false}>
                      {selected ? "›" : " "}
                    </text>
                  </box>
                  <box width={2} flexShrink={0}>
                    <text fg="cyan" selectable={false}>
                      {collapsedFolderKeys.has(entry.key) ? "▸" : "▾"}
                    </text>
                  </box>
                  <text
                    fg={selected ? "green" : "white"}
                    flexGrow={1}
                    flexShrink={1}
                    minWidth={0}
                    height={1}
                    wrapMode="none"
                    truncate
                    selectable={false}
                  >
                    {entry.name} ({entry.bookmarkCount})
                  </text>
                </box>
              ) : (
                <box
                  backgroundColor={selected ? "#334155" : undefined}
                  paddingLeft={paddingLeft}
                  flexDirection="row"
                  width="100%"
                  minWidth={0}
                  onMouseDown={() => {
                    textSelectionDragged.current = false;
                    onFocus();
                    onSelect(index);
                  }}
                  onMouseDrag={() => {
                    textSelectionDragged.current = true;
                  }}
                  onMouseUp={finishMouseSelection}
                >
                  <box width={2} flexShrink={0}>
                    <text
                      fg={selected ? "green" : sourceColor(entry)}
                      selectable={false}
                    >
                      {selected ? "›" : " "}
                    </text>
                  </box>
                  <box width={2} flexShrink={0}>
                    <text fg="gray" selectable={false}>
                      {entry.cached ? "●" : "○"}
                    </text>
                  </box>
                  <box
                    flexDirection="column"
                    flexGrow={1}
                    flexShrink={1}
                    minWidth={0}
                  >
                    <text
                      fg={selected ? "green" : "white"}
                      width="100%"
                      height={1}
                      wrapMode="none"
                      truncate
                    >
                      {entry.title}
                    </text>
                    <text
                      fg="gray"
                      width="100%"
                      height={1}
                      wrapMode="none"
                      truncate
                    >
                      {entry.url}
                    </text>
                  </box>
                </box>
              )}
            </box>
          );
        })}
      </scrollbox>
    </box>
  );
}

/**
 * Render the interactive bookmark browser.
 *
 * @param props - Loaded entries and process-boundary callbacks
 * @returns OpenTUI React application tree
 */
export function App({
  initialEntries,
  warnings,
  onRefresh,
  onReload,
  onExit,
}: AppProps) {
  const { width, height } = useTerminalDimensions();
  const [entries, setEntries] = useState(initialEntries);
  const [activeWorkspace, setActiveWorkspace] = useState<string | undefined>(
    () => sidebarWorkspaceNames(initialEntries)[0],
  );
  const [collapsedFolderKeys, setCollapsedFolderKeys] = useState<Set<string>>(
    () => allFolderKeys(initialEntries),
  );
  const [query, setQuery] = useState("");
  const [focus, setFocus] = useState<FocusTarget>("bookmarks");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [refresh, setRefresh] = useState<RefreshState>({
    status: "idle",
    message: warnings[0] ?? "Ready",
  });
  const workspaceNames = useMemo(() => sidebarWorkspaceNames(entries), [entries]);
  const workspaceEntries = useMemo(
    () => entriesForWorkspace(entries, activeWorkspace),
    [activeWorkspace, entries],
  );
  const filtered = useMemo(
    () => filterTuiEntries(workspaceEntries, query, collapsedFolderKeys),
    [collapsedFolderKeys, query, workspaceEntries],
  );
  const selected = filtered[selectedIndex];
  const bookmarkCount = workspaceEntries.filter(
    (entry) => entry.kind === "bookmark",
  ).length;
  const folderCount = workspaceEntries.length - bookmarkCount;
  const vertical = width < 100;
  const bookmarkPanelHeight = vertical
    ? Math.floor(Math.max(1, height - 12) * 0.45)
    : Math.max(1, height - 12);
  const bookmarkPageSize = Math.max(1, Math.floor(bookmarkPanelHeight / 2));

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, selectedIndex]);

  const toggleFolder = (folder: TuiFolder): void => {
    setCollapsedFolderKeys((current) => {
      const next = new Set(current);
      if (next.has(folder.key)) next.delete(folder.key);
      else next.add(folder.key);
      return next;
    });
  };

  const setFolderCollapsed = (folder: TuiFolder, collapsed: boolean): void => {
    setCollapsedFolderKeys((current) => {
      const next = new Set(current);
      if (collapsed) next.add(folder.key);
      else next.delete(folder.key);
      return next;
    });
  };

  const refreshSelected = async (): Promise<void> => {
    if (!selected || selected.kind !== "bookmark" || refresh.status === "loading") {
      if (selected?.kind === "folder") {
        setRefresh({ status: "idle", message: "Select a bookmark to re-scrape" });
      }
      return;
    }
    setRefresh({ status: "loading", message: `Refreshing ${selected.title}…` });
    try {
      const cached = await onRefresh(selected);
      setEntries((current) =>
        current.map((entry) =>
          entry.key === selected.key && entry.kind === "bookmark"
            ? { ...entry, cached }
            : entry,
        ),
      );
      setRefresh({ status: "success", message: `Refreshed ${selected.title}` });
    } catch (error) {
      setRefresh({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const reloadBookmarks = async (): Promise<void> => {
    if (refresh.status === "loading") return;
    const selectedKey = selected?.key;
    setRefresh({ status: "loading", message: "Reloading bookmarks from Zen…" });
    try {
      const result = await onReload();
      const nextWorkspaceNames = sidebarWorkspaceNames(result.entries);
      const nextActiveWorkspace =
        activeWorkspace && nextWorkspaceNames.includes(activeWorkspace)
          ? activeWorkspace
          : nextWorkspaceNames[0];
      const previousFolderKeys = allFolderKeys(entries);
      const nextCollapsedFolderKeys = new Set(collapsedFolderKeys);
      for (const key of allFolderKeys(result.entries)) {
        if (!previousFolderKeys.has(key)) nextCollapsedFolderKeys.add(key);
      }
      const nextFiltered = filterTuiEntries(
        entriesForWorkspace(result.entries, nextActiveWorkspace),
        query,
        nextCollapsedFolderKeys,
      );
      const preservedIndex = selectedKey
        ? nextFiltered.findIndex((entry) => entry.key === selectedKey)
        : -1;
      setEntries(result.entries);
      setActiveWorkspace(nextActiveWorkspace);
      setCollapsedFolderKeys(nextCollapsedFolderKeys);
      setSelectedIndex(
        preservedIndex >= 0
          ? preservedIndex
          : Math.min(selectedIndex, Math.max(0, nextFiltered.length - 1)),
      );
      setRefresh({
        status: "success",
        message:
          result.warnings[0] ??
          `Reloaded ${result.bookmarks.length} bookmarks and ${result.folders.length} folders`,
      });
    } catch (error) {
      setRefresh({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const selectWorkspace = (workspace: string): void => {
    setActiveWorkspace(workspace);
    setSelectedIndex(0);
    setRefresh({ status: "success", message: `Workspace: ${workspace}` });
  };

  const cycleWorkspace = (direction: 1 | -1): void => {
    const nextWorkspace = cycleWorkspaceName(
      workspaceNames,
      activeWorkspace,
      direction,
    );
    if (!nextWorkspace) {
      setRefresh({ status: "idle", message: "No Zen workspaces found" });
      return;
    }
    selectWorkspace(nextWorkspace);
  };

  const moveWorkspaceSelection = (offset: number): void => {
    if (workspaceNames.length === 0) return;
    const currentIndex = activeWorkspace
      ? workspaceNames.indexOf(activeWorkspace)
      : 0;
    const nextIndex = Math.max(
      0,
      Math.min(currentIndex + offset, workspaceNames.length - 1),
    );
    const nextWorkspace = workspaceNames[nextIndex];
    if (nextWorkspace) selectWorkspace(nextWorkspace);
  };

  const moveBookmarkSelection = (index: number): void => {
    setSelectedIndex(
      Math.max(0, Math.min(index, Math.max(0, filtered.length - 1))),
    );
  };

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      key.preventDefault();
      onExit();
      return;
    }
    if (refresh.status === "loading") return;

    if (key.name === "tab") {
      key.preventDefault();
      cycleWorkspace(key.shift ? -1 : 1);
      return;
    }
    if (
      focus !== "search" &&
      (key.name === "/" || key.sequence === "/")
    ) {
      key.preventDefault();
      setFocus("search");
      return;
    }

    if (focus === "workspaces") {
      if (key.name === "left" || key.name === "right") {
        key.preventDefault();
        moveWorkspaceSelection(key.name === "left" ? -1 : 1);
        return;
      }
      if (key.name === "down" || key.name === "return") {
        key.preventDefault();
        setFocus("search");
        return;
      }
      if (key.name === "q" || key.name === "escape") {
        key.preventDefault();
        onExit();
      }
      return;
    }

    if (focus === "search") {
      if (key.name === "up") {
        key.preventDefault();
        setFocus("workspaces");
        return;
      }
      if (key.name === "down" || key.name === "return") {
        key.preventDefault();
        setFocus("bookmarks");
        return;
      }
      if (key.name === "escape") {
        key.preventDefault();
        if (query) setQuery("");
        else setFocus("bookmarks");
      }
      return;
    }

    if (focus === "details") {
      if (key.name === "left") {
        key.preventDefault();
        setFocus("bookmarks");
        return;
      }
      if (key.name === "q" || key.name === "escape") {
        key.preventDefault();
        onExit();
      }
      return;
    }

    if (key.name === "up") {
      key.preventDefault();
      if (filtered.length === 0 || selectedIndex === 0) setFocus("search");
      else moveBookmarkSelection(selectedIndex - 1);
      return;
    }
    if (key.name === "down") {
      key.preventDefault();
      moveBookmarkSelection(selectedIndex + 1);
      return;
    }
    if (key.name === "k" || key.name === "j") {
      key.preventDefault();
      moveBookmarkSelection(selectedIndex + (key.name === "k" ? -1 : 1));
      return;
    }
    if (key.name === "pageup" || key.name === "pagedown") {
      key.preventDefault();
      moveBookmarkSelection(
        selectedIndex + (key.name === "pageup" ? -bookmarkPageSize : bookmarkPageSize),
      );
      return;
    }
    if (selected?.kind === "folder" && key.name === "left") {
      key.preventDefault();
      setFolderCollapsed(selected, true);
      return;
    }
    if (key.name === "right") {
      key.preventDefault();
      if (selected?.kind === "folder" && collapsedFolderKeys.has(selected.key)) {
        setFolderCollapsed(selected, false);
      } else {
        setFocus("details");
      }
      return;
    }
    if (
      selected?.kind === "folder" &&
      (key.name === "return" || key.name === "space" || key.sequence === " ")
    ) {
      key.preventDefault();
      toggleFolder(selected);
      return;
    }
    if (selected?.kind === "bookmark" && key.name === "return") {
      key.preventDefault();
      setFocus("details");
      return;
    }
    if ((key.shift && key.name === "r") || key.sequence === "R") {
      key.preventDefault();
      void reloadBookmarks();
      return;
    }
    if (key.name === "r") {
      key.preventDefault();
      void refreshSelected();
      return;
    }
    if (key.name === "escape" && query) {
      key.preventDefault();
      setQuery("");
      return;
    }
    if (key.name === "escape" || key.name === "q") {
      key.preventDefault();
      onExit();
    }
  });

  const statusColor =
    refresh.status === "error"
      ? "red"
      : refresh.status === "success"
        ? "green"
        : refresh.status === "loading"
          ? "yellow"
          : "gray";

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg="cyan">zen-bookmarks</text>
        <text fg="gray">
          {bookmarkCount} bookmarks · {folderCount} folders · ● cached · ○ uncached
        </text>
      </box>
      <box
        title=" Workspaces "
        titleColor="cyan"
        border
        borderColor={focus === "workspaces" ? "cyan" : "gray"}
        height={3}
        paddingX={1}
        flexDirection="row"
        gap={1}
        onMouseDown={() => setFocus("workspaces")}
      >
        {workspaceNames.length > 0 ? (
          workspaceNames.map((workspace) => (
            <text
              key={workspace}
              fg={workspace === activeWorkspace ? "cyan" : "gray"}
              bg={workspace === activeWorkspace ? "#334155" : undefined}
              onMouseDown={() => {
                selectWorkspace(workspace);
                setFocus("workspaces");
              }}
            >
              {` ${workspace} `}
            </text>
          ))
        ) : (
          <text fg="gray">None</text>
        )}
      </box>
      <box
        title=" Search "
        titleColor="cyan"
        border
        borderColor={focus === "search" ? "cyan" : "gray"}
        height={3}
        paddingX={1}
        onMouseDown={() => setFocus("search")}
      >
        <input
          value={query}
          placeholder="Type to fuzzy-search bookmarks"
          focused={focus === "search"}
          onInput={(value) => setQuery(typeof value === "string" ? value : "")}
          onSubmit={() => setFocus("bookmarks")}
        />
      </box>
      <box flexDirection={vertical ? "column" : "row"} flexGrow={1} gap={1}>
        <box width={vertical ? "100%" : "45%"} height={vertical ? "45%" : "100%"}>
          <BookmarkList
            entries={filtered}
            selectedIndex={selectedIndex}
            query={query}
            focused={focus === "bookmarks"}
            collapsedFolderKeys={collapsedFolderKeys}
            onFocus={() => setFocus("bookmarks")}
            onSelect={setSelectedIndex}
            onToggleFolder={toggleFolder}
          />
        </box>
        <box width={vertical ? "100%" : "55%"} height={vertical ? "55%" : "100%"}>
          <DetailPane
            entry={selected}
            focused={focus === "details"}
            onFocus={() => setFocus("details")}
          />
        </box>
      </box>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={statusColor} truncate>
          {refresh.message}
        </text>
        <text fg="gray">
          {focus === "workspaces"
            ? "←/→ select workspace · Down/Enter search · Tab rotates"
            : focus === "search"
              ? "Type to fuzzy-search · Up workspaces · Down/Enter bookmarks · Esc clear"
              : focus === "details"
                ? "↑/↓ or j/k scroll · Page Up/Down page · Left bookmarks"
                : "↑/↓ or j/k navigate · Page Up/Down page · Right details · ↑ from first searches"}
          {" · q/Esc quit"}
        </text>
      </box>
    </box>
  );
}

/**
 * Open the interactive saved-and-sidebar bookmark browser.
 */
export async function runTui(): Promise<void> {
  const sessionPath = resolveSessionPath(undefined, undefined);
  const loaded = loadSession(sessionPath);
  const cache = openSearchCache();
  const initial = loadTuiBookmarks(loaded.session, sessionPath, cache);
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    screenMode: "alternate-screen",
    targetFps: 30,
    useMouse: true,
  }).catch((error: unknown) => {
    cache.close();
    throw error;
  });
  const root = createRoot(renderer);

  await new Promise<void>((resolve) => {
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      root.unmount();
      cache.close();
      renderer.destroy();
      resolve();
    };
    const reload = async (): Promise<TuiBookmarkLoadResult> =>
      loadTuiBookmarks(loadSession(sessionPath).session, sessionPath, cache);
    const refresh = async (bookmark: TuiBookmark): Promise<CachedLinkRecord> => {
      const apiKey = await getTypeSafeApiKey();
      if (!apiKey) {
        throw new Error("TypeSafe API key is missing; run `zen-bookmarks login` first");
      }
      return refreshTuiBookmark(
        bookmark,
        cache,
        createTypeSafeLinkClassifier(apiKey),
        fetchPublicLinkContent,
      );
    };

    root.render(
      <App
        initialEntries={initial.entries}
        warnings={initial.warnings}
        onRefresh={refresh}
        onReload={reload}
        onExit={close}
      />,
    );
  });
}
