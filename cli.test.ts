import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliDependencies } from "./cli.ts";
import type { SecretStore } from "./credential-store.ts";
import type { LinkClassification } from "./link-index.ts";
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

function memorySecretStore(): SecretStore {
  let value: string | null = null;
  return {
    async get() {
      return value;
    },
    async set(options) {
      value = options.value;
    },
    async delete() {
      const deleted = value !== null;
      value = null;
      return deleted;
    },
  };
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

  test("stores credentials and searches with injected TypeSafe judgments", async () => {
    const path = fixturePath();
    const store = memorySecretStore();
    const judgedQueries: string[] = [];
    const classification: LinkClassification = {
      version: 1,
      model: "test-model",
      resourceKind: { value: "documentation", confidence: 1, probabilities: {} },
      purpose: { value: "reference", confidence: 1, probabilities: {} },
      topics: {
        aiAgents: 0,
        softwareDevelopment: 1,
        identitySecurity: 0,
        cloudInfrastructure: 0,
        data: 0,
        design: 0,
        productivity: 0,
        businessFinance: 0,
        personalLifestyle: 0,
        food: 0,
        hardware: 0,
        entertainment: 0,
      },
    };
    const dependencies: CliDependencies = {
      secretStore: store,
      createRelevanceJudge(apiKey) {
        expect(apiKey).toBe("test-key");
        return {
          model: "test-model",
          async score(state) {
            judgedQueries.push(state.query);
            return 0.87;
          },
        };
      },
      createLinkClassifier(apiKey) {
        expect(apiKey).toBe("test-key");
        return {
          model: "test-model",
          async classify() {
            return classification;
          },
        };
      },
      async loadLinkContent() {
        return {
          fetchStatus: "ok",
          finalUrl: null,
          pageTitle: "Example",
          description: "Useful example",
          text: "Example reference content",
          error: null,
        };
      },
      async readCredential() {
        return "test-key";
      },
    };
    const output: string[] = [];
    const originalLog = console.log;
    console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));

    try {
      expect(await runCli(["auth", "status"], dependencies)).toBe(1);
      expect(await runCli(["login"], dependencies)).toBe(0);
      expect(
        await runCli(
          [
            "search",
            "useful",
            "example",
            "--sessions",
            path,
            "--cache",
            `${path}.sqlite`,
            "--limit",
            "1",
            "--json",
          ],
          dependencies,
        ),
      ).toBe(0);
    } finally {
      console.log = originalLog;
    }

    expect(judgedQueries).toEqual(["useful example"]);
    expect(JSON.parse(output.at(-1) ?? "[]")).toEqual([
      expect.objectContaining({ id: "bookmark-1", title: "Example", relevance: 0.87 }),
    ]);
  });
});
