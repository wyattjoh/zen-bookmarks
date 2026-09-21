import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSidebarTree,
  type SidebarBookmark,
  type SidebarFolder,
  type SidebarTree,
  type ZenSession,
} from "./sidebar.ts";

/**
 * Portable export result paths and counts.
 */
export type ExportResult = {
  jsonPath: string;
  yamlPath: string;
  htmlPath: string;
  bookmarkCount: number;
  workspaceCount: number;
};

function portableBookmark(bookmark: SidebarBookmark): Record<string, unknown> {
  return {
    title: bookmark.title,
    url: bookmark.url,
    ...(bookmark.currentUrl ? { currentUrl: bookmark.currentUrl } : {}),
  };
}

function portableFolder(folder: SidebarFolder): Record<string, unknown> {
  return {
    name: folder.name,
    folders: folder.folders.map(portableFolder),
    bookmarks: folder.bookmarks.map(portableBookmark),
  };
}

/**
 * Convert a normalized tree into the project's portable JSON representation.
 *
 * @param tree - Normalized sidebar tree
 * @returns JSON-compatible workspace records
 */
export function toPortableJson(tree: SidebarTree): Record<string, unknown>[] {
  return tree.workspaces.map((workspace) => ({
    workspace: workspace.name,
    folders: workspace.folders.map(portableFolder),
    bookmarks: workspace.bookmarks.map(portableBookmark),
  }));
}

function yamlEscape(value: string): string {
  if (/[:#\-?\[\]{}&*!|>'"%@`]|^\s|\s$/.test(value) || value === "") {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * Serialize a normalized tree as dependency-free YAML.
 *
 * @param tree - Normalized sidebar tree
 * @returns YAML text
 */
export function toYaml(tree: SidebarTree): string {
  const lines: string[] = [];
  const emitBookmarks = (bookmarks: SidebarBookmark[], indent: string): void => {
    for (const bookmark of bookmarks) {
      lines.push(`${indent}- title: ${yamlEscape(bookmark.title)}`);
      lines.push(`${indent}  url: ${yamlEscape(bookmark.url)}`);
      if (bookmark.currentUrl) {
        lines.push(`${indent}  currentUrl: ${yamlEscape(bookmark.currentUrl)}`);
      }
    }
  };
  const emitFolders = (folders: SidebarFolder[], indent: string): void => {
    for (const folder of folders) {
      lines.push(`${indent}- name: ${yamlEscape(folder.name)}`);
      if (folder.folders.length > 0) {
        lines.push(`${indent}  folders:`);
        emitFolders(folder.folders, `${indent}    `);
      }
      if (folder.bookmarks.length > 0) {
        lines.push(`${indent}  bookmarks:`);
        emitBookmarks(folder.bookmarks, `${indent}    `);
      }
    }
  };
  for (const workspace of tree.workspaces) {
    lines.push(`- workspace: ${yamlEscape(workspace.name)}`);
    if (workspace.folders.length > 0) {
      lines.push("  folders:");
      emitFolders(workspace.folders, "    ");
    }
    if (workspace.bookmarks.length > 0) {
      lines.push("  bookmarks:");
      emitBookmarks(workspace.bookmarks, "    ");
    }
  }
  return `${lines.join("\n")}\n`;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Serialize a normalized tree as Netscape bookmark HTML.
 *
 * @param tree - Normalized sidebar tree
 * @returns Netscape bookmark HTML
 */
export function toNetscapeHtml(tree: SidebarTree): string {
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    "<!-- This is an automatically generated file. It will be read and overwritten. -->",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  const emitFolder = (folder: SidebarFolder, indent: string): void => {
    lines.push(`${indent}<DT><H3>${htmlEscape(folder.name)}</H3>`);
    lines.push(`${indent}<DL><p>`);
    for (const child of folder.folders) emitFolder(child, `${indent}    `);
    for (const bookmark of folder.bookmarks) {
      lines.push(
        `${indent}    <DT><A HREF="${htmlEscape(bookmark.url)}">${htmlEscape(bookmark.title)}</A>`,
      );
    }
    lines.push(`${indent}</DL><p>`);
  };
  for (const workspace of tree.workspaces) {
    lines.push(`    <DT><H3>${htmlEscape(workspace.name)}</H3>`);
    lines.push("    <DL><p>");
    for (const folder of workspace.folders) emitFolder(folder, "        ");
    for (const bookmark of workspace.bookmarks) {
      lines.push(
        `        <DT><A HREF="${htmlEscape(bookmark.url)}">${htmlEscape(bookmark.title)}</A>`,
      );
    }
    lines.push("    </DL><p>");
  }
  lines.push("</DL><p>");
  return `${lines.join("\n")}\n`;
}

function countFolder(folder: SidebarFolder): number {
  return (
    folder.bookmarks.length +
    folder.folders.reduce((count, child) => count + countFolder(child), 0)
  );
}

/**
 * Write JSON, YAML, and Netscape HTML exports for a Zen session.
 *
 * @param session - Zen session
 * @param outputDirectory - Existing output directory
 * @returns Paths and aggregate counts
 */
export function writeExports(session: ZenSession, outputDirectory: string): ExportResult {
  const tree = buildSidebarTree(session);
  const jsonPath = join(outputDirectory, "bookmarks.json");
  const yamlPath = join(outputDirectory, "bookmarks.yaml");
  const htmlPath = join(outputDirectory, "bookmarks.html");
  writeFileSync(jsonPath, `${JSON.stringify(toPortableJson(tree), null, 2)}\n`);
  writeFileSync(yamlPath, toYaml(tree));
  writeFileSync(htmlPath, toNetscapeHtml(tree));
  const bookmarkCount = tree.workspaces.reduce(
    (count, workspace) =>
      count +
      workspace.bookmarks.length +
      workspace.folders.reduce((folderCount, folder) => folderCount + countFolder(folder), 0),
    0,
  );
  return {
    jsonPath,
    yamlPath,
    htmlPath,
    bookmarkCount,
    workspaceCount: tree.workspaces.length,
  };
}
