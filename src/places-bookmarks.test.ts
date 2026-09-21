import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSavedBookmarkData,
  loadSavedBookmarks,
  placesPathForSession,
} from "./places-bookmarks.ts";

const temporaryDirectories: string[] = [];

function placesFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "zen-bookmarks-places-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "places.sqlite");
  const database = new Database(path, { create: true });
  database.exec(`
    CREATE TABLE moz_places (
      id INTEGER PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT
    );
    CREATE TABLE moz_bookmarks (
      id INTEGER PRIMARY KEY,
      type INTEGER,
      fk INTEGER,
      parent INTEGER,
      position INTEGER,
      title TEXT,
      guid TEXT
    );
    INSERT INTO moz_bookmarks VALUES
      (1, 2, NULL, NULL, 0, '', 'root________'),
      (2, 2, NULL, 1, 0, 'menu', 'menu________'),
      (3, 2, NULL, 2, 0, 'Reference', 'folder-guid'),
      (4, 2, NULL, 1, 1, 'tags', 'tags________'),
      (5, 1, 10, 3, 0, NULL, 'saved-guid'),
      (6, 1, 10, 4, 0, 'Tag projection', 'tag-guid'),
      (8, 2, NULL, 2, 1, 'Empty Folder', 'empty-folder-guid');
    INSERT INTO moz_places VALUES
      (10, 'https://example.com/docs', 'Example Docs');
  `);
  database.close();
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Places bookmarks", () => {
  test("resolves places.sqlite beside the session file", () => {
    expect(placesPathForSession("/profile/zen-sessions.jsonlz4")).toBe(
      "/profile/places.sqlite",
    );
  });

  test("loads saved bookmark folders and excludes tag projections", () => {
    expect(loadSavedBookmarks(placesFixture())).toEqual([
      {
        id: "saved-guid",
        title: "Example Docs",
        url: "https://example.com/docs",
        folderPath: ["Bookmarks Menu", "Reference"],
        position: 0,
      },
    ]);
  });

  test("loads nested and empty saved-bookmark folders", () => {
    expect(loadSavedBookmarkData(placesFixture()).folders).toEqual([
      {
        id: "menu________",
        name: "Bookmarks Menu",
        parentId: undefined,
        folderPath: [],
        position: 0,
      },
      {
        id: "folder-guid",
        name: "Reference",
        parentId: "menu________",
        folderPath: ["Bookmarks Menu"],
        position: 0,
      },
      {
        id: "empty-folder-guid",
        name: "Empty Folder",
        parentId: "menu________",
        folderPath: ["Bookmarks Menu"],
        position: 1,
      },
    ]);
  });

  test("reads committed WAL changes while the live database is locked", () => {
    const path = placesFixture();
    const zenDatabase = new Database(path);
    zenDatabase.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      INSERT INTO moz_places VALUES
        (11, 'https://example.com/new', 'New Bookmark');
      INSERT INTO moz_bookmarks VALUES
        (7, 1, 11, 3, 1, NULL, 'new-guid');
      PRAGMA locking_mode = EXCLUSIVE;
      BEGIN EXCLUSIVE;
    `);

    try {
      expect(loadSavedBookmarks(path).map((bookmark) => bookmark.id)).toEqual([
        "saved-guid",
        "new-guid",
      ]);
    } finally {
      zenDatabase.exec("ROLLBACK");
      zenDatabase.close();
    }
  });
});
