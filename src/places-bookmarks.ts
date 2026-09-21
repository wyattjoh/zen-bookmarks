import { Database } from "bun:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT_LABELS = new Map([
  ["menu________", "Bookmarks Menu"],
  ["toolbar_____", "Bookmarks Toolbar"],
  ["unfiled_____", "Other Bookmarks"],
  ["mobile______", "Mobile Bookmarks"],
]);

const EXCLUDED_ROOTS = new Set(["root________", "tags________"]);

type PlacesFolderRow = {
  id: number;
  parent: number | null;
  position: number;
  title: string | null;
  guid: string;
};

type PlacesBookmarkRow = {
  id: number;
  parent: number;
  position: number;
  title: string | null;
  placeTitle: string | null;
  url: string;
  guid: string;
};

/**
 * One saved bookmark read from Zen's Firefox Places database.
 */
export type SavedBookmark = {
  id: string;
  title: string;
  url: string;
  folderPath: string[];
  position: number;
};

/**
 * One saved-bookmark folder, including empty folders.
 */
export type SavedBookmarkFolder = {
  id: string;
  name: string;
  parentId: string | undefined;
  folderPath: string[];
  position: number;
};

/**
 * Saved bookmark with its immediate folder identity.
 */
export type SavedBookmarkTreeBookmark = SavedBookmark & {
  folderId: string | undefined;
};

/**
 * Saved bookmarks and folders loaded from one Places snapshot.
 */
export type SavedBookmarkData = {
  folders: SavedBookmarkFolder[];
  bookmarks: SavedBookmarkTreeBookmark[];
};

/**
 * Resolve the Places database stored beside a Zen session file.
 *
 * @param sessionPath - Path to `zen-sessions.jsonlz4`
 * @returns Path to the matching profile's `places.sqlite`
 */
export function placesPathForSession(sessionPath: string): string {
  return join(dirname(sessionPath), "places.sqlite");
}

type OpenPlacesDatabase = {
  database: Database;
  close: () => void;
};

type FileSignature = {
  size: number;
  modifiedAt: number;
};

function fileSignature(path: string): FileSignature | undefined {
  try {
    const statistics = statSync(path);
    return { size: statistics.size, modifiedAt: statistics.mtimeMs };
  } catch {
    return undefined;
  }
}

function signaturesMatch(
  left: FileSignature | undefined,
  right: FileSignature | undefined,
): boolean {
  if (!left || !right) return left === right;
  return left.size === right.size && left.modifiedAt === right.modifiedAt;
}

function copyPlacesSnapshot(path: string): { directory: string; path: string } {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const directory = mkdtempSync(join(tmpdir(), "zen-bookmarks-places-"));
    const snapshotPath = join(directory, "places.sqlite");
    const walPath = `${path}-wal`;
    const beforeDatabase = fileSignature(path);
    const beforeWal = fileSignature(walPath);
    try {
      copyFileSync(path, snapshotPath);
      if (existsSync(walPath)) copyFileSync(walPath, `${snapshotPath}-wal`);
      const afterDatabase = fileSignature(path);
      const afterWal = fileSignature(walPath);
      if (
        signaturesMatch(beforeDatabase, afterDatabase) &&
        signaturesMatch(beforeWal, afterWal)
      ) {
        return { directory, path: snapshotPath };
      }
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      if (attempt === 2) throw error;
      continue;
    }
    rmSync(directory, { recursive: true, force: true });
  }
  throw new Error("Zen Places database changed repeatedly while creating a snapshot");
}

function openPlacesDatabase(path: string): OpenPlacesDatabase {
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true, strict: true });
    database.query("SELECT 1 FROM moz_bookmarks LIMIT 1").get();
    const openedDatabase = database;
    return { database: openedDatabase, close: () => openedDatabase.close() };
  } catch (error) {
    database?.close();
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes("locked")) throw error;
  }

  const snapshot = copyPlacesSnapshot(path);
  try {
    const snapshotDatabase = new Database(snapshot.path, { strict: true });
    snapshotDatabase.query("PRAGMA quick_check").get();
    return {
      database: snapshotDatabase,
      close() {
        snapshotDatabase.close();
        rmSync(snapshot.directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(snapshot.directory, { recursive: true, force: true });
    throw error;
  }
}

function folderPath(
  parentId: number,
  folders: Map<number, PlacesFolderRow>,
): string[] | undefined {
  const path: string[] = [];
  const visited = new Set<number>();
  let current = folders.get(parentId);

  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.guid === "tags________") return undefined;

    const rootLabel = ROOT_LABELS.get(current.guid);
    if (rootLabel) path.unshift(rootLabel);
    else if (!EXCLUDED_ROOTS.has(current.guid)) {
      path.unshift(current.title?.trim() || "(unnamed folder)");
    }

    current = current.parent === null ? undefined : folders.get(current.parent);
  }

  return path;
}

function folderName(folder: PlacesFolderRow): string {
  const name = ROOT_LABELS.get(folder.guid) ?? folder.title?.trim();
  return name || "(unnamed folder)";
}

/**
 * Read saved bookmarks and folders from a Zen profile's Firefox Places database.
 *
 * When Zen holds an exclusive SQLite lock, the reader copies the main database
 * and WAL into a validated temporary snapshot so recent changes remain visible
 * without interfering with the running browser.
 *
 * @param path - Path to `places.sqlite`
 * @returns Saved bookmarks and folders, excluding tag projections
 */
export function loadSavedBookmarkData(path: string): SavedBookmarkData {
  const opened = openPlacesDatabase(path);
  const { database } = opened;
  try {
    const folders = new Map(
      (
        database
          .query(
            `SELECT id, parent, position, title, guid
             FROM moz_bookmarks
             WHERE type = 2`,
          )
          .all() as PlacesFolderRow[]
      ).map((folder) => [folder.id, folder]),
    );
    const rows = database
      .query(
        `SELECT
           bookmark.id,
           bookmark.parent,
           bookmark.position,
           bookmark.title,
           bookmark.guid,
           place.title AS placeTitle,
           place.url
         FROM moz_bookmarks AS bookmark
         JOIN moz_places AS place ON place.id = bookmark.fk
         WHERE bookmark.type = 1
         ORDER BY bookmark.parent, bookmark.position`,
      )
      .all() as PlacesBookmarkRow[];

    const savedFolders = [...folders.values()].flatMap((folder) => {
      if (EXCLUDED_ROOTS.has(folder.guid) || folder.parent === null) return [];
      const path = folderPath(folder.parent, folders);
      if (!path) return [];
      const parent = folders.get(folder.parent);
      return [
        {
          id: folder.guid,
          name: folderName(folder),
          parentId:
            parent && !EXCLUDED_ROOTS.has(parent.guid) ? parent.guid : undefined,
          folderPath: path,
          position: folder.position,
        },
      ];
    });
    const savedFolderIds = new Set(savedFolders.map((folder) => folder.id));
    const bookmarks = rows.flatMap((row): SavedBookmarkTreeBookmark[] => {
      const path = folderPath(row.parent, folders);
      if (!path) return [];
      const parent = folders.get(row.parent);
      return [
        {
          id: row.guid || `places-${row.id}`,
          title: row.title?.trim() || row.placeTitle?.trim() || row.url,
          url: row.url,
          folderId:
            parent && savedFolderIds.has(parent.guid) ? parent.guid : undefined,
          folderPath: path,
          position: row.position,
        },
      ];
    });
    return { folders: savedFolders, bookmarks };
  } finally {
    opened.close();
  }
}

/**
 * Read saved bookmarks from a Zen profile's Firefox Places database.
 *
 * @param path - Path to `places.sqlite`
 * @returns Saved bookmarks in Places folder order, excluding tag projections
 */
export function loadSavedBookmarks(path: string): SavedBookmark[] {
  return loadSavedBookmarkData(path).bookmarks.map(({ folderId: _, ...bookmark }) =>
    bookmark,
  );
}
