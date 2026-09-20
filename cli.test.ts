import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressMozLz4Text } from "./mozlz4.ts";
import type { ZenSession } from "./sidebar.ts";

const temporaryDirectories: string[] = [];

function fixturePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "zen-bookmarks-cli-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "zen-sessions.jsonlz4");
  const session: ZenSession = {
    spaces: [{ uuid: "workspace-1", name: "Personal", position: 0 }],
    folders: [],
    groups: [],
    tabs: [
      {
        entries: [
          {
            url: "https://example.com",
            title: "Example",
            triggeringPrincipal_base64: "principal",
            hasUserInteraction: false,
          },
        ],
        lastAccessed: 1,
        pinned: true,
        hidden: false,
        zenWorkspace: "workspace-1",
        zenSyncId: "bookmark-1",
        zenEssential: false,
        zenDefaultUserContextId: null,
        zenPinnedIcon: null,
        zenIsEmpty: false,
        zenHasStaticIcon: false,
        zenGlanceId: null,
        zenIsGlance: false,
        zenLiveFolderItemId: null,
        groupId: undefined,
        index: 1,
        _zenPinnedInitialState: {
          entry: {
            url: "https://example.com",
            title: "Example",
            triggeringPrincipal_base64: "principal",
            hasUserInteraction: false,
          },
          image: null,
        },
      },
    ],
    splitViewData: [],
  };
  writeFileSync(path, compressMozLz4Text(JSON.stringify(session)));
  return path;
}

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("unified CLI", () => {
  test("updates a URL by ID during a non-writing dry run", () => {
    const path = fixturePath();
    const before = hash(path);
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "zen-bookmarks.ts",
        "bookmark",
        "update",
        "--id",
        "bookmark-1",
        "--url",
        "https://example.com/docs",
        "--sessions",
        path,
        "--dry-run",
        "--json",
      ],
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString()).summary).toContain("https://example.com/docs");
    expect(hash(path)).toBe(before);
  });

  test("prints help without requiring a Zen profile", () => {
    const result = Bun.spawnSync({
      cmd: ["bun", "zen-bookmarks.ts", "--help"],
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Read commands work while Zen is open");
  });
});
