# zen-bookmarks

Search [Zen browser](https://zen-browser.app) pinned sidebar links/tabs and manage sidebar folders and workspaces from one command-line interface. This project refers to those URL-bearing records collectively as **bookmarks**.

Run `zen-bookmarks` without arguments in a terminal to open the interactive semantic-search interface. It reads sidebar bookmarks and workspace state from `zen-sessions.jsonlz4`, uses the same BM25, TypeSafe, Firecrawl, and SQLite-cache pipeline as `zen-bookmarks search`, and never modifies Zen while searching. Sidebar mutations use the existing safe close, backup, validation, atomic-write, and reopen lifecycle.

## Features

- Pi-style OpenTUI semantic search when invoked without arguments
- Enter-to-search composer backed by the same retrieval pipeline as the CLI
- Rich, keyboard-selectable result cards with relevance, location, URL, and summary
- Read-only status, list, verify, export, and relevance-search commands work while Zen is open
- Cached BM25 retrieval and TypeSafe reranking across sidebar bookmarks
- Firecrawl summaries for every returned public page above the relevance threshold
- Persistent page metadata, link classifications, summaries, and relevance scores in SQLite
- OS-native TypeSafe and Firecrawl credential storage through Bun Secrets
- Full CRUD for sidebar bookmarks, folders, and workspaces
- JSON output with stable Zen IDs for scripting and unambiguous targeting
- Typed MCP tools for read, search, export, import, and sidebar CRUD operations
- Interactive Zen lifecycle management for writes on macOS
- Timestamped backup before every write
- Optimistic concurrency check, structural validation, durable temporary write, and atomic rename
- JSON, YAML, and Netscape HTML exports
- Netscape HTML import that reuses existing tabs by pinned URL

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- Zen Browser on macOS
- A [TypeSafe](https://typesafe.ai) API key for relevance search
- A [Firecrawl](https://firecrawl.dev) API key for top-result summaries

Profile discovery currently scans `~/Library/Application Support/zen/Profiles`. Use `--sessions <path>` for an explicit session file or `--profile <substring>` to select among multiple profiles.

## Install

```bash
bun add --global @wyattjoh/zen-bookmarks
```

To install from source instead:

```bash
git clone https://github.com/wyattjoh/zen-bookmarks.git
cd zen-bookmarks
bun install
bun link
```

You can also run the source directly:

```bash
bun src/zen-bookmarks.ts --help
```

Run `bun install` to install the TypeSafe and Firecrawl SDKs plus development dependencies.

## MCP server

Serve the CLI operations as typed [Model Context Protocol](https://modelcontextprotocol.io) tools over stdio:

```bash
zen-bookmarks mcp
```

A typical MCP client configuration is:

```json
{
  "mcpServers": {
    "zen-bookmarks": {
      "command": "zen-bookmarks",
      "args": ["mcp"]
    }
  }
}
```

The server exposes `status`, `auth_status`, `list`, `verify`, `export`, `index`, `search`, and `import_html`, plus `bookmark_*`, `folder_*`, and `workspace_*` CRUD tools. Every tool advertises a human-readable title, behavioral annotations, and typed inputs instead of raw CLI arguments. `status`, `list`, and `search` also advertise output schemas for their `structuredContent`. Server instructions route relevance requests to `search`, bound project discovery to at most four focused calls with explicit stopping rules, reserve the potentially large `list` result for exhaustive sidebar inspection and stable-ID lookup, and explain that search results already contain workspace and folder locations. Each search returns at most eight results. Use `sessions` for an exact `zen-sessions.jsonlz4` path or `profile` for a unique profile substring.

MCP tools operate on pinned Zen sidebar bookmarks. Firefox-style saved bookmarks from `places.sqlite` are not exposed by the current CLI, TUI, or MCP search/list interfaces.

Mutation tools default to `apply: false`, which runs the existing `--dry-run` path without closing Zen or writing files. Set `apply: true` only after reviewing that result; the server then uses the CLI's non-interactive `--yes` lifecycle, including validation, backup, atomic replacement, and reopening Zen when appropriate. The optional `reopen` boolean maps to `--reopen` or `--no-reopen`.

Credential entry and deletion are intentionally not exposed over MCP because tool arguments and calls may be logged by clients. Run `zen-bookmarks login` once to configure TypeSafe and Firecrawl; existing keys are preserved unless you confirm that they should be replaced. `search` requires both stored credentials, while `index` requires only TypeSafe. The interactive TUI also remains a terminal-only interface.

## Interactive search

Launch the TUI from an interactive terminal:

```bash
zen-bookmarks
```

The interface follows Pi's query-and-results shape: a rounded composer stays at the bottom while the submitted query and rich result cards render above it. Enter a natural-language query and press `Enter`. The TUI runs the same sidebar search as `zen-bookmarks search`, including lazy indexing, local BM25 shortlisting, TypeSafe relevance scoring, the default 0.5 relevance threshold, a ten-result limit, and cached Firecrawl summaries.

After results load, focus moves to the first card. Use Up/Down or `j`/`k` to move between cards and Page Up/Page Down to jump farther; the scrollbox keeps the selected result visible. Each card shows its relevance, workspace and folder path, URL, current URL when different, and summary. Press `/`, `Enter`, or Escape to return to the composer for another query, click a card to select it, or press `q` while navigating results to quit. `Ctrl+C` exits from either region.

Search requires both API keys configured by `zen-bookmarks login`. The TUI searches pinned sidebar bookmarks, matching the CLI search scope; Firefox-style saved bookmarks from `places.sqlite` are not included.

When standard input or output is not a TTY, invoking the command without arguments prints CLI help instead of opening the TUI.

## Safety model

Read-only commands and the TUI never close Zen:

```bash
zen-bookmarks status
zen-bookmarks list
zen-bookmarks verify
zen-bookmarks export
zen-bookmarks index
zen-bookmarks search "TypeScript references"
```

Write commands follow this sequence:

1. If Zen is open, ask whether to quit it and continue.
2. Ask macOS to quit Zen normally and wait for the process to exit.
3. Reload the final session state saved during shutdown.
4. Apply and structurally validate the mutation.
5. Confirm the source file did not change concurrently.
6. Save `zen-sessions.jsonlz4.bak-<timestamp>` beside the source.
7. Flush a temporary file and atomically rename it over the source.
8. If Zen was open initially, ask whether to reopen it.

Use `--dry-run` to validate and summarize any mutation without closing Zen or writing files. For automation, `--yes` accepts the lifecycle prompts and reopens Zen if it was previously running. `--no-reopen` overrides the latter behavior.

## Read and export

```bash
zen-bookmarks status
zen-bookmarks list
zen-bookmarks list --verbose
zen-bookmarks list --json
zen-bookmarks verify
zen-bookmarks export --out ./exports
```

Human-readable lists include workspace, folder, and bookmark IDs. Use those IDs for reliable mutations when names or URLs are duplicated.

## AI relevance search

Store TypeSafe and Firecrawl API keys in the operating system credential store, then
search sidebar bookmarks with natural language:

```bash
zen-bookmarks login
zen-bookmarks auth status

# Optional: prewarm every missing link and cached TypeSafe classification
zen-bookmarks index

zen-bookmarks search "documentation for browser extension authentication"
zen-bookmarks search "recipes I saved for dinner" --limit 5
zen-bookmarks search "loosely related developer tools" --min-relevance 0.25
zen-bookmarks search "TypeScript references" --json
zen-bookmarks search "AI agent tools" --debug --json

zen-bookmarks auth delete typesafe
zen-bookmarks auth delete firecrawl
```

`login` prompts without echoing missing keys. When a key is already configured, it
asks whether to replace it and defaults to keeping the existing value. For automation,
pass `--typesafe-api-key <key>` and `--firecrawl-api-key <key>`; explicit flags replace
stored values without prompting, but may be retained in shell history or exposed to
process inspection. Credentials are stored through Bun Secrets in macOS Keychain,
Linux Secret Service, or Windows Credential Manager; they are never read from
environment variables.

The indexer, CLI search, and TUI cache bounded public-page metadata and text plus reusable TypeSafe
classifications in the platform user-cache directory. Classification questions for one
link are batched into one request. They skip local, private, likely authenticated, and
credential-bearing URLs; those bookmarks remain visible from their Zen metadata.
Existing entries remain cached until `zen-bookmarks index --refresh` is run.

Search lazily indexes missing links, uses local BM25 retrieval to select up to 30
candidates, and asks TypeSafe one independent Noul relevance question per candidate.
After applying the relevance cutoff, sorting, and result limit, it calls Firecrawl's SDK
with the `summary` format for every returned public page. Calls use bounded concurrency.
Summaries are general rather than query-specific and are cached against the locally
indexed page-content hash, so unchanged pages are not sent to Firecrawl again. The CLI and MCP search responses include
the summaries, and the TUI displays cached summaries directly in its result cards.

The CLI caches each relevance judgment by normalized query, bookmark-content hash, model,
and question version, so repeating an unchanged search makes no TypeSafe requests.
Results below 0.5 relevance are hidden by default; `--min-relevance` changes that cutoff.
Use `--cache <path>` to override the default SQLite location. Add `--debug` to `index`
or `search` to write page-fetch, TypeSafe, and Firecrawl operation timings plus cache-hit
and skip decisions to stderr; stdout remains valid human-readable or JSON output.

## Bookmark CRUD

```bash
# Create
zen-bookmarks bookmark add \
  --url "https://example.com" \
  --title "Example" \
  --workspace Personal \
  --folder Reading

# Update by stable ID
zen-bookmarks bookmark update \
  --id "1740000000000-1" \
  --title "Example Docs" \
  --url "https://example.com/docs"

# Update by old URL
zen-bookmarks bookmark update \
  --match-url "https://example.com" \
  --url "https://example.com/docs"

# Move (destination is appended)
zen-bookmarks bookmark move \
  --id "1740000000000-1" \
  --workspace Work \
  --folder References

# Remove
zen-bookmarks bookmark remove --id "1740000000000-1"
```

Use `--source-workspace` and `--source-folder` to narrow a move selector. URL selectors that match multiple pins require `--all` for removal; update and move require a unique match.

## Folder CRUD

```bash
zen-bookmarks folder add --name Projects --workspace Work
zen-bookmarks folder add --name Active --workspace Work --parent Projects

zen-bookmarks folder update \
  --id "1740000000000-2" \
  --workspace Work \
  --name "Active Projects"

zen-bookmarks folder move \
  --id "1740000000000-2" \
  --workspace Work \
  --to-workspace Personal \
  --parent Reading

zen-bookmarks folder remove \
  --id "1740000000000-2" \
  --workspace Personal \
  --recursive
```

Folder moves append the folder to the destination. Removing a non-empty folder requires `--recursive`. Operations refuse to alter folders referenced by active split-view data.

## Workspace CRUD

```bash
zen-bookmarks workspace add --name Research
zen-bookmarks workspace update --workspace Research --name "R&D"
zen-bookmarks workspace move --workspace "R&D" --index 0
zen-bookmarks workspace remove --workspace "R&D"
```

Removing a non-empty workspace requires `--recursive`, and the final workspace cannot be removed. Recursive removal also removes tabs owned by that workspace, so use a dry run and backup deliberately.

## HTML import

```bash
zen-bookmarks import-html \
  --file bookmarks.html \
  --workspace Personal \
  --dry-run

zen-bookmarks import-html \
  --file bookmarks.html \
  --workspace Personal
```

Import rebuilds the selected workspace's pinned tree. Existing pins are reused by pinned URL so their session identity and available history are retained. Other workspaces remain untouched.

## Global options

- `--sessions <path>`: use an explicit `zen-sessions.jsonlz4`
- `--profile <substring>`: select a profile directory
- `--cache <path>`: override the persistent search-cache path
- `--dry-run`: validate without writing or closing Zen
- `--json`: machine-readable output where supported
- `--limit <count>`: maximum number of relevance-search results (default: 10)
- `--min-relevance <0-1>`: relevance cutoff for search results (default: 0.5)
- `--refresh`: replace cached link content and classifications during `index`
- `--yes`: accept quit/reopen prompts
- `--reopen`: always reopen a previously running Zen
- `--no-reopen`: do not reopen Zen

## Compatibility commands

The original entry points remain available:

```bash
bun src/extract-bookmarks.ts
bun src/update-bookmarks.ts list
bun src/update-bookmarks.ts verify
bun src/update-bookmarks.ts add --url "https://example.com"
bun src/update-bookmarks.ts add --url "https://example.com" --apply
```

Without `--apply`, legacy mutation commands now perform an in-memory dry run rather than writing a preview file. With `--apply`, they use the new interactive close/write/reopen lifecycle.

## How it works

The session file is a Mozilla `mozLz4` container: `mozLz40\0`, a little-endian decompressed size, and a raw LZ4 block. `mozlz4.ts` reads normal compressed blocks and writes a valid all-literal block without a runtime dependency.

Zen represents pinned tabs as session tab records. A pin references its workspace through `zenWorkspace`, a folder through `groupId`, and its stable identity through `zenSyncId`. Folder nesting uses `parentId`; the CLI preserves unknown fields and the rest of the session document verbatim.

Zen's session and sync formats continue to evolve. The CLI validates known invariants and keeps backups, but test changes with `--dry-run` and retain backups when upgrading Zen.

## Development

```bash
bun install
bun test
bun run typecheck
```

See [RELEASING.md](RELEASING.md) for the automated release and npm publishing process.

## License

[MIT](LICENSE)
