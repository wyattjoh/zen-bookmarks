#!/usr/bin/env bun
/**
 * Extract Zen browser sidebar bookmarks (pinned tabs organized into folders and
 * workspaces) into portable JSON, YAML, and Netscape HTML formats.
 *
 * Zen stores the sidebar in `zen-sessions.jsonlz4` inside the active profile,
 * using Mozilla's mozLz4 container (magic "mozLz40\0" + uint32 LE size + a raw
 * LZ4 block). This tool decompresses that file, reconstructs the workspace ->
 * folder -> bookmark tree, and writes the three export files.
 *
 * Usage:
 *   bun extract-bookmarks.ts [--sessions <path>] [--out <dir>]
 */
import { writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readMozLz4Text } from "./mozlz4.ts";

/**
 * A single exported bookmark (one pinned tab).
 */
type Bookmark = {
  title: string;
  url: string;
  /**
   * Where the tab currently sits, when it has navigated away from the pinned
   * target. `undefined` when it matches the pinned URL.
   */
  currentUrl: string | undefined;
  /**
   * Tab strip index, used to preserve the user's ordering.
   */
  index: number;
};

/**
 * A folder node in the sidebar tree, containing nested folders and bookmarks.
 */
type Folder = {
  name: string;
  folders: Folder[];
  bookmarks: Bookmark[];
  /**
   * Zen folder id, retained internally for tree assembly.
   */
  id: string | undefined;
};

/**
 * A Zen workspace (top-level sidebar space) and its bookmark tree.
 */
type Workspace = {
  name: string;
  folders: Folder[];
  bookmarks: Bookmark[];
};

/**
 * Locate the active Zen `zen-sessions.jsonlz4` by scanning all profiles and
 * choosing the most recently modified one.
 *
 * @returns Absolute path to the session file
 */
function findSessionsFile(): string {
  const profilesDir = join(
    homedir(),
    "Library/Application Support/zen/Profiles",
  );
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
 * Parse the decompressed Zen session JSON into a list of workspaces, each
 * holding a nested folder/bookmark tree reconstructed from pinned tabs.
 *
 * @param session - The parsed `zen-sessions.json` object
 * @returns Workspaces in their on-screen order
 */
function buildWorkspaces(session: any): Workspace[] {
  const spaceName = new Map<string, string>();
  const workspaceOrder: string[] = [];
  for (const space of session.spaces ?? []) {
    spaceName.set(space.uuid, space.name ?? space.uuid);
    workspaceOrder.push(space.uuid);
  }

  // Build every folder node up front so children can be attached by id.
  const folderById = new Map<string, Folder & { parentId: string | undefined; workspaceId: string | undefined }>();
  for (const f of session.folders ?? []) {
    folderById.set(f.id, {
      name: f.name ?? "(unnamed)",
      folders: [],
      bookmarks: [],
      id: f.id,
      parentId: f.parentId ?? undefined,
      workspaceId: f.workspaceId ?? undefined,
    });
  }

  // Workspace roots collect top-level folders and top-level pinned bookmarks.
  const wsRoot = new Map<string, Workspace>();
  for (const uuid of workspaceOrder) {
    wsRoot.set(uuid, { name: spaceName.get(uuid) ?? uuid, folders: [], bookmarks: [] });
  }
  /**
   * Resolve (creating if needed) the workspace bucket for a uuid, tolerating
   * tabs/folders that reference a workspace missing from `spaces`.
   */
  const ensureWs = (uuid: string | undefined): Workspace => {
    const key = uuid ?? "(no workspace)";
    let ws = wsRoot.get(key);
    if (!ws) {
      ws = { name: spaceName.get(key) ?? key, folders: [], bookmarks: [] };
      wsRoot.set(key, ws);
      workspaceOrder.push(key);
    }
    return ws;
  };

  // Attach folders to their parent folder, or to the workspace root.
  for (const folder of folderById.values()) {
    if (folder.parentId && folderById.has(folder.parentId)) {
      folderById.get(folder.parentId)!.folders.push(folder);
    } else {
      ensureWs(folder.workspaceId).folders.push(folder);
    }
  }

  // Place each pinned bookmark into its folder (by groupId) or workspace root.
  for (const tab of session.tabs ?? []) {
    if (!tab.pinned || tab.zenIsEmpty) continue;
    const pinnedEntry = tab._zenPinnedInitialState?.entry;
    const current = tab.entries?.[tab.entries.length - 1];
    const url: string | undefined = pinnedEntry?.url ?? current?.url;
    if (!url || url === "about:blank") continue;
    const title: string = pinnedEntry?.title ?? current?.title ?? url;
    const currentUrl: string | undefined =
      current?.url && current.url !== url ? current.url : undefined;
    const bookmark: Bookmark = { title, url, currentUrl, index: tab.index ?? 0 };

    const folder = tab.groupId ? folderById.get(tab.groupId) : undefined;
    if (folder) folder.bookmarks.push(bookmark);
    else ensureWs(tab.zenWorkspace).bookmarks.push(bookmark);
  }

  // Order bookmarks by tab index; order folders by their earliest bookmark so
  // the tree reads top-to-bottom like the sidebar.
  const folderSortKey = (f: Folder): number => {
    let min = Infinity;
    for (const b of f.bookmarks) min = Math.min(min, b.index);
    for (const sub of f.folders) min = Math.min(min, folderSortKey(sub));
    return min;
  };
  const sortNode = (node: { folders: Folder[]; bookmarks: Bookmark[] }): void => {
    node.bookmarks.sort((a, b) => a.index - b.index);
    node.folders.sort((a, b) => folderSortKey(a) - folderSortKey(b));
    for (const sub of node.folders) sortNode(sub);
  };
  for (const ws of wsRoot.values()) sortNode(ws);

  return workspaceOrder.map((uuid) => wsRoot.get(uuid)!).filter(Boolean);
}

/**
 * Strip internal ids from the tree so the JSON/YAML output stays clean.
 */
function stripIds(folder: Folder): any {
  return {
    name: folder.name,
    folders: folder.folders.map(stripIds),
    bookmarks: folder.bookmarks.map((b) => ({
      title: b.title,
      url: b.url,
      ...(b.currentUrl ? { currentUrl: b.currentUrl } : {}),
    })),
  };
}

/**
 * Serialize the workspace tree as YAML without a third-party dependency.
 */
function toYaml(workspaces: Workspace[]): string {
  const lines: string[] = [];
  const esc = (s: string): string => {
    if (/[:#\-?\[\]{}&*!|>'"%@`]|^\s|\s$/.test(s) || s === "") {
      return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    }
    return s;
  };
  const emitBookmarks = (bms: Bookmark[], indent: string): void => {
    for (const b of bms) {
      lines.push(`${indent}- title: ${esc(b.title)}`);
      lines.push(`${indent}  url: ${esc(b.url)}`);
      if (b.currentUrl) lines.push(`${indent}  currentUrl: ${esc(b.currentUrl)}`);
    }
  };
  const emitFolders = (folders: Folder[], indent: string): void => {
    for (const f of folders) {
      lines.push(`${indent}- name: ${esc(f.name)}`);
      if (f.folders.length) {
        lines.push(`${indent}  folders:`);
        emitFolders(f.folders, `${indent}    `);
      }
      if (f.bookmarks.length) {
        lines.push(`${indent}  bookmarks:`);
        emitBookmarks(f.bookmarks, `${indent}    `);
      }
    }
  };
  for (const ws of workspaces) {
    lines.push(`- workspace: ${esc(ws.name)}`);
    if (ws.folders.length) {
      lines.push(`  folders:`);
      emitFolders(ws.folders, `    `);
    }
    if (ws.bookmarks.length) {
      lines.push(`  bookmarks:`);
      emitBookmarks(ws.bookmarks, `    `);
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Serialize the workspace tree as Netscape bookmark HTML, which re-imports into
 * any browser. Workspaces and folders both become `<H3>` folder headings.
 */
function toNetscapeHtml(workspaces: Workspace[]): string {
  const escHtml = (s: string): string =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const out: string[] = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file. It will be read and overwritten. -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  const emitFolder = (f: Folder, indent: string): void => {
    out.push(`${indent}<DT><H3>${escHtml(f.name)}</H3>`);
    out.push(`${indent}<DL><p>`);
    for (const sub of f.folders) emitFolder(sub, indent + "    ");
    for (const b of f.bookmarks) {
      out.push(`${indent}    <DT><A HREF="${escHtml(b.url)}">${escHtml(b.title)}</A>`);
    }
    out.push(`${indent}</DL><p>`);
  };
  for (const ws of workspaces) {
    out.push(`    <DT><H3>${escHtml(ws.name)}</H3>`);
    out.push(`    <DL><p>`);
    for (const f of ws.folders) emitFolder(f, "        ");
    for (const b of ws.bookmarks) {
      out.push(`        <DT><A HREF="${escHtml(b.url)}">${escHtml(b.title)}</A>`);
    }
    out.push(`    </DL><p>`);
  }
  out.push("</DL><p>");
  return out.join("\n") + "\n";
}

/**
 * Count bookmarks in a workspace tree, for the run summary.
 */
function countBookmarks(ws: Workspace): number {
  const inFolder = (f: Folder): number =>
    f.bookmarks.length + f.folders.reduce((n, s) => n + inFolder(s), 0);
  return ws.bookmarks.length + ws.folders.reduce((n, f) => n + inFolder(f), 0);
}

function main(): void {
  const argv = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sessionsPath = getArg("--sessions") ?? findSessionsFile();
  const outDir = getArg("--out") ?? process.cwd();

  const session = JSON.parse(readMozLz4Text(sessionsPath));
  const workspaces = buildWorkspaces(session);
  const clean = workspaces.map((ws) => ({
    workspace: ws.name,
    folders: ws.folders.map(stripIds),
    bookmarks: ws.bookmarks.map((b) => ({
      title: b.title,
      url: b.url,
      ...(b.currentUrl ? { currentUrl: b.currentUrl } : {}),
    })),
  }));

  writeFileSync(join(outDir, "bookmarks.json"), JSON.stringify(clean, null, 2) + "\n");
  writeFileSync(join(outDir, "bookmarks.yaml"), toYaml(workspaces));
  writeFileSync(join(outDir, "bookmarks.html"), toNetscapeHtml(workspaces));

  console.log(`Source: ${sessionsPath}`);
  console.log(`Output: ${outDir}`);
  for (const ws of workspaces) {
    console.log(`  ${ws.name}: ${countBookmarks(ws)} bookmarks`);
  }
  const total = workspaces.reduce((n, ws) => n + countBookmarks(ws), 0);
  console.log(`  Total: ${total} bookmarks across ${workspaces.length} workspaces`);
  console.log("Wrote bookmarks.json, bookmarks.yaml, bookmarks.html");
}

main();
