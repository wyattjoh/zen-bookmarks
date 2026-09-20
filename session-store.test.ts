import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressMozLz4Text, decompressMozLz4Buffer } from "./mozlz4.ts";
import { addWorkspace, type ZenSession } from "./sidebar.ts";
import { loadSession, writeSession } from "./session-store.ts";

const temporaryDirectories: string[] = [];

function createSessionFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "zen-bookmarks-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "zen-sessions.jsonlz4");
  const session: ZenSession = {
    spaces: [{ uuid: "workspace-1", name: "Personal", position: 0 }],
    folders: [],
    groups: [],
    tabs: [],
    splitViewData: [],
  };
  writeFileSync(path, compressMozLz4Text(JSON.stringify(session)));
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("session store", () => {
  test("backs up, atomically writes, and validates a mutation", () => {
    const path = createSessionFile();
    const loaded = loadSession(path);
    addWorkspace(loaded.session, "Work");
    const result = writeSession(loaded, loaded.session);

    expect(result.path).toBe(path);
    expect(existsSync(result.backupPath)).toBe(true);
    const decoded = Buffer.from(decompressMozLz4Buffer(readFileSync(path))).toString("utf8");
    expect(JSON.parse(decoded).spaces).toHaveLength(2);
  });

  test("rejects a concurrent source change", () => {
    const path = createSessionFile();
    const loaded = loadSession(path);
    writeFileSync(
      path,
      compressMozLz4Text(
        JSON.stringify({ ...loaded.session, lastCollected: Date.now() }),
      ),
    );
    addWorkspace(loaded.session, "Work");

    expect(() => writeSession(loaded, loaded.session)).toThrow("changed after it was read");
  });
});
