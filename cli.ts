import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeExports } from "./exporters.ts";
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
  loadSession,
  resolveSessionPath,
  verifySession,
  writeSession,
} from "./session-store.ts";
import {
  finishWriteLifecycle,
  isZenRunning,
  prepareForWrite,
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

const BOOLEAN_FLAGS = new Set([
  "all",
  "apply",
  "dry-run",
  "help",
  "json",
  "no-reopen",
  "recursive",
  "reopen",
  "verbose",
  "yes",
]);

const HELP = `zen-bookmarks — manage Zen's pinned sidebar offline

Usage:
  zen-bookmarks status [options]
  zen-bookmarks list [--json] [--verbose] [options]
  zen-bookmarks verify [options]
  zen-bookmarks export [--out <directory>] [options]
  zen-bookmarks import-html --file <path> [--workspace <name-or-id>] [options]

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
  --dry-run                  Validate and summarize without writing or closing Zen
  --json                     Emit machine-readable output where supported
  --yes                      Accept lifecycle prompts (reopens Zen if it was running)
  --reopen | --no-reopen     Control whether a previously running Zen is reopened

Read commands work while Zen is open. Write commands prompt to quit Zen gracefully,
write a timestamped backup and atomically replace the session, then offer to reopen Zen.
`;

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
export async function runCli(argv: string[]): Promise<number> {
  const args = parseArguments(argv);
  if (args.switches.has("help") || args.positionals.length === 0) {
    console.log(HELP);
    return 0;
  }

  const path = resolveSessionPath(args.values.get("sessions"), args.values.get("profile"));
  const [command] = args.positionals;
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
