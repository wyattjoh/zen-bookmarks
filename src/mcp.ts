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
    .describe(
      "Exact zen-sessions.jsonlz4 path. Usually omit this and let default profile discovery resolve the session.",
    ),
  profile: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Zen profile directory name or unique substring. Use only when default profile discovery is ambiguous.",
    ),
};

const mutationFields = {
  ...sessionFields,
  apply: z
    .boolean()
    .default(false)
    .describe(
      "Apply the mutation. Leave false for the default safe dry run; set true only after the user approves the preview.",
    ),
  reopen: z
    .boolean()
    .optional()
    .describe("Reopen Zen after an applied mutation when it was running before the change."),
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

const serverInstructions = [
  "Use search first when the user asks for relevant, useful, or topic-matching sidebar bookmarks.",
  "For exploratory project discovery, choose at most four diverse natural-language intents before starting, then issue one search call per intent sequentially with minRelevance 0.15 and limit 5 to 8.",
  "Never call search more than four times for one request. Stop earlier once you have 3 to 8 strong distinct matches or when two consecutive searches add no useful URLs; deduplicate by URL and do not retry below minRelevance 0.15 unless the user explicitly requests exhaustive low-confidence results.",
  "Search results already include workspaceName and folderPath, so do not call status or list merely to locate a result.",
  "Do not call index before search because search lazily populates its cache.",
  "Use list only for exhaustive sidebar browsing, exact stable-ID resolution, mutation preparation, or fallback after search fails.",
  "The MCP tools cover pinned Zen sidebar bookmarks; Firefox-style saved bookmarks from places.sqlite are available only through the interactive browser.",
  "Mutations default to a dry run. Show that preview and obtain approval before calling the same tool with apply true.",
].join(" ");

const sidebarBookmarkOutputSchema = z.object({
  id: z.string().describe("Stable sidebar bookmark ID"),
  title: z.string(),
  url: z.string(),
  currentUrl: z.string().optional(),
  workspaceId: z.string(),
  folderId: z.string().optional(),
  index: z.number().int().nonnegative(),
});

const sidebarFolderOutputSchema: z.ZodType<unknown> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    workspaceId: z.string(),
    parentId: z.string().optional(),
    folders: z.array(sidebarFolderOutputSchema),
    bookmarks: z.array(sidebarBookmarkOutputSchema),
  }),
);

const sidebarTreeOutputSchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      folders: z.array(sidebarFolderOutputSchema),
      bookmarks: z.array(sidebarBookmarkOutputSchema),
    }),
  ),
});

const statusOutputSchema = z.object({
  path: z.string(),
  profile: z.string().optional(),
  zenRunning: z.boolean(),
  workspaces: z.number().int().nonnegative(),
  folders: z.number().int().nonnegative(),
  bookmarks: z.number().int().nonnegative(),
});

const searchOutputSchema = z.object({
  result: z.array(
    sidebarBookmarkOutputSchema.extend({
      workspaceName: z.string(),
      folderPath: z.array(z.string()),
      retrievalScore: z.number(),
      relevance: z.number().min(0).max(1),
    }),
  ),
});

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
  const server = new McpServer(
    { name: "zen-bookmarks", version: "0.2.0", title: "Zen Bookmarks" },
    { instructions: serverInstructions },
  );
  const run = (argv: string[]): Promise<CallToolResult> => callCli(executor, argv);

  server.registerTool(
    "status",
    {
      title: "Inspect Zen Profile",
      description:
        "Diagnose profile selection and count pinned sidebar bookmarks, folders, and workspaces. Do not call this before search or list when default profile discovery works.",
      inputSchema: z.object(sessionFields),
      outputSchema: statusOutputSchema,
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
      title: "Check TypeSafe Credentials",
      description:
        "Diagnose whether relevance search credentials are configured. Call only when the user asks or search reports a credential error.",
      inputSchema: z.object({}),
      annotations: readOnlyAnnotations,
    },
    async () => run(["auth", "status"]),
  );

  server.registerTool(
    "list",
    {
      title: "List Sidebar Bookmark Tree",
      description:
        "Return the complete recursive pinned-sidebar tree with stable workspace, folder, and bookmark IDs. This can be large: use only for exhaustive browsing, exact ID resolution, mutation preparation, or fallback after search fails. It does not include Firefox-style saved bookmarks from places.sqlite.",
      inputSchema: z.object(sessionFields),
      outputSchema: sidebarTreeOutputSchema,
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
      title: "Verify Zen Session",
      description:
        "Verify mozLz4 round-trip fidelity and structural validity. Use before applying mutations, not for ordinary search or browsing.",
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
      title: "Export Sidebar Bookmarks",
      description: "Export pinned sidebar bookmarks as JSON, YAML, and Netscape HTML files.",
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
      title: "Index Sidebar Bookmark Content",
      description:
        "Explicitly prewarm or refresh the persistent relevance-search cache. Do not call before search: search lazily indexes missing content itself. This tool fetches public pages and uses TypeSafe classification.",
      inputSchema: z.object({
        ...sessionFields,
        cache: z.string().min(1).optional().describe("Override the search-cache path."),
        refresh: z
          .boolean()
          .default(false)
          .describe("Refetch and reclassify content already present in the cache."),
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
      title: "Find Relevant Sidebar Bookmarks",
      description:
        "Preferred first tool for finding useful or topic-matching pinned Zen sidebar bookmarks. Uses local BM25 retrieval plus TypeSafe reranking and lazily indexes missing public content. For project discovery choose at most four diverse focused intents, issue their calls sequentially, and stop earlier after finding 3 to 8 strong distinct URLs or after two calls add nothing useful. Use minRelevance 0.15; do not retry below it unless the user explicitly requests exhaustive low-confidence results. Results already include workspaceName and folderPath, so do not call status or list to locate them. Does not search Firefox-style saved bookmarks from places.sqlite.",
      inputSchema: z.object({
        ...sessionFields,
        query: z
          .string()
          .min(1)
          .describe("One focused natural-language search intent; avoid unrelated keyword lists."),
        cache: z.string().min(1).optional().describe("Override the search-cache path."),
        limit: z
          .number()
          .int()
          .positive()
          .max(8)
          .default(8)
          .describe("Maximum result count for this query, capped at 8."),
        minRelevance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "Minimum TypeSafe relevance score from 0 to 1. Defaults to a strict 0.5; use 0.15 for exploratory discovery.",
          ),
      }),
      outputSchema: searchOutputSchema,
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
      title: "Import Bookmark HTML",
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
      title: "Add Sidebar Bookmark",
      description: "Add a pinned sidebar bookmark. Dry-runs by default.",
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
      title: "Update Sidebar Bookmark",
      description: "Update a pinned sidebar bookmark selected by stable ID or old URL. Dry-runs by default.",
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
      title: "Move Sidebar Bookmark",
      description: "Move a pinned sidebar bookmark to a workspace or folder. Dry-runs by default.",
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
      title: "Remove Sidebar Bookmark",
      description: "Remove pinned sidebar bookmarks selected by stable ID or URL. Dry-runs by default.",
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
      title: "Add Sidebar Folder",
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
      title: "Rename Sidebar Folder",
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
      title: "Move Sidebar Folder",
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
      title: "Remove Sidebar Folder",
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
      title: "Add Zen Workspace",
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
      title: "Rename Zen Workspace",
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
      title: "Reorder Zen Workspace",
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
      title: "Remove Zen Workspace",
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
