---
name: zen-bookmarks
description: Operates the zen-bookmarks CLI and MCP server to search and browse saved or sidebar bookmarks and manage Zen Browser's sidebar folders and workspaces. Use when asked to "find relevant Zen bookmarks", "list Zen bookmarks", "browse Zen bookmarks", "manage Zen sidebar pins", "add or move a Zen bookmark", "manage Zen folders or workspaces", "import bookmarks into Zen", "export Zen bookmarks", or interact with `zen-bookmarks`, its MCP tools, `places.sqlite`, `zen-sessions.jsonlz4`, or Zen profile bookmark data.
license: MIT
compatibility: Requires macOS, Zen Browser, and Bun 1.3 or newer. The `zen-bookmarks` executable must be linked or run from this repository with `bun src/zen-bookmarks.ts`.
---

# Zen Bookmarks

Use the unified `zen-bookmarks` CLI or its MCP server to browse Zen bookmarks and modify the browser's sidebar. “Bookmarks” collectively means saved bookmarks from `places.sqlite` and pinned sidebar links/tabs from `zen-sessions.jsonlz4`. Saved bookmarks are browse-only; mutation commands manage sidebar bookmarks, folders, and workspaces.

## Route the request

Choose one route before calling tools:

- **Relevant/helpful sidebar bookmarks via MCP:** use the MCP `search` fast path below. Do not call `status`, `auth_status`, `index`, or `list` first.
- **Explicitly exhaustive sidebar browsing or exact ID lookup:** call `list` once and filter its `structuredContent` inside the same client-side script. Do not repeatedly re-list or emit the full tree.
- **Saved bookmarks from `places.sqlite`:** explain that MCP `search` and `list` cover only pinned sidebar bookmarks; use the interactive browser when saved-bookmark coverage is required.
- **Mutation:** establish the exact profile/session, inspect stable IDs, and follow the dry-run workflow.
- **Interactive browsing:** launch the TUI only when the user requests an interactive terminal browser or needs saved bookmarks.

For a relevance request, keep the normal budget to one project-context tool turn and one batched MCP tool turn after loading this skill. Exceed that budget only for a concrete tool error, ambiguous profile, or an explicit request for exhaustive coverage.

## Choose the executable

Prefer the linked command:

```bash
zen-bookmarks --help
```

If it is unavailable and the current repository contains `src/zen-bookmarks.ts`, use:

```bash
bun src/zen-bookmarks.ts --help
```

Use the chosen form consistently. Do not run `bun link` or install anything unless the user asks. The CLI exposes only global help; do not expect command-specific `--help` output.

## Serve over MCP

Run `zen-bookmarks mcp` to expose typed stdio MCP tools for status, list, verification, export, indexing, search, HTML import, and bookmark/folder/workspace CRUD. Mutation tools use `apply: false` by default, which performs the same safe dry run as `--dry-run`; set `apply: true` only after showing the dry-run result and receiving confirmation. Use the tool's `reopen` boolean to control the Zen lifecycle when applying.

The MCP server intentionally excludes credential entry and deletion because MCP calls may be logged. Use `zen-bookmarks login` once in a trusted terminal to configure both TypeSafe and Firecrawl; existing keys are kept unless replacement is confirmed. Provider-specific `zen-bookmarks auth delete` commands remain available. Search requires both credentials.

### Find relevant bookmarks efficiently

When the user asks which bookmarks might help with a project or topic and MCP is available or explicitly requested, use the MCP `search` tool rather than enumerating the complete bookmark tree:

1. Use context already supplied by the user. If more is necessary, read **at most one** concise project overview—prefer `README.md`; do not also read `package.json` or tour the repository.
2. Identify four distinct intents and send one focused natural-language query per intent, such as `terminal UI testing` or `agent-friendly CLI design`. Do not combine unrelated technologies into one keyword-heavy query.
3. Batch every query into one MCP client round trip. For exploratory discovery, use a modest `limit` such as 5–8 and `minRelevance: 0.15`; shortlist at most two results per intent before combining them.
4. Unwrap the MCP client response before ranking. In Pi's `mcpScript`, `tools.call()` returns an `{ ok, data }` envelope; the CLI's structured search array is `response.data.structuredContent.result`.
5. Deduplicate results by URL, preserve at least one strong result from each successful intent before filling remaining slots by relevance, and report `title`, `url`, `workspaceName`, `folderPath`, `relevance`, and cached Firecrawl `summary` when available.
6. Stop once 5–8 useful, diverse results have enough context to answer. Search already returns workspace and folder locations, so do not call `list` to rediscover them.

`search` and `list` cover pinned sidebar bookmarks only. If the user explicitly requires saved bookmarks from `places.sqlite`, explain that limitation and use the interactive browser rather than claiming MCP coverage.

A single Pi `mcpScript` can perform discovery and all searches without intermediate schema-probing calls:

```javascript
const found = await tools.search({ query: "zen-bookmarks search" });
const searchTool = found.items.find((item) => item.path === "zen-bookmarks_search");
if (!searchTool) return emit({ error: "zen-bookmarks search tool not found" });

const queries = [
  "terminal UI testing",
  "agent-friendly CLI design",
  "MCP server patterns",
  "browser session storage",
];
const matches = [];
for (const query of queries) {
  const response = await tools.call(searchTool.path, { query, limit: 6, minRelevance: 0.15 });
  if (!response.ok) return emit({ query, error: response.error });
  const results = response.data?.structuredContent?.result;
  if (!Array.isArray(results)) return emit({ query, error: "unexpected search response" });
  const ranked = [...results].sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
  matches.push(...ranked.slice(0, 2).map((result) => ({ ...result, matchedQuery: query })));
}

const unique = [...new Map(matches.map((result) => [result.url, result])).values()];
const firstPerQuery = queries.flatMap((query) => {
  const match = unique.find((result) => result.matchedQuery === query);
  return match ? [match] : [];
});
const selectedUrls = new Set(firstPerQuery.map((result) => result.url));
const remaining = unique
  .filter((result) => !selectedUrls.has(result.url))
  .sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
return emit([...firstPerQuery, ...remaining].slice(0, 8));
```

Do not call `auth_status` before every search; call it only when the user asks or when `search` reports a TypeSafe or Firecrawl credential problem. Search uses TypeSafe to rank candidates, then requests and caches general Firecrawl summaries for every returned public result above the relevance threshold. Use `list` instead of `search` only for exhaustive browsing, exact ID resolution, mutation preparation, or as a fallback when relevance search is unavailable.

## Browse interactively

Run `zen-bookmarks` without arguments in an interactive terminal to open the OpenTUI bookmark browser. It shows saved and sidebar bookmarks in folder trees (including empty folders) that start fully collapsed, with focused workspace, persistent search, bookmark-list, and detail regions. Bookmark details include a cached Firecrawl summary after that page has appeared in returned search results above the relevance threshold. `Tab` cycles forward through Zen workspaces such as Personal and Work, while `Shift-Tab` cycles backward; saved bookmarks remain visible in every workspace view. `/` focuses fuzzy search. Arrow keys move between regions, `j`/`k` navigate bookmarks or scroll details, and Page Up/Page Down moves by a page. Right opens details or expands a collapsed folder; Left returns to bookmarks or collapses a folder; Enter toggles folders. Mouse clicks transfer focus. Lowercase `r` re-scrapes and reclassifies the selected URL and requires a stored TypeSafe API key. Uppercase `R` reloads saved and sidebar bookmarks from the current Zen profile's on-disk databases. In non-TTY automation, an argument-free invocation prints help instead.

## Establish the session

Use read-only profile and tree discovery before exact inspection or mutation. Do not run this sequence before an MCP relevance-only search unless profile discovery is ambiguous or search is unavailable:

```bash
zen-bookmarks status --json
zen-bookmarks list --json
```

Profile discovery scans `~/Library/Application Support/zen/Profiles`. If discovery is ambiguous, ask the user to choose rather than guessing:

```bash
zen-bookmarks status --profile "profile-substring" --json
zen-bookmarks status --sessions "/absolute/path/to/zen-sessions.jsonlz4" --json
```

After resolving a profile, prefer the exact `path` returned by `status --json` as `--sessions <path>` on subsequent commands. This prevents later commands from targeting a different profile.

Read commands work while Zen is open, although very recent UI changes may not appear until Zen saves them.

## Inspect before changing

Use machine-readable output for reasoning and stable IDs for mutations:

```bash
zen-bookmarks list --sessions "$SESSION" --json
zen-bookmarks verify --sessions "$SESSION" --json
```

Use `list --verbose` only when a human-readable tree with URLs is more useful. Names and URLs may be duplicated; prefer workspace, folder, and bookmark IDs from `list --json`.

`verify` exits nonzero when the mozLz4 round trip is lossy or structural validation fails. Do not mutate an invalid session unless the user explicitly accepts the risk after seeing the failure.

## Apply mutations safely

For every bookmark, folder, workspace, or HTML-import mutation:

1. Resolve and retain the exact session path.
2. Inspect the current tree and identify targets by stable ID.
3. Run the complete command with `--dry-run --json`.
4. Show the dry-run summary and exact target to the user.
5. Obtain confirmation before the real write.
6. Run the same command without `--dry-run`, adding `--yes` only after that confirmation.
7. Report the returned `backupPath` and summary.
8. Run `verify --json` and re-list the affected area.

Example:

```bash
zen-bookmarks bookmark update \
  --sessions "$SESSION" \
  --id "bookmark-id" \
  --title "Example Docs" \
  --url "https://example.com/docs" \
  --dry-run \
  --json
```

After confirmation:

```bash
zen-bookmarks bookmark update \
  --sessions "$SESSION" \
  --id "bookmark-id" \
  --title "Example Docs" \
  --url "https://example.com/docs" \
  --yes \
  --json
```

A real write may gracefully quit Zen, reload its final saved state, validate the mutation, create `zen-sessions.jsonlz4.bak-<timestamp>`, atomically replace the source, and reopen Zen if it was running. Use `--no-reopen` when the user wants Zen left closed. Do not use `--yes`, `--reopen`, or `--no-reopen` without understanding and honoring the user's lifecycle preference.

Never edit or replace `zen-sessions.jsonlz4` directly.

## Bookmark commands

```bash
# Add
zen-bookmarks bookmark add --url <url> [--title <title>] [--workspace <id-or-name>] [--folder <id-or-name>]

# Update; --url is the new URL here
zen-bookmarks bookmark update (--id <id> | --match-url <old-url>) [--title <title>] [--url <new-url>]

# Move; --url is a selector here
zen-bookmarks bookmark move (--id <id> | --url <url>) [--workspace <destination>] [--folder <destination>]

# Remove
zen-bookmarks bookmark remove (--id <id> | --url <url>) [--all]
```

For move selectors, use `--source-workspace` and `--source-folder` to disambiguate the source. Moves append to the destination. URL removal that matches multiple pins requires `--all`; do not add `--all` without explicit user intent. Update and move require a unique match.

## Folder commands

```bash
zen-bookmarks folder add --name <name> [--workspace <workspace>] [--parent <folder>]
zen-bookmarks folder update (--id <id> | --folder <name>) --name <new-name> [--workspace <workspace>]
zen-bookmarks folder move (--id <id> | --folder <name>) [--workspace <source>] [--to-workspace <destination>] [--parent <folder>]
zen-bookmarks folder remove (--id <id> | --folder <name>) [--workspace <workspace>] [--recursive]
```

Folder moves append to the destination. Removing a non-empty folder requires `--recursive`. Never infer recursive deletion from a general cleanup request; confirm the folder contents and user intent. The CLI refuses to alter folders referenced by active split-view data.

## Workspace commands

```bash
zen-bookmarks workspace add --name <name>
zen-bookmarks workspace update (--id <id> | --workspace <name>) --name <new-name>
zen-bookmarks workspace move (--id <id> | --workspace <name>) --index <zero-based-index>
zen-bookmarks workspace remove (--id <id> | --workspace <name>) [--recursive]
```

Workspace indexes are zero-based. A non-empty workspace requires `--recursive` for removal, and the final workspace cannot be removed. Recursive removal also removes that workspace's tabs; enumerate them and obtain explicit confirmation first.

## Import and export

Export is read-only with respect to Zen but writes three files to the output directory:

```bash
zen-bookmarks export --sessions "$SESSION" --out <directory> --json
```

It writes `bookmarks.json`, `bookmarks.yaml`, and `bookmarks.html`.

HTML import rebuilds the selected workspace's pinned tree and is a mutation, so follow the dry-run workflow:

```bash
zen-bookmarks import-html \
  --sessions "$SESSION" \
  --file <bookmarks.html> \
  --workspace <id-or-name> \
  --dry-run \
  --json
```

Import preserves other workspaces and reuses existing pinned tabs by URL where possible.

## Handle failures

- Preserve stderr and the process exit code; do not claim success from stdout alone.
- Add `--debug` to CLI `index` or `search` commands when diagnosing page-fetch, TypeSafe, or Firecrawl network timing and cache decisions; debug logs go to stderr without corrupting JSON stdout.
- If profile selection is ambiguous, ask for `--profile` or an explicit `--sessions` path.
- If a selector is ambiguous, re-list and use an ID or narrower source selectors.
- If validation or optimistic concurrency checks fail, stop and re-read current state; never retry a stale mutation blindly.
- If Zen restarts before a write, stop and repeat discovery plus dry-run against the newly saved state.
- Do not delete timestamped backups unless the user explicitly requests it.

The legacy `extract-bookmarks.ts` and `update-bookmarks.ts` entry points remain compatible, but use the unified CLI for new work.
