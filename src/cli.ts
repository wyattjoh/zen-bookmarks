import { secrets } from "bun";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  deleteFirecrawlApiKey,
  deleteTypeSafeApiKey,
  getFirecrawlApiKey,
  getTypeSafeApiKey,
  setFirecrawlApiKey,
  setTypeSafeApiKey,
  type SecretStore,
} from "./credential-store.ts";
import { sidebarBookmarkCandidates } from "./bookmark-candidates.ts";
import { writeExports } from "./exporters.ts";
import {
  createFirecrawlPageSummarizer,
  type PageSummarizer,
} from "./firecrawl-summary.ts";
import {
  createTypeSafeLinkClassifier,
  fetchPublicLinkContent,
  indexBookmarkLinks,
  type LinkClassifier,
  type LinkContentLoader,
} from "./link-index.ts";
import type {
  NetworkDebugFields,
  NetworkDebugLogger,
} from "./network-debug.ts";
import {
  addBookmark,
  addFolder,
  addWorkspace,
  buildSidebarTree,
  importWorkspace,
  moveBookmark,
  moveFolder,
  moveWorkspace,
  parseNetscape,
  removeBookmark,
  removeFolder,
  removeWorkspace,
  updateBookmark,
  updateFolder,
  updateWorkspace,
  validateSession,
  type BookmarkSelector,
  type SidebarFolder,
  type SidebarTree,
  type ZenSession,
} from "./sidebar.ts";
import {
  defaultSearchCachePath,
  openSearchCache,
} from "./search-cache.ts";
import {
  loadSession,
  resolveSessionPath,
  verifySession,
  writeSession,
} from "./session-store.ts";
import {
  createTypeSafeRelevanceJudge,
  searchSidebarBookmarks,
  type BookmarkSearchResult,
  type RelevanceJudge,
} from "./typesafe-search.ts";
import {
  finishWriteLifecycle,
  isZenRunning,
  prepareForWrite,
  promptYesNo,
  type ZenLifecycleOptions,
} from "./zen-process.ts";

/**
 * Parsed command-line input.
 */
type ParsedArguments = {
  positionals: string[];
  values: Map<string, string>;
  switches: Set<string>;
};

/**
 * A deferred session mutation.
 */
type Mutation = (session: ZenSession) => string;

function debugUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return rawUrl.split(/[?#]/, 1)[0];
  }
}

function stderrDebugLogger(event: string, fields: NetworkDebugFields): void {
  const details = Object.entries(fields)
    .map(([key, value]) => {
      const safeValue =
        typeof value === "string" && (key === "url" || key.endsWith("_url"))
          ? debugUrl(value)
          : value;
      return `${key}=${JSON.stringify(safeValue)}`;
    })
    .join(" ");
  console.error(`[debug] ${event}${details ? ` ${details}` : ""}`);
}

async function traceNetwork<T>(
  logger: NetworkDebugLogger,
  operation: string,
  fields: NetworkDebugFields,
  run: () => Promise<T>,
  resultFields: (result: T) => NetworkDebugFields = () => ({}),
): Promise<T> {
  logger("network.start", { operation, ...fields });
  const startedAt = performance.now();
  try {
    const result = await run();
    logger("network.complete", {
      operation,
      ...fields,
      duration_ms: Math.round(performance.now() - startedAt),
      ...resultFields(result),
    });
    return result;
  } catch (error) {
    logger("network.error", {
      operation,
      ...fields,
      duration_ms: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function debugLinkContentLoader(
  loader: LinkContentLoader,
  logger: NetworkDebugLogger | undefined,
): LinkContentLoader {
  if (!logger) return loader;
  return (url) =>
    traceNetwork(
      logger,
      "page-fetch",
      { url: debugUrl(url) },
      () => loader(url),
      (content) => ({
        fetch_status: content.fetchStatus,
        final_url: content.finalUrl ? debugUrl(content.finalUrl) : null,
      }),
    );
}

function debugLinkClassifier(
  classifier: LinkClassifier,
  logger: NetworkDebugLogger | undefined,
): LinkClassifier {
  if (!logger) return classifier;
  return {
    model: classifier.model,
    classify: (state) =>
      traceNetwork(
        logger,
        "typesafe-classification",
        { model: classifier.model, url: debugUrl(state.link.url) },
        () => classifier.classify(state),
        (classification) => ({ response_model: classification.model }),
      ),
  };
}

function debugRelevanceJudge(
  judge: RelevanceJudge,
  logger: NetworkDebugLogger | undefined,
): RelevanceJudge {
  if (!logger) return judge;
  return {
    model: judge.model,
    score: (state) =>
      traceNetwork(
        logger,
        "typesafe-relevance",
        { model: judge.model, url: debugUrl(state.bookmark.url) },
        () => judge.score(state),
        (score) => ({ score }),
      ),
  };
}

function debugPageSummarizer(
  summarizer: PageSummarizer,
  logger: NetworkDebugLogger | undefined,
): PageSummarizer {
  if (!logger) return summarizer;
  return {
    summarize: (url) =>
      traceNetwork(
        logger,
        "firecrawl-summary",
        { url: debugUrl(url) },
        () => summarizer.summarize(url),
        (summary) => ({ summary_length: summary.length }),
      ),
  };
}

/**
 * Replaceable integrations used by the CLI.
 */
export type CliDependencies = {
  secretStore: SecretStore;
  createRelevanceJudge: (apiKey: string) => RelevanceJudge;
  createLinkClassifier: (apiKey: string) => LinkClassifier;
  createPageSummarizer: (apiKey: string) => PageSummarizer;
  loadLinkContent: LinkContentLoader;
  readCredential: (label: string) => Promise<string>;
  confirmCredentialReplacement: (label: string) => Promise<boolean>;
};

const DEFAULT_CLI_DEPENDENCIES: CliDependencies = {
  secretStore: secrets,
  createRelevanceJudge: createTypeSafeRelevanceJudge,
  createLinkClassifier: createTypeSafeLinkClassifier,
  createPageSummarizer: createFirecrawlPageSummarizer,
  loadLinkContent: fetchPublicLinkContent,
  readCredential: readHiddenCredential,
  confirmCredentialReplacement: (label) =>
    promptYesNo(
      `${label} API key is already configured. Replace it?`,
      false,
      "provide the matching API-key flag to replace it non-interactively",
    ),
};

const BOOLEAN_FLAGS = new Set([
  "all",
  "apply",
  "debug",
  "dry-run",
  "help",
  "json",
  "no-reopen",
  "recursive",
  "refresh",
  "reopen",
  "verbose",
  "yes",
]);

const HELP = `zen-bookmarks — browse and manage Zen bookmarks

Usage:
  zen-bookmarks                 Open the interactive bookmark browser (TTY only)
  zen-bookmarks mcp             Serve typed bookmark tools over MCP stdio
  zen-bookmarks status [options]
  zen-bookmarks list [--json] [--verbose] [options]
  zen-bookmarks verify [options]
  zen-bookmarks export [--out <directory>] [options]
  zen-bookmarks index [--refresh] [--json] [options]
  zen-bookmarks search <query> [--limit <count>] [--min-relevance <0-1>] [--json] [options]
  zen-bookmarks import-html --file <path> [--workspace <name-or-id>] [options]

  zen-bookmarks login [--typesafe-api-key <key>] [--firecrawl-api-key <key>]
  zen-bookmarks auth status [typesafe|firecrawl]
  zen-bookmarks auth delete [typesafe|firecrawl]

  zen-bookmarks bookmark add --url <url> [--title <title>] [destination]
  zen-bookmarks bookmark update --id <id> [--title <title>] [--url <new-url>]
  zen-bookmarks bookmark move --id <id> [destination]
  zen-bookmarks bookmark remove (--id <id> | --url <url>) [--all]

  zen-bookmarks folder add --name <name> [--workspace <workspace>] [--parent <folder>]
  zen-bookmarks folder update (--id <id> | --folder <name>) --name <new-name>
  zen-bookmarks folder move (--id <id> | --folder <name>) [--to-workspace <workspace>] [--parent <folder>]
  zen-bookmarks folder remove (--id <id> | --folder <name>) [--recursive]

  zen-bookmarks workspace add --name <name>
  zen-bookmarks workspace update (--id <id> | --workspace <name>) --name <new-name>
  zen-bookmarks workspace move (--id <id> | --workspace <name>) --index <zero-based-index>
  zen-bookmarks workspace remove (--id <id> | --workspace <name>) [--recursive]

Destination:
  --workspace <name-or-id>   Destination workspace for bookmark add/move
  --folder <name-or-id>      Destination folder for bookmark add/move
  --source-workspace <value> Narrow a bookmark move selector to one workspace
  --source-folder <value>    Narrow a bookmark selector to one folder

Global options:
  --sessions <path>          Explicit zen-sessions.jsonlz4 path
  --profile <substring>      Select a profile directory
  --cache <path>             Override the persistent search-cache path
  --refresh                  Replace cached link data during index
  --dry-run                  Validate and summarize without writing or closing Zen
  --debug                    Log network operations and timing to stderr
  --json                     Emit machine-readable output where supported
  --min-relevance <0-1>      Search cutoff (default: 0.5)
  --yes                      Accept lifecycle prompts (reopens Zen if it was running)
  --reopen | --no-reopen     Control whether a previously running Zen is reopened

Read commands work while Zen is open. Write commands prompt to quit Zen gracefully,
write a timestamped backup and atomically replace the session, then offer to reopen Zen.
TypeSafe and Firecrawl credentials are stored in the operating system credential store through Bun.
`;

async function readHiddenCredential(label: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error(
      "Non-interactive login requires API-key flags for every missing credential",
    );
  }

  process.stdout.write(`${label} API key: `);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolveInput, rejectInput) => {
    let value = "";
    const finish = (error: Error | undefined): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) rejectInput(error);
      else resolveInput(value.trim());
    };
    const onData = (chunk: string | Buffer): void => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          finish(new Error("Credential entry cancelled"));
          return;
        }
        if (character === "\r" || character === "\n" || character === "\u0004") {
          finish(undefined);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

function parseArguments(argv: string[]): ParsedArguments {
  const positionals: string[] = [];
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const flag = argument.slice(2, equals >= 0 ? equals : undefined);
    if (equals >= 0) {
      values.set(flag, argument.slice(equals + 1));
      continue;
    }
    if (BOOLEAN_FLAGS.has(flag)) {
      switches.add(flag);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }
  return { positionals, values, switches };
}

function required(args: ParsedArguments, name: string): string {
  const value = args.values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function bookmarkSelector(
  args: ParsedArguments,
  workspaceIsSource: boolean,
  urlIsSelector: boolean,
): BookmarkSelector {
  return {
    id: args.values.get("id"),
    url:
      args.values.get("match-url") ??
      (urlIsSelector ? args.values.get("url") : undefined),
    workspace:
      args.values.get("source-workspace") ??
      (workspaceIsSource ? args.values.get("workspace") : undefined),
    folder: args.values.get("source-folder"),
  };
}

function workspaceSelector(args: ParsedArguments): string {
  const selector = args.values.get("id") ?? args.values.get("workspace");
  if (!selector) throw new Error("workspace command requires --id or --workspace");
  return selector;
}

function mutationFor(args: ParsedArguments): Mutation | undefined {
  const [resource, action] = args.positionals;
  if (resource === "import-html") {
    const file = required(args, "file");
    return (session) =>
      importWorkspace(
        session,
        args.values.get("workspace"),
        parseNetscape(readFileSync(file, "utf8")),
      );
  }
  if (resource === "bookmark" && action === "add") {
    return (session) =>
      addBookmark(session, {
        url: required(args, "url"),
        title: args.values.get("title"),
        workspace: args.values.get("workspace"),
        folder: args.values.get("folder"),
      });
  }
  if (resource === "bookmark" && action === "update") {
    const selector = bookmarkSelector(args, true, false);
    if (!selector.id && !args.values.get("match-url")) {
      throw new Error("bookmark update requires --id or --match-url");
    }
    return (session) =>
      updateBookmark(session, selector, {
        title: args.values.get("title"),
        url: args.values.get("url"),
      });
  }
  if (resource === "bookmark" && action === "move") {
    return (session) =>
      moveBookmark(session, bookmarkSelector(args, false, true), {
        workspace: args.values.get("workspace"),
        folder: args.values.get("folder"),
      });
  }
  if (resource === "bookmark" && action === "remove") {
    return (session) =>
      removeBookmark(session, bookmarkSelector(args, true, true), args.switches.has("all"));
  }
  if (resource === "folder" && action === "add") {
    return (session) =>
      addFolder(session, {
        name: required(args, "name"),
        workspace: args.values.get("workspace"),
        parent: args.values.get("parent"),
      });
  }
  if (resource === "folder" && action === "update") {
    return (session) =>
      updateFolder(session, {
        id: args.values.get("id"),
        folder: args.values.get("folder"),
        workspace: args.values.get("workspace"),
        name: required(args, "name"),
      });
  }
  if (resource === "folder" && action === "move") {
    return (session) =>
      moveFolder(session, {
        id: args.values.get("id"),
        folder: args.values.get("folder"),
        workspace: args.values.get("workspace"),
        toWorkspace: args.values.get("to-workspace"),
        parent: args.values.get("parent"),
      });
  }
  if (resource === "folder" && action === "remove") {
    return (session) =>
      removeFolder(session, {
        id: args.values.get("id"),
        folder: args.values.get("folder"),
        workspace: args.values.get("workspace"),
        recursive: args.switches.has("recursive"),
      });
  }
  if (resource === "workspace" && action === "add") {
    return (session) => addWorkspace(session, required(args, "name"));
  }
  if (resource === "workspace" && action === "update") {
    return (session) =>
      updateWorkspace(session, workspaceSelector(args), required(args, "name"));
  }
  if (resource === "workspace" && action === "move") {
    const rawIndex = required(args, "index");
    return (session) => moveWorkspace(session, workspaceSelector(args), Number(rawIndex));
  }
  if (resource === "workspace" && action === "remove") {
    return (session) =>
      removeWorkspace(session, workspaceSelector(args), args.switches.has("recursive"));
  }
  return undefined;
}

function printTree(tree: SidebarTree, verbose: boolean): void {
  const printFolder = (folder: SidebarFolder, depth: number): void => {
    console.log(`${"  ".repeat(depth)}[${folder.name}] (${folder.id})`);
    for (const child of folder.folders) printFolder(child, depth + 1);
    for (const bookmark of folder.bookmarks) {
      console.log(
        `${"  ".repeat(depth + 1)}- ${bookmark.title} (${bookmark.id})${verbose ? `\n${"  ".repeat(depth + 2)}${bookmark.url}` : ""}`,
      );
    }
  };
  for (const workspace of tree.workspaces) {
    console.log(`\n=== ${workspace.name} (${workspace.id}) ===`);
    for (const folder of workspace.folders) printFolder(folder, 1);
    for (const bookmark of workspace.bookmarks) {
      console.log(
        `  - ${bookmark.title} (${bookmark.id})${verbose ? `\n    ${bookmark.url}` : ""}`,
      );
    }
  }
  console.log("");
}

type CredentialProvider = "typesafe" | "firecrawl";

function parseCredentialProvider(value: string | undefined): CredentialProvider {
  const provider = value ?? "typesafe";
  if (provider === "typesafe" || provider === "firecrawl") return provider;
  throw new Error("credential provider must be typesafe or firecrawl");
}

async function runLoginCommand(
  args: ParsedArguments,
  dependencies: CliDependencies,
): Promise<number> {
  if (args.positionals.length > 1) {
    throw new Error("login configures both TypeSafe and Firecrawl; omit the provider name");
  }

  const credentials = [
    {
      label: "TypeSafe",
      provided:
        args.values.get("typesafe-api-key") ?? args.values.get("api-key"),
      get: getTypeSafeApiKey,
      set: setTypeSafeApiKey,
    },
    {
      label: "Firecrawl",
      provided: args.values.get("firecrawl-api-key"),
      get: getFirecrawlApiKey,
      set: setFirecrawlApiKey,
    },
  ] as const;
  const updates: Array<{ label: string; apiKey: string; set: typeof setTypeSafeApiKey }> = [];

  for (const credential of credentials) {
    const existing = await credential.get(dependencies.secretStore);
    if (existing && !credential.provided) {
      const replace = await dependencies.confirmCredentialReplacement(credential.label);
      if (!replace) {
        console.log(`Kept the existing ${credential.label} API key.`);
        continue;
      }
    }
    const apiKey =
      credential.provided ?? (await dependencies.readCredential(credential.label));
    updates.push({ label: credential.label, apiKey, set: credential.set });
  }

  for (const update of updates) {
    await update.set(update.apiKey, dependencies.secretStore);
    console.log(`Stored ${update.label} API key in the operating system credential store.`);
  }
  return 0;
}

async function runAuthCommand(
  args: ParsedArguments,
  dependencies: CliDependencies,
): Promise<number> {
  const [, action, rawProvider] = args.positionals;
  if (action === "status") {
    const providers: CredentialProvider[] = rawProvider
      ? [parseCredentialProvider(rawProvider)]
      : ["typesafe", "firecrawl"];
    const configured = await Promise.all(
      providers.map(async (provider) => {
        const apiKey =
          provider === "typesafe"
            ? await getTypeSafeApiKey(dependencies.secretStore)
            : await getFirecrawlApiKey(dependencies.secretStore);
        const label = provider === "typesafe" ? "TypeSafe" : "Firecrawl";
        console.log(`${label} API key: ${apiKey ? "configured" : "not configured"}`);
        return Boolean(apiKey);
      }),
    );
    return configured.every(Boolean) ? 0 : 1;
  }
  if (action === "delete") {
    const provider = parseCredentialProvider(rawProvider);
    const label = provider === "typesafe" ? "TypeSafe" : "Firecrawl";
    const deleted =
      provider === "typesafe"
        ? await deleteTypeSafeApiKey(dependencies.secretStore)
        : await deleteFirecrawlApiKey(dependencies.secretStore);
    console.log(
      deleted ? `Deleted the stored ${label} API key.` : `No ${label} API key was stored.`,
    );
    return 0;
  }
  throw new Error("auth command requires status or delete");
}

function parseSearchLimit(args: ParsedArguments): number {
  const rawLimit = args.values.get("limit");
  if (!rawLimit) return 10;
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("--limit must be a positive integer");
  }
  return limit;
}

async function requireTypeSafeApiKey(dependencies: CliDependencies): Promise<string> {
  const apiKey = await getTypeSafeApiKey(dependencies.secretStore);
  if (!apiKey) throw new Error("No TypeSafe API key stored; run `zen-bookmarks login`");
  return apiKey;
}

async function requireFirecrawlApiKey(dependencies: CliDependencies): Promise<string> {
  const apiKey = await getFirecrawlApiKey(dependencies.secretStore);
  if (!apiKey) throw new Error("No Firecrawl API key stored; run `zen-bookmarks login`");
  return apiKey;
}

function searchCachePath(args: ParsedArguments): string {
  return args.values.get("cache") ?? defaultSearchCachePath();
}

function parseMinimumRelevance(args: ParsedArguments): number {
  const rawMinimum = args.values.get("min-relevance");
  if (!rawMinimum) return 0.5;
  const minimum = Number(rawMinimum);
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 1) {
    throw new Error("--min-relevance must be between 0 and 1");
  }
  return minimum;
}

function printSearchResults(results: BookmarkSearchResult[]): void {
  if (results.length === 0) {
    console.log("No bookmarks met the relevance threshold.");
    return;
  }
  for (const result of results) {
    const location = [result.workspaceName, ...result.folderPath].join(" / ");
    console.log(`${result.relevance.toFixed(3)}  ${result.title} (${result.id})`);
    console.log(`       ${location}`);
    console.log(`       ${result.url}`);
    if (result.summary) console.log(`       Summary: ${result.summary}`);
  }
}

function lifecycleOptions(args: ParsedArguments): ZenLifecycleOptions {
  let reopen: boolean | undefined;
  if (args.switches.has("reopen")) reopen = true;
  if (args.switches.has("no-reopen")) reopen = false;
  return { yes: args.switches.has("yes"), reopen, timeoutMs: 30_000 };
}

async function runMutation(
  args: ParsedArguments,
  path: string,
  mutation: Mutation,
): Promise<number> {
  if (args.switches.has("dry-run")) {
    const loaded = loadSession(path);
    const summary = mutation(loaded.session);
    const errors = validateSession(loaded.session);
    if (errors.length > 0) throw new Error(`Dry-run validation failed:\n- ${errors.join("\n- ")}`);
    if (args.switches.has("json")) {
      console.log(JSON.stringify({ dryRun: true, summary, path, zenRunning: isZenRunning() }));
    } else {
      console.log(summary);
      console.log("Dry run: no files were written and Zen was not closed.");
    }
    return 0;
  }

  const options = lifecycleOptions(args);
  const lifecycle = await prepareForWrite(options);
  if (lifecycle.cancelled) {
    console.log("Cancelled; no files were written.");
    return 0;
  }

  let primaryError: unknown;
  try {
    const loaded = loadSession(path);
    const summary = mutation(loaded.session);
    if (isZenRunning()) throw new Error("Zen restarted before the write; no changes were written");
    const result = writeSession(loaded, loaded.session);
    if (args.switches.has("json")) {
      console.log(JSON.stringify({ summary, path: result.path, backupPath: result.backupPath }));
    } else {
      console.log(summary);
      console.log(`Applied to: ${result.path}`);
      console.log(`Backup saved: ${result.backupPath}`);
    }
  } catch (error) {
    primaryError = error;
  }

  try {
    await finishWriteLifecycle(lifecycle, options);
  } catch (reopenError) {
    if (!primaryError) throw reopenError;
    console.error(`Additionally failed to reopen Zen: ${String(reopenError)}`);
  }
  if (primaryError) throw primaryError;
  return 0;
}

/**
 * Run the unified Zen bookmarks CLI.
 *
 * @param argv - Command-line arguments after the executable name
 * @returns Process exit code
 */
export async function runCli(
  argv: string[],
  dependencies: CliDependencies = DEFAULT_CLI_DEPENDENCIES,
): Promise<number> {
  const args = parseArguments(argv);
  const debugLogger = args.switches.has("debug") ? stderrDebugLogger : undefined;
  if (args.switches.has("help") || args.positionals.length === 0) {
    console.log(HELP);
    return 0;
  }

  const [command] = args.positionals;
  if (command === "login") return runLoginCommand(args, dependencies);
  if (command === "auth") return runAuthCommand(args, dependencies);

  const path = resolveSessionPath(args.values.get("sessions"), args.values.get("profile"));
  if (command === "index") {
    const apiKey = await requireTypeSafeApiKey(dependencies);
    const tree = buildSidebarTree(loadSession(path).session);
    const cachePath = searchCachePath(args);
    const cache = openSearchCache(cachePath);
    try {
      const result = await indexBookmarkLinks(
        sidebarBookmarkCandidates(tree),
        cache,
        debugLinkClassifier(dependencies.createLinkClassifier(apiKey), debugLogger),
        debugLinkContentLoader(dependencies.loadLinkContent, debugLogger),
        args.switches.has("refresh"),
        4,
        debugLogger,
      );
      if (args.switches.has("json")) console.log(JSON.stringify({ cachePath, ...result }));
      else {
        console.log(`Search cache: ${cachePath}`);
        console.log(`Indexed ${result.indexed}, reused ${result.cached}, total ${result.total}`);
      }
    } finally {
      cache.close();
    }
    return 0;
  }
  if (command === "search") {
    const query = args.positionals.slice(1).join(" ").trim();
    if (!query) throw new Error("search requires a query");
    const typeSafeApiKey = await requireTypeSafeApiKey(dependencies);
    const firecrawlApiKey = await requireFirecrawlApiKey(dependencies);
    const tree = buildSidebarTree(loadSession(path).session);
    const cache = openSearchCache(searchCachePath(args));
    try {
      const results = await searchSidebarBookmarks(
        tree,
        query,
        {
          cache,
          classifier: debugLinkClassifier(
            dependencies.createLinkClassifier(typeSafeApiKey),
            debugLogger,
          ),
          judge: debugRelevanceJudge(
            dependencies.createRelevanceJudge(typeSafeApiKey),
            debugLogger,
          ),
          loader: debugLinkContentLoader(dependencies.loadLinkContent, debugLogger),
          summarizer: debugPageSummarizer(
            dependencies.createPageSummarizer(firecrawlApiKey),
            debugLogger,
          ),
          debug: debugLogger,
        },
        {
          limit: parseSearchLimit(args),
          minimumRelevance: parseMinimumRelevance(args),
          shortlistSize: 30,
          indexConcurrency: 4,
          rerankConcurrency: 8,
        },
      );
      if (args.switches.has("json")) console.log(JSON.stringify(results, null, 2));
      else printSearchResults(results);
    } finally {
      cache.close();
    }
    return 0;
  }
  if (command === "status") {
    const loaded = loadSession(path);
    const status = {
      path,
      profile: path.split("/").at(-2),
      zenRunning: isZenRunning(),
      workspaces: loaded.session.spaces.length,
      folders: loaded.session.folders.length,
      bookmarks: loaded.session.tabs.filter((tab) => tab.pinned && !tab.zenIsEmpty).length,
    };
    if (args.switches.has("json")) console.log(JSON.stringify(status));
    else {
      console.log(`Session: ${status.path}`);
      console.log(`Zen running: ${status.zenRunning ? "yes" : "no"}`);
      console.log(
        `${status.workspaces} workspaces, ${status.folders} folders, ${status.bookmarks} bookmarks`,
      );
    }
    return 0;
  }
  if (command === "list") {
    const tree = buildSidebarTree(loadSession(path).session);
    if (args.switches.has("json")) console.log(JSON.stringify(tree, null, 2));
    else printTree(tree, args.switches.has("verbose"));
    return 0;
  }
  if (command === "verify") {
    const result = verifySession(path);
    if (args.switches.has("json")) console.log(JSON.stringify({ path, ...result }));
    else {
      console.log(`Source: ${path}`);
      console.log(
        `Tabs: ${result.tabs}, pinned bookmarks: ${result.bookmarks}, workspaces: ${result.workspaces}`,
      );
      console.log(`Round-trip lossless: ${result.roundTripLossless ? "YES" : "NO"}`);
      console.log(
        `Structure valid: ${result.structuralErrors.length === 0 ? "YES" : `NO\n- ${result.structuralErrors.join("\n- ")}`}`,
      );
    }
    return result.roundTripLossless && result.structuralErrors.length === 0 ? 0 : 1;
  }
  if (command === "export") {
    const outputDirectory = resolve(args.values.get("out") ?? process.cwd());
    const result = writeExports(loadSession(path).session, outputDirectory);
    if (args.switches.has("json")) console.log(JSON.stringify({ path, ...result }));
    else {
      console.log(`Source: ${path}`);
      console.log(`Output: ${outputDirectory}`);
      console.log(
        `Exported ${result.bookmarkCount} bookmarks across ${result.workspaceCount} workspaces`,
      );
      console.log("Wrote bookmarks.json, bookmarks.yaml, bookmarks.html");
    }
    return 0;
  }

  const mutation = mutationFor(args);
  if (!mutation) throw new Error(`Unknown command: ${args.positionals.join(" ")}\n\n${HELP}`);
  return runMutation(args, path, mutation);
}
