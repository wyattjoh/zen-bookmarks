import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { join } from "node:path";
import { z } from "zod";

/**
 * Result from invoking the Zen bookmarks CLI for an MCP tool.
 */
export type CliExecutionResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

/**
 * Replaceable CLI executor used by the MCP server.
 */
export type CliExecutor = (argv: string[]) => Promise<CliExecutionResult>;

const sessionFields = {
  sessions: z
    .string()
    .min(1)
    .optional()
    .describe("Explicit path to zen-sessions.jsonlz4"),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe("Zen profile directory name or unique substring"),
};

const mutationFields = {
  ...sessionFields,
  apply: z
    .boolean()
    .default(false)
    .describe("Apply the mutation. Defaults to false, which performs a dry run."),
  reopen: z
    .boolean()
    .optional()
    .describe("Whether to reopen Zen after an applied mutation if it was running"),
};

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
};

const searchAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

function appendOption(
  argv: string[],
  flag: string,
  value: string | number | undefined,
): void {
  if (value !== undefined) argv.push(`--${flag}`, String(value));
}

function appendSessionOptions(
  argv: string[],
  sessions: string | undefined,
  profile: string | undefined,
): void {
  appendOption(argv, "sessions", sessions);
  appendOption(argv, "profile", profile);
}

function appendMutationOptions(
  argv: string[],
  sessions: string | undefined,
  profile: string | undefined,
  apply: boolean,
  reopen: boolean | undefined,
): void {
  appendSessionOptions(argv, sessions, profile);
  argv.push(apply ? "--yes" : "--dry-run");
  if (reopen !== undefined) argv.push(reopen ? "--reopen" : "--no-reopen");
}

function parseStructuredOutput(stdout: string): Record<string, unknown> | undefined {
  if (!stdout) return undefined;
  try {
    const value: unknown = JSON.parse(stdout);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return { result: value };
  } catch {
    return undefined;
  }
}

async function executeCli(argv: string[]): Promise<CliExecutionResult> {
  const child = Bun.spawn({
    cmd: [process.execPath, join(import.meta.dir, "zen-bookmarks.ts"), ...argv],
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function callCli(executor: CliExecutor, argv: string[]): Promise<CallToolResult> {
  const result = await executor([...argv, "--json"]);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const text = [stdout, stderr].filter(Boolean).join("\n");
  if (result.exitCode !== 0) {
    return {
      content: [{ type: "text", text: text || `Command exited with code ${result.exitCode}` }],
      structuredContent: parseStructuredOutput(stdout),
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: text || "Command completed successfully." }],
    structuredContent: parseStructuredOutput(stdout),
  };
}

/**
 * Create an MCP server exposing typed Zen bookmarks tools.
 *
 * @param executor - CLI executor used by tool handlers
 * @returns Configured MCP server
 */
export function createZenBookmarksMcpServer(
  executor: CliExecutor = executeCli,
): McpServer {
  const server = new McpServer({ name: "zen-bookmarks", version: "0.2.0" });
  const run = (argv: string[]): Promise<CallToolResult> => callCli(executor, argv);

  server.registerTool(
    "status",
    {
      description: "Inspect the selected Zen profile and count its workspaces, folders, and bookmarks.",
      inputSchema: z.object(sessionFields),
      annotations: readOnlyAnnotations,
    },
    async (input) => {
      const argv = ["status"];
      appendSessionOptions(argv, input.sessions, input.profile);
      return run(argv);
    },
  );

  server.registerTool(
    "auth_status",
    {
      description: "Report whether a TypeSafe API key is configured in the operating system credential store.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => run(["auth", "status"]),
  );

  server.registerTool(
    "list",
    {
      description: "List the complete typed workspace, folder, and sidebar-bookmark tree with stable IDs.",
      inputSchema: z.object(sessionFields),
      annotations: readOnlyAnnotations,
    },
    async (input) => {
      const argv = ["list"];
      appendSessionOptions(argv, input.sessions, input.profile);
      return run(argv);
    },
  );

  server.registerTool(
    "verify",
    {
      description: "Verify mozLz4 round-trip fidelity and structural validity for a Zen session.",
      inputSchema: z.object(sessionFields),
      annotations: readOnlyAnnotations,
    },
    async (input) => {
      const argv = ["verify"];
      appendSessionOptions(argv, input.sessions, input.profile);
      return run(argv);
    },
  );

  server.registerTool(
    "export",
    {
      description: "Export sidebar bookmarks as JSON, YAML, and Netscape HTML files.",
      inputSchema: z.object({
        ...sessionFields,
        out: z.string().min(1).describe("Output directory"),
      }),
      annotations: { ...readOnlyAnnotations, readOnlyHint: false },
    },
    async (input) => {
      const argv = ["export", "--out", input.out];
      appendSessionOptions(argv, input.sessions, input.profile);
      return run(argv);
    },
  );

  server.registerTool(
    "index",
    {
      description: "Fetch and classify sidebar bookmark content into the persistent search cache.",
      inputSchema: z.object({
        ...sessionFields,
        cache: z.string().min(1).optional().describe("Override the search-cache path"),
        refresh: z.boolean().default(false).describe("Replace existing cached content"),
      }),
      annotations: searchAnnotations,
    },
    async (input) => {
      const argv = ["index"];
      appendSessionOptions(argv, input.sessions, input.profile);
      appendOption(argv, "cache", input.cache);
      if (input.refresh) argv.push("--refresh");
      return run(argv);
    },
  );

  server.registerTool(
    "search",
    {
      description: "Search sidebar bookmarks with local BM25 retrieval and TypeSafe relevance reranking.",
      inputSchema: z.object({
        ...sessionFields,
        query: z.string().min(1).describe("Natural-language search query"),
        cache: z.string().min(1).optional().describe("Override the search-cache path"),
        limit: z.number().int().positive().optional().describe("Maximum result count"),
        minRelevance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum relevance score from 0 to 1"),
      }),
      annotations: searchAnnotations,
    },
    async (input) => {
      const argv = ["search", input.query];
      appendSessionOptions(argv, input.sessions, input.profile);
      appendOption(argv, "cache", input.cache);
      appendOption(argv, "limit", input.limit);
      appendOption(argv, "min-relevance", input.minRelevance);
      return run(argv);
    },
  );

  server.registerTool(
    "import_html",
    {
      description: "Rebuild one workspace's pinned tree from a Netscape HTML bookmark file. Dry-runs by default.",
      inputSchema: z.object({
        ...mutationFields,
        file: z.string().min(1).describe("Path to a Netscape HTML bookmark file"),
        workspace: z.string().min(1).optional().describe("Destination workspace name or ID"),
      }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["import-html", "--file", input.file];
      appendOption(argv, "workspace", input.workspace);
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "bookmark_add",
    {
      description: "Add a sidebar bookmark. Dry-runs by default.",
      inputSchema: z.object({
        ...mutationFields,
        url: z.url().describe("Bookmark URL"),
        title: z.string().min(1).optional().describe("Bookmark title"),
        workspace: z.string().min(1).optional().describe("Destination workspace name or ID"),
        folder: z.string().min(1).optional().describe("Destination folder name or ID"),
      }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["bookmark", "add", "--url", input.url];
      appendOption(argv, "title", input.title);
      appendOption(argv, "workspace", input.workspace);
      appendOption(argv, "folder", input.folder);
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "bookmark_update",
    {
      description: "Update a sidebar bookmark selected by stable ID or old URL. Dry-runs by default.",
      inputSchema: z
        .object({
          ...mutationFields,
          id: z.string().min(1).optional().describe("Stable bookmark ID"),
          matchUrl: z.url().optional().describe("Existing URL selector"),
          title: z.string().min(1).optional().describe("New bookmark title"),
          url: z.url().optional().describe("New bookmark URL"),
        })
        .refine((input) => input.id !== undefined || input.matchUrl !== undefined, {
          message: "id or matchUrl is required",
        }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["bookmark", "update"];
      appendOption(argv, "id", input.id);
      appendOption(argv, "match-url", input.matchUrl);
      appendOption(argv, "title", input.title);
      appendOption(argv, "url", input.url);
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "bookmark_move",
    {
      description: "Move a sidebar bookmark to a workspace or folder. Dry-runs by default.",
      inputSchema: z
        .object({
          ...mutationFields,
          id: z.string().min(1).optional().describe("Stable bookmark ID"),
          url: z.url().optional().describe("Bookmark URL selector"),
          workspace: z.string().min(1).optional().describe("Destination workspace name or ID"),
          folder: z.string().min(1).optional().describe("Destination folder name or ID"),
          sourceWorkspace: z.string().min(1).optional().describe("Source workspace disambiguator"),
          sourceFolder: z.string().min(1).optional().describe("Source folder disambiguator"),
        })
        .refine((input) => input.id !== undefined || input.url !== undefined, {
          message: "id or url is required",
        }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["bookmark", "move"];
      appendOption(argv, "id", input.id);
      appendOption(argv, "url", input.url);
      appendOption(argv, "workspace", input.workspace);
      appendOption(argv, "folder", input.folder);
      appendOption(argv, "source-workspace", input.sourceWorkspace);
      appendOption(argv, "source-folder", input.sourceFolder);
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "bookmark_remove",
    {
      description: "Remove sidebar bookmarks selected by stable ID or URL. Dry-runs by default.",
      inputSchema: z
        .object({
          ...mutationFields,
          id: z.string().min(1).optional().describe("Stable bookmark ID"),
          url: z.url().optional().describe("Bookmark URL selector"),
          workspace: z.string().min(1).optional().describe("Source workspace disambiguator"),
          sourceFolder: z.string().min(1).optional().describe("Source folder disambiguator"),
          all: z.boolean().default(false).describe("Remove every matching URL"),
        })
        .refine((input) => input.id !== undefined || input.url !== undefined, {
          message: "id or url is required",
        }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["bookmark", "remove"];
      appendOption(argv, "id", input.id);
      appendOption(argv, "url", input.url);
      appendOption(argv, "workspace", input.workspace);
      appendOption(argv, "source-folder", input.sourceFolder);
      if (input.all) argv.push("--all");
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "folder_add",
    {
      description: "Add a sidebar folder. Dry-runs by default.",
      inputSchema: z.object({
        ...mutationFields,
        name: z.string().min(1).describe("New folder name"),
        workspace: z.string().min(1).optional().describe("Destination workspace name or ID"),
        parent: z.string().min(1).optional().describe("Parent folder name or ID"),
      }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["folder", "add", "--name", input.name];
      appendOption(argv, "workspace", input.workspace);
      appendOption(argv, "parent", input.parent);
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "folder_update",
    {
      description: "Rename a sidebar folder selected by stable ID or name. Dry-runs by default.",
      inputSchema: z
        .object({
          ...mutationFields,
          id: z.string().min(1).optional().describe("Stable folder ID"),
          folder: z.string().min(1).optional().describe("Existing folder name"),
          workspace: z.string().min(1).optional().describe("Workspace disambiguator"),
          name: z.string().min(1).describe("New folder name"),
        })
        .refine((input) => input.id !== undefined || input.folder !== undefined, {
          message: "id or folder is required",
        }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["folder", "update", "--name", input.name];
      appendOption(argv, "id", input.id);
      appendOption(argv, "folder", input.folder);
      appendOption(argv, "workspace", input.workspace);
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "folder_move",
    {
      description: "Move a sidebar folder to another parent or workspace. Dry-runs by default.",
      inputSchema: z
        .object({
          ...mutationFields,
          id: z.string().min(1).optional().describe("Stable folder ID"),
          folder: z.string().min(1).optional().describe("Existing folder name"),
          workspace: z.string().min(1).optional().describe("Source workspace disambiguator"),
          toWorkspace: z.string().min(1).optional().describe("Destination workspace name or ID"),
          parent: z.string().min(1).optional().describe("Destination parent folder name or ID"),
        })
        .refine((input) => input.id !== undefined || input.folder !== undefined, {
          message: "id or folder is required",
        }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["folder", "move"];
      appendOption(argv, "id", input.id);
      appendOption(argv, "folder", input.folder);
      appendOption(argv, "workspace", input.workspace);
      appendOption(argv, "to-workspace", input.toWorkspace);
      appendOption(argv, "parent", input.parent);
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "folder_remove",
    {
      description: "Remove a sidebar folder. Non-empty folders require recursive=true. Dry-runs by default.",
      inputSchema: z
        .object({
          ...mutationFields,
          id: z.string().min(1).optional().describe("Stable folder ID"),
          folder: z.string().min(1).optional().describe("Existing folder name"),
          workspace: z.string().min(1).optional().describe("Workspace disambiguator"),
          recursive: z.boolean().default(false).describe("Remove nested contents too"),
        })
        .refine((input) => input.id !== undefined || input.folder !== undefined, {
          message: "id or folder is required",
        }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["folder", "remove"];
      appendOption(argv, "id", input.id);
      appendOption(argv, "folder", input.folder);
      appendOption(argv, "workspace", input.workspace);
      if (input.recursive) argv.push("--recursive");
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "workspace_add",
    {
      description: "Add a Zen workspace. Dry-runs by default.",
      inputSchema: z.object({
        ...mutationFields,
        name: z.string().min(1).describe("New workspace name"),
      }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["workspace", "add", "--name", input.name];
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "workspace_update",
    {
      description: "Rename a workspace selected by stable ID or name. Dry-runs by default.",
      inputSchema: z
        .object({
          ...mutationFields,
          id: z.string().min(1).optional().describe("Stable workspace ID"),
          workspace: z.string().min(1).optional().describe("Existing workspace name"),
          name: z.string().min(1).describe("New workspace name"),
        })
        .refine((input) => input.id !== undefined || input.workspace !== undefined, {
          message: "id or workspace is required",
        }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["workspace", "update", "--name", input.name];
      appendOption(argv, "id", input.id);
      appendOption(argv, "workspace", input.workspace);
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "workspace_move",
    {
      description: "Move a workspace to a zero-based index. Dry-runs by default.",
      inputSchema: z
        .object({
          ...mutationFields,
          id: z.string().min(1).optional().describe("Stable workspace ID"),
          workspace: z.string().min(1).optional().describe("Existing workspace name"),
          index: z.number().int().nonnegative().describe("Zero-based destination index"),
        })
        .refine((input) => input.id !== undefined || input.workspace !== undefined, {
          message: "id or workspace is required",
        }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["workspace", "move", "--index", String(input.index)];
      appendOption(argv, "id", input.id);
      appendOption(argv, "workspace", input.workspace);
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  server.registerTool(
    "workspace_remove",
    {
      description: "Remove a workspace. Non-empty workspaces require recursive=true. Dry-runs by default.",
      inputSchema: z
        .object({
          ...mutationFields,
          id: z.string().min(1).optional().describe("Stable workspace ID"),
          workspace: z.string().min(1).optional().describe("Existing workspace name"),
          recursive: z.boolean().default(false).describe("Remove workspace tabs too"),
        })
        .refine((input) => input.id !== undefined || input.workspace !== undefined, {
          message: "id or workspace is required",
        }),
      annotations: writeAnnotations,
    },
    async (input) => {
      const argv = ["workspace", "remove"];
      appendOption(argv, "id", input.id);
      appendOption(argv, "workspace", input.workspace);
      if (input.recursive) argv.push("--recursive");
      appendMutationOptions(argv, input.sessions, input.profile, input.apply, input.reopen);
      return run(argv);
    },
  );

  return server;
}

/**
 * Serve Zen bookmarks MCP tools over standard input and output.
 */
export function runMcpServer(): void {
  serveStdio(() => createZenBookmarksMcpServer(), {
    onerror(error) {
      console.error(`MCP error: ${error.message}`);
    },
  });
}
