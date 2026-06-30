#!/usr/bin/env bun
/**
 * Programmatically modify Zen browser sidebar bookmarks (pinned tabs organized
 * into folders and workspaces) by editing `zen-sessions.jsonlz4` offline.
 *
 * Safety model:
 *   - Mutations write a PREVIEW file by default and never touch Zen's data.
 *   - `--apply` replaces Zen's session file, but first refuses to run while Zen
 *     is open (Zen overwrites the file on its own save timer and on shutdown,
 *     so edits made while it runs are lost) and backs up the original.
 *   - Writes are atomic (temp file + rename).
 *
 * Commands:
 *   list                          Print the current workspace/folder/bookmark tree.
 *   verify                        Decompress + recompress the live file and confirm the
 *                                 round-trip is lossless. Touches nothing.
 *   add --url <u> [opts]          Add a pinned-tab bookmark.
 *   remove --url <u> [opts]       Remove pinned-tab bookmark(s) matching a URL.
 *
 * Common options:
 *   --workspace <name>            Target workspace (default: first space).
 *   --folder <name>               Target folder by name within the workspace
 *                                 (default: top level of the workspace).
 *   --title <text>                Bookmark title (add only; defaults to the URL).
 *   --sessions <path>             Override the session file (default: auto-detect).
 *   --out <path>                  Preview output path (default: ./zen-sessions.preview.jsonlz4).
 *   --apply                       Replace Zen's real session file (requires Zen closed).
 */
import { readFileSync, readdirSync, statSync, copyFileSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readMozLz4Text, compressMozLz4Text, decompressMozLz4Buffer } from "./mozlz4.ts";

/**
 * Minimal shape of the decompressed Zen session document. Only the fields this
 * tool reasons about are typed; everything else is preserved verbatim.
 */
type Session = {
  spaces: Array<{ uuid: string; name: string }>;
  folders: Array<{ id: string; name: string; parentId: string | null; workspaceId: string }>;
  groups: Array<{ id: string; name: string }>;
  tabs: any[];
  [key: string]: unknown;
};

/**
 * Parsed command-line options.
 */
type Options = {
  command: string;
  url: string | undefined;
  title: string | undefined;
  workspace: string | undefined;
  folder: string | undefined;
  file: string | undefined;
  sessions: string | undefined;
  out: string;
  apply: boolean;
};

/**
 * Locate the active Zen `zen-sessions.jsonlz4` by choosing the most recently
 * modified one across all profiles.
 *
 * @returns Absolute path to the session file
 */
function findSessionsFile(): string {
  const profilesDir = join(homedir(), "Library/Application Support/zen/Profiles");
  let best: { path: string; mtime: number } | undefined;
  for (const entry of readdirSync(profilesDir)) {
    const candidate = join(profilesDir, entry, "zen-sessions.jsonlz4");
    try {
      const mtime = statSync(candidate).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: candidate, mtime };
    } catch {
      // No session file in this profile; skip.
    }
  }
  if (!best) throw new Error(`No zen-sessions.jsonlz4 found under ${profilesDir}`);
  return best.path;
}

/**
 * Return true when a Zen browser process is currently running.
 *
 * @returns Whether Zen appears to be open
 */
function isZenRunning(): boolean {
  try {
    const out = execFileSync("pgrep", ["-f", "Zen.app/Contents/MacOS"], {
      encoding: "utf8",
    });
    return out.trim().length > 0;
  } catch {
    // pgrep exits non-zero when there is no match.
    return false;
  }
}

/**
 * Parse argv into a normalized options object.
 *
 * @param argv - Arguments after the script name
 * @returns The parsed options
 */
function parseArgs(argv: string[]): Options {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    command: argv[0] ?? "",
    url: get("--url"),
    title: get("--title"),
    workspace: get("--workspace"),
    folder: get("--folder"),
    file: get("--file"),
    sessions: get("--sessions"),
    out: get("--out") ?? join(process.cwd(), "zen-sessions.preview.jsonlz4"),
    apply: argv.includes("--apply"),
  };
}

/**
 * Resolve the target workspace uuid by name, defaulting to the first space.
 *
 * @param session - The session document
 * @param name - Workspace name, or undefined for the default
 * @returns The workspace uuid and resolved name
 */
function resolveWorkspace(session: Session, name: string | undefined): { uuid: string; name: string } {
  if (!session.spaces?.length) throw new Error("Session has no workspaces");
  if (!name) return { uuid: session.spaces[0].uuid, name: session.spaces[0].name };
  const match = session.spaces.find((s) => s.name === name);
  if (!match) {
    const names = session.spaces.map((s) => s.name).join(", ");
    throw new Error(`Workspace "${name}" not found. Available: ${names}`);
  }
  return { uuid: match.uuid, name: match.name };
}

/**
 * Resolve a folder id by name within a workspace, erroring on ambiguity.
 *
 * @param session - The session document
 * @param workspaceUuid - The workspace to search within
 * @param name - Folder name, or undefined for the workspace top level
 * @returns The folder id, or undefined for the top level
 */
function resolveFolderId(
  session: Session,
  workspaceUuid: string,
  name: string | undefined,
): string | undefined {
  if (!name) return undefined;
  const matches = (session.folders ?? []).filter(
    (f) => f.name === name && f.workspaceId === workspaceUuid,
  );
  if (matches.length === 0) throw new Error(`Folder "${name}" not found in that workspace`);
  if (matches.length > 1) {
    throw new Error(
      `Folder "${name}" is ambiguous (${matches.length} matches in that workspace). ` +
        `Folder targeting by name cannot disambiguate nested duplicates yet.`,
    );
  }
  return matches[0].id;
}

/**
 * Serialize a content principal for a URL in the JSON form Zen stores in
 * session entries (principal type tag "1" = content principal). This is the
 * field most likely to need adjustment if a restored bookmark misbehaves.
 *
 * @param url - The bookmark URL
 * @returns The serialized triggering principal string
 */
function contentPrincipal(url: string): string {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // Leave the raw URL if it does not parse as an absolute URL.
  }
  return JSON.stringify({ "1": { "0": origin } });
}

/**
 * Generate a Zen sync id (`<timestamp>-<n>`) that is unique within the session.
 *
 * @param session - The session document
 * @returns A fresh unique sync id
 */
function freshSyncId(session: Session): string {
  const used = new Set<string>();
  for (const t of session.tabs ?? []) if (t.zenSyncId) used.add(t.zenSyncId);
  const stamp = Date.now();
  let n = 1;
  let id = `${stamp}-${n}`;
  while (used.has(id)) {
    n += 1;
    id = `${stamp}-${n}`;
  }
  return id;
}

/**
 * Add a pinned-tab bookmark to the session document.
 *
 * @param session - The session document (mutated in place)
 * @param opts - Parsed options containing url/title/workspace/folder
 * @returns A human-readable description of what was added
 */
function addBookmark(session: Session, opts: Options): string {
  if (!opts.url) throw new Error("add requires --url");
  const ws = resolveWorkspace(session, opts.workspace);
  const groupId = resolveFolderId(session, ws.uuid, opts.folder);
  const title = opts.title ?? opts.url;
  const maxIndex = (session.tabs ?? []).reduce((m, t) => Math.max(m, t.index ?? 0), 0);

  const tab = {
    entries: [
      {
        url: opts.url,
        title,
        triggeringPrincipal_base64: contentPrincipal(opts.url),
        hasUserInteraction: false,
      },
    ],
    lastAccessed: Date.now(),
    pinned: true,
    hidden: false,
    zenWorkspace: ws.uuid,
    zenSyncId: freshSyncId(session),
    zenEssential: false,
    zenDefaultUserContextId: "true",
    zenPinnedIcon: null,
    zenIsEmpty: false,
    zenHasStaticIcon: false,
    zenGlanceId: null,
    zenIsGlance: false,
    _zenPinnedInitialState: { entry: { url: opts.url, title } },
    zenLiveFolderItemId: null,
    searchMode: null,
    userContextId: 0,
    attributes: {},
    index: maxIndex + 1,
    userTypedValue: "",
    userTypedClear: 0,
    ...(groupId ? { groupId } : {}),
  };
  session.tabs.push(tab);

  const where = opts.folder ? `folder "${opts.folder}"` : "top level";
  return `Added "${title}" (${opts.url}) to ${where} of workspace "${ws.name}"`;
}

/**
 * Remove pinned-tab bookmark(s) whose pinned target or current URL matches.
 *
 * @param session - The session document (mutated in place)
 * @param opts - Parsed options containing the url (and optional workspace/folder)
 * @returns A human-readable description of what was removed
 */
function removeBookmark(session: Session, opts: Options): string {
  if (!opts.url) throw new Error("remove requires --url");
  const wsUuid = opts.workspace ? resolveWorkspace(session, opts.workspace).uuid : undefined;
  const groupId = wsUuid ? resolveFolderId(session, wsUuid, opts.folder) : undefined;

  const before = session.tabs.length;
  session.tabs = session.tabs.filter((t) => {
    if (!t.pinned) return true;
    const pinnedUrl = t._zenPinnedInitialState?.entry?.url;
    const curUrl = t.entries?.[t.entries.length - 1]?.url;
    const urlMatch = pinnedUrl === opts.url || curUrl === opts.url;
    if (!urlMatch) return true;
    if (wsUuid && t.zenWorkspace !== wsUuid) return true;
    if (opts.folder && t.groupId !== groupId) return true;
    return false;
  });
  const removed = before - session.tabs.length;
  if (removed === 0) throw new Error(`No pinned bookmark matched ${opts.url}`);
  return `Removed ${removed} bookmark(s) matching ${opts.url}`;
}

/**
 * A node in a parsed Netscape bookmark file: either a folder with children or a
 * leaf bookmark.
 */
type HtmlNode =
  | { type: "folder"; name: string; children: HtmlNode[] }
  | { type: "bookmark"; title: string; url: string };

/**
 * Decode the small set of HTML entities Netscape bookmark exports use.
 *
 * @param s - Raw text from an HTML attribute or element body
 * @returns The decoded text
 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Parse a Netscape bookmark HTML document into a nested node tree. Relies on the
 * one-element-per-line layout that browsers (and our exporter) emit.
 *
 * @param html - The HTML file contents
 * @returns The top-level nodes (children of the implicit root)
 */
function parseNetscape(html: string): HtmlNode[] {
  const rootChildren: HtmlNode[] = [];
  const stack: HtmlNode[][] = [rootChildren];
  let pendingFolder: HtmlNode | undefined;
  for (const line of html.split("\n")) {
    const h3 = line.match(/<H3[^>]*>(.*?)<\/H3>/i);
    const a = line.match(/<A\s+HREF="([^"]*)"[^>]*>(.*?)<\/A>/i);
    if (h3) {
      const folder: HtmlNode = { type: "folder", name: decodeEntities(h3[1]), children: [] };
      stack[stack.length - 1].push(folder);
      pendingFolder = folder;
    } else if (a) {
      stack[stack.length - 1].push({ type: "bookmark", title: decodeEntities(a[2]), url: a[1] });
    }
    if (/<DL>/i.test(line) && pendingFolder && pendingFolder.type === "folder") {
      stack.push(pendingFolder.children);
      pendingFolder = undefined;
    }
    if (/<\/DL>/i.test(line)) stack.pop();
  }
  return rootChildren;
}

/**
 * Rebuild a workspace's entire pinned-tab sidebar (folders, nesting, and order)
 * from a Netscape bookmark file. Existing pinned tabs are reused by URL so their
 * favicons, history, and sync ids are preserved; any pinned tab in the target
 * workspace that the file does not reference is dropped. Other workspaces and
 * all non-pinned tabs are left untouched.
 *
 * @param session - The session document (mutated in place)
 * @param opts - Parsed options containing the file path and target workspace
 * @returns A human-readable description of the rebuild
 */
function importHtml(session: Session, opts: Options): string {
  if (!opts.file) throw new Error("import-html requires --file <bookmarks.html>");
  const ws = resolveWorkspace(session, opts.workspace);
  const parsed = parseNetscape(readFileSync(opts.file, "utf8"));
  // Descend through a single wrapping toolbar folder (e.g. "Bookmarks Bar").
  const top =
    parsed.length === 1 && parsed[0].type === "folder" ? parsed[0].children : parsed;

  // Pool of existing pinned bookmarks in this workspace, keyed by pinned URL, so
  // we can reuse a real tab (with its favicon/history) per HTML entry.
  const pool = new Map<string, any[]>();
  for (const t of session.tabs) {
    if (!t.pinned || t.zenIsEmpty || t.zenWorkspace !== ws.uuid) continue;
    const url = t._zenPinnedInitialState?.entry?.url ?? t.entries?.[t.entries.length - 1]?.url;
    if (!url) continue;
    if (!pool.has(url)) pool.set(url, []);
    pool.get(url)!.push(t);
  }

  // Unique id generator for new folders and empty placeholder tabs.
  const usedIds = new Set<string>();
  for (const f of session.folders) usedIds.add(f.id);
  for (const t of session.tabs) if (t.zenSyncId) usedIds.add(t.zenSyncId);
  const base = Date.now();
  let counter = 0;
  const newId = (): string => {
    let id = `${base}-${++counter}`;
    while (usedIds.has(id)) id = `${base}-${++counter}`;
    usedIds.add(id);
    return id;
  };

  const newFolders: any[] = [];
  const newGroups: any[] = [];
  const orderedTabs: any[] = [];
  const stats = { reused: 0, fresh: 0 };

  const makeEmptyTab = (groupId: string): string => {
    const syncId = newId();
    orderedTabs.push({
      entries: [{ url: "about:blank", triggeringPrincipal_base64: '{"3":{}}' }],
      lastAccessed: base,
      pinned: true,
      hidden: false,
      groupId,
      zenWorkspace: ws.uuid,
      zenSyncId: syncId,
      zenEssential: false,
      zenDefaultUserContextId: null,
      zenPinnedIcon: null,
      zenIsEmpty: true,
      zenHasStaticIcon: false,
      zenGlanceId: null,
      zenIsGlance: false,
      _zenPinnedInitialState: { entry: { url: "about:blank" }, image: null },
      zenLiveFolderItemId: null,
      searchMode: null,
      userContextId: 0,
      attributes: {},
      index: 1,
      userTypedValue: "",
      userTypedClear: 0,
      image: null,
    });
    return syncId;
  };

  const placeBookmark = (node: { title: string; url: string }, groupId: string | undefined): string => {
    const existing = pool.get(node.url);
    let tab: any;
    if (existing && existing.length) {
      tab = existing.shift();
      stats.reused += 1;
    } else {
      tab = {
        entries: [
          {
            url: node.url,
            title: node.title,
            triggeringPrincipal_base64: contentPrincipal(node.url),
            hasUserInteraction: false,
          },
        ],
        lastAccessed: base,
        pinned: true,
        hidden: false,
        zenWorkspace: ws.uuid,
        zenSyncId: newId(),
        zenEssential: false,
        zenDefaultUserContextId: "true",
        zenPinnedIcon: null,
        zenIsEmpty: false,
        zenHasStaticIcon: false,
        zenGlanceId: null,
        zenIsGlance: false,
        _zenPinnedInitialState: { entry: { url: node.url, title: node.title } },
        zenLiveFolderItemId: null,
        searchMode: null,
        userContextId: 0,
        attributes: {},
        index: 1,
        userTypedValue: "",
        userTypedClear: 0,
      };
      stats.fresh += 1;
    }
    tab.zenWorkspace = ws.uuid;
    if (groupId) tab.groupId = groupId;
    else delete tab.groupId;
    orderedTabs.push(tab);
    return tab.zenSyncId;
  };

  /**
   * Emit a container's children in order, recording folder sibling links. The
   * `prev` reference is what Zen restores a nested folder after; `{type:"start"}`
   * makes it the first item in its parent.
   */
  const emitChildren = (
    children: HtmlNode[],
    parentId: string | null,
    anchorPrev: { type: string; id: string | null },
  ): void => {
    let prev = anchorPrev;
    for (const child of children) {
      if (child.type === "bookmark") {
        const syncId = placeBookmark(child, parentId ?? undefined);
        prev = { type: "tab", id: syncId };
        continue;
      }
      const fid = newId();
      newFolders.push({
        pinned: true,
        splitViewGroup: false,
        id: fid,
        name: child.name,
        collapsed: false,
        saveOnWindowClose: true,
        parentId: parentId,
        prevSiblingInfo: prev,
        emptyTabIds: [] as string[],
        userIcon: "",
        workspaceId: ws.uuid,
      });
      newGroups.push({
        pinned: true,
        splitView: false,
        id: fid,
        name: child.name,
        color: "zen-workspace-color",
        collapsed: false,
        saveOnWindowClose: true,
      });
      const emptySyncId = makeEmptyTab(fid);
      newFolders[newFolders.length - 1].emptyTabIds = [emptySyncId];
      emitChildren(child.children, fid, { type: "start", id: null });
      prev = { type: "group", id: fid };
    }
  };

  emitChildren(top, null, { type: "start", id: null });

  const dropped = [...pool.values()].reduce((n, arr) => n + arr.length, 0);

  // Reassemble: new workspace block first, then every tab/folder/group that does
  // not belong to this workspace's pinned set, untouched.
  const keepTabs = session.tabs.filter((t) => !(t.pinned && t.zenWorkspace === ws.uuid));
  session.tabs = [...orderedTabs, ...keepTabs];
  const keptFolderIds = new Set(
    session.folders.filter((f) => f.workspaceId !== ws.uuid).map((f) => f.id),
  );
  session.folders = [...newFolders, ...session.folders.filter((f) => f.workspaceId !== ws.uuid)];
  session.groups = [...newGroups, ...session.groups.filter((g) => keptFolderIds.has(g.id))];

  return (
    `Rebuilt workspace "${ws.name}" from ${opts.file}:\n` +
    `  ${newFolders.length} folders, ${stats.reused} bookmarks reused, ${stats.fresh} created fresh, ${dropped} dropped`
  );
}

/**
 * Print the current workspace/folder/bookmark tree for inspection.
 *
 * @param session - The session document
 */
function listTree(session: Session): void {
  const spaceName = new Map(session.spaces.map((s) => [s.uuid, s.name]));
  const childFolders = (parentId: string | null, wsUuid: string) =>
    session.folders.filter((f) => (f.parentId ?? null) === parentId && f.workspaceId === wsUuid);
  const bookmarksIn = (groupId: string | undefined, wsUuid: string) =>
    session.tabs
      .filter((t) => t.pinned && !t.zenIsEmpty && t.zenWorkspace === wsUuid && (t.groupId ?? undefined) === groupId)
      .map((t) => t._zenPinnedInitialState?.entry?.title ?? t.entries?.[t.entries.length - 1]?.title ?? "(untitled)")
      .filter((title) => title !== "" && title !== undefined);

  const printFolder = (id: string, name: string, wsUuid: string, depth: number) => {
    console.log(`${"  ".repeat(depth)}[${name}]`);
    for (const f of childFolders(id, wsUuid)) printFolder(f.id, f.name, wsUuid, depth + 1);
    for (const t of bookmarksIn(id, wsUuid)) console.log(`${"  ".repeat(depth + 1)}- ${t}`);
  };

  for (const space of session.spaces) {
    console.log(`\n=== Workspace: ${space.name} ===`);
    for (const f of childFolders(null, space.uuid)) printFolder(f.id, f.name, space.uuid, 1);
    for (const t of bookmarksIn(undefined, space.uuid)) console.log(`  - ${t}`);
  }
  console.log("");
}

/**
 * Run a lossless round-trip check on the live session file: decompress, parse,
 * re-serialize, recompress, decompress again, and confirm the parsed data is
 * unchanged. Proves the read/write pipeline preserves data before any mutation.
 *
 * @param sessionsPath - Path to the live session file
 */
function verify(sessionsPath: string): void {
  const parsed = JSON.parse(readMozLz4Text(sessionsPath));
  const reText = JSON.stringify(parsed);
  const buf = compressMozLz4Text(reText);
  const roundTripText = Buffer.from(decompressMozLz4Buffer(buf)).toString("utf8");
  const ok = roundTripText === reText;
  const pinned = (parsed.tabs ?? []).filter((t: any) => t.pinned && !t.zenIsEmpty).length;
  console.log(`Source: ${sessionsPath}`);
  console.log(`Tabs: ${parsed.tabs?.length ?? 0}, pinned bookmarks: ${pinned}, workspaces: ${parsed.spaces?.length ?? 0}`);
  console.log(`Round-trip lossless: ${ok ? "YES" : "NO"}`);
  if (!ok) throw new Error("Round-trip mismatch; do not apply changes");
}

/**
 * Write the mutated session either to a preview file or, with --apply, to Zen's
 * real session file (guarded and backed up).
 *
 * @param session - The mutated session document
 * @param sessionsPath - Path to the live session file
 * @param opts - Parsed options (apply flag and preview out path)
 */
function writeResult(session: Session, sessionsPath: string, opts: Options): void {
  const text = JSON.stringify(session);
  const buf = compressMozLz4Text(text);

  if (!opts.apply) {
    writeFileSync(opts.out, buf);
    console.log(`\nPreview written (Zen NOT modified): ${opts.out}`);
    console.log("Re-run with --apply (and Zen fully quit) to write it for real.");
    return;
  }

  if (isZenRunning()) {
    throw new Error(
      "Zen is running. Quit Zen completely before applying, or it will overwrite your change.",
    );
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${sessionsPath}.bak-${stamp}`;
  copyFileSync(sessionsPath, backup);
  const tmp = `${sessionsPath}.tmp-${process.pid}`;
  writeFileSync(tmp, buf);
  renameSync(tmp, sessionsPath);
  console.log(`\nApplied to: ${sessionsPath}`);
  console.log(`Backup saved: ${backup}`);
  console.log("Launch Zen to see the change.");
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const sessionsPath = opts.sessions ?? findSessionsFile();

  if (opts.command === "verify") {
    verify(sessionsPath);
    return;
  }

  const session: Session = JSON.parse(readMozLz4Text(sessionsPath));

  if (opts.command === "list") {
    listTree(session);
    return;
  }

  let summary: string;
  if (opts.command === "add") summary = addBookmark(session, opts);
  else if (opts.command === "remove") summary = removeBookmark(session, opts);
  else if (opts.command === "import-html") summary = importHtml(session, opts);
  else {
    console.error(
      "Usage: bun update-bookmarks.ts <list|verify|add|remove|import-html> [--url <u>] [--title <t>] " +
        "[--workspace <w>] [--folder <f>] [--file <html>] [--out <path>] [--apply]",
    );
    process.exit(1);
    return;
  }

  console.log(summary);
  writeResult(session, sessionsPath, opts);
}

main();
