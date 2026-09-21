import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compressMozLz4Text } from "./mozlz4.ts";
import type { ZenSession } from "./sidebar.ts";

const temporaryDirectories: string[] = [];

type JsonRpcResponse = {
  id: number | undefined;
  result: Record<string, unknown> | undefined;
  error: Record<string, unknown> | undefined;
};

function fixturePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "zen-bookmarks-mcp-test-"));
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

async function exchange(messages: Record<string, unknown>[]): Promise<JsonRpcResponse[]> {
  const child = Bun.spawn({
    cmd: ["bun", "zen-bookmarks.ts", "mcp"],
    cwd: import.meta.dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  child.stdin.write(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
  child.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

function initializeMessages(): Record<string, unknown>[] {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "zen-bookmarks-test", version: "1" },
      },
    },
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  ];
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("MCP server", () => {
  test("advertises typed tools for every bookmark resource operation", async () => {
    const responses = await exchange([
      ...initializeMessages(),
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);
    const tools = responses.find((response) => response.id === 2)?.result?.tools as Array<{
      name: string;
      inputSchema: Record<string, unknown>;
    }>;

    expect(tools.map((tool) => tool.name)).toEqual([
      "status",
      "auth_status",
      "list",
      "verify",
      "export",
      "index",
      "search",
      "import_html",
      "bookmark_add",
      "bookmark_update",
      "bookmark_move",
      "bookmark_remove",
      "folder_add",
      "folder_update",
      "folder_move",
      "folder_remove",
      "workspace_add",
      "workspace_update",
      "workspace_move",
      "workspace_remove",
    ]);
    expect(tools.find((tool) => tool.name === "bookmark_add")?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        apply: { default: false, type: "boolean" },
        url: { type: "string" },
      },
      required: ["url"],
    });
  });

  test("runs read tools and keeps mutations dry-run by default", async () => {
    const path = fixturePath();
    const before = hash(path);
    const responses = await exchange([
      ...initializeMessages(),
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "status", arguments: { sessions: path } },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "bookmark_update",
          arguments: {
            sessions: path,
            id: "bookmark-1",
            url: "https://example.com/docs",
          },
        },
      },
    ]);
    const status = responses.find((response) => response.id === 2)?.result;
    const mutation = responses.find((response) => response.id === 3)?.result;

    expect(status?.structuredContent).toMatchObject({
      path,
      workspaces: 1,
      bookmarks: 1,
    });
    expect(mutation?.structuredContent).toMatchObject({ dryRun: true, path });
    expect(mutation?.isError).not.toBe(true);
    expect(hash(path)).toBe(before);
  });

  test("returns CLI failures as MCP tool errors", async () => {
    const responses = await exchange([
      ...initializeMessages(),
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "status",
          arguments: { sessions: "/does/not/exist/zen-sessions.jsonlz4" },
        },
      },
    ]);
    const result = responses.find((response) => response.id === 2)?.result;
    const content = result?.content as Array<{ text: string }>;

    expect(result?.isError).toBe(true);
    expect(content[0]?.text).toContain("no such file or directory");
  });
});
