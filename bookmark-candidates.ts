import type {
  SidebarBookmark,
  SidebarFolder,
  SidebarTree,
  SidebarWorkspace,
} from "./sidebar.ts";

/**
 * A pinned bookmark with the human-readable sidebar location that contains it.
 */
export type BookmarkCandidate = {
  bookmark: SidebarBookmark;
  workspaceName: string;
  folderPath: string[];
};

function folderCandidates(
  folder: SidebarFolder,
  workspaceName: string,
  parentPath: string[],
): BookmarkCandidate[] {
  const folderPath = [...parentPath, folder.name];
  return [
    ...folder.bookmarks.map((bookmark) => ({ bookmark, workspaceName, folderPath })),
    ...folder.folders.flatMap((child) => folderCandidates(child, workspaceName, folderPath)),
  ];
}

function workspaceCandidates(workspace: SidebarWorkspace): BookmarkCandidate[] {
  return [
    ...workspace.bookmarks.map((bookmark) => ({
      bookmark,
      workspaceName: workspace.name,
      folderPath: [],
    })),
    ...workspace.folders.flatMap((folder) => folderCandidates(folder, workspace.name, [])),
  ];
}

/**
 * Flatten a normalized sidebar tree into searchable bookmark candidates.
 *
 * @param tree - Normalized Zen sidebar tree
 * @returns Pinned bookmarks annotated with workspace and folder names
 */
export function sidebarBookmarkCandidates(tree: SidebarTree): BookmarkCandidate[] {
  return tree.workspaces.flatMap(workspaceCandidates);
}
