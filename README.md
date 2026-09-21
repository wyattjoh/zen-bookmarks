# zen-bookmarks

Browse all [Zen browser](https://zen-browser.app) bookmarks—saved bookmarks plus pinned sidebar links/tabs—and manage sidebar folders and workspaces from one command-line interface. This project refers to all of those URL-bearing records collectively as **bookmarks**.

Run `zen-bookmarks` without arguments in a terminal to open the interactive bookmark browser. Saved bookmarks are read from `places.sqlite`; sidebar bookmarks and workspace state come from `zen-sessions.jsonlz4`. Both sources are read-only while browsing. Sidebar mutations use the existing safe close, backup, validation, atomic-write, and reopen lifecycle.

## Features

- OpenTUI React browser for saved and sidebar bookmarks when invoked without arguments
- Grouped fuzzy filtering with cached page metadata and TypeSafe classifications
- On-demand re-scraping and reclassification of the selected bookmark
- Read-only status, list, verify, export, and relevance-search commands work while Zen is open
- Cached BM25 retrieval and TypeSafe reranking across sidebar bookmarks
- Persistent page metadata, link classifications, and relevance scores in SQLite
- OS-native TypeSafe credential storage through Bun Secrets
- Full CRUD for sidebar bookmarks, folders, and workspaces
- JSON output with stable Zen IDs for scripting and unambiguous targeting
- Interactive Zen lifecycle management for writes on macOS
- Timestamped backup before every write
- Optimistic concurrency check, structural validation, durable temporary write, and atomic rename
- JSON, YAML, and Netscape HTML exports
- Netscape HTML import that reuses existing tabs by pinned URL

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- Zen Browser on macOS
- A [TypeSafe](https://typesafe.ai) API key for relevance search

Profile discovery currently scans `~/Library/Application Support/zen/Profiles`. Use `--sessions <path>` for an explicit session file or `--profile <substring>` to select among multiple profiles.

## Install

```bash
git clone https://github.com/wyattjoh/zen-bookmarks.git
cd zen-bookmarks
bun link
```

You can also run the source directly:

```bash
bun src/zen-bookmarks.ts --help
```

Run `bun install` to install the TypeSafe SDK and development dependencies.

## Interactive browser

Launch the TUI from an interactive terminal:

```bash
zen-bookmarks
```

The left pane presents saved bookmarks and sidebar bookmarks as collapsible folder trees grouped by source and workspace, including empty folders. All folders start collapsed, and folder depth is the only source of row indentation. Each bookmark uses a title line followed immediately by its muted URL. Press `Tab` to cycle through Zen workspaces such as Personal and Work (`Shift-Tab` cycles backward); saved bookmarks remain visible in every workspace view. A persistent search field fuzzy-filters titles, URLs, folders, locations, and cached metadata; press `/` to focus it. The focused border identifies whether keyboard input targets workspaces, search, bookmarks, or details. Arrow keys move between regions, `j`/`k` navigate bookmarks or scroll details, and Page Up/Page Down moves by a page. Right opens details for a bookmark or expands a collapsed folder; Left returns from details or collapses a folder; Enter toggles folders. Mouse clicks transfer focus, and dragging still selects text for copying without leaving a one-character highlight after ordinary clicks. The detail pane shows cached page metadata and a readable topic-confidence table while hiding internal hashes and raw classification JSON. Press lowercase `r` to fetch the selected page again and rerun its TypeSafe classification, uppercase `R` to reload both bookmark databases from Zen, or `q` to quit.

Re-scraping requires a stored TypeSafe API key (`zen-bookmarks login`). Saved bookmarks are browse-only; mutation commands continue to target sidebar bookmarks. If Zen holds an exclusive lock on `places.sqlite`, the TUI reads a temporary snapshot of both the main database and its WAL so recent saved-bookmark changes remain visible without interfering with the browser.

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

Store a TypeSafe API key in the operating system credential store, then search
sidebar bookmarks with natural language:

```bash
zen-bookmarks login
zen-bookmarks auth status

# Optional: prewarm every missing link and cached TypeSafe classification
zen-bookmarks index

zen-bookmarks search "documentation for browser extension authentication"
zen-bookmarks search "recipes I saved for dinner" --limit 5
zen-bookmarks search "loosely related developer tools" --min-relevance 0.25
zen-bookmarks search "TypeScript references" --json

zen-bookmarks auth delete
```

`login` prompts without echoing the key. It also accepts `--api-key <key>` for
automation, but the argument may be retained in shell history or exposed to process
inspection. Credentials are stored through Bun Secrets in macOS Keychain, Linux
Secret Service, or Windows Credential Manager; they are never read from environment
variables.

The indexer and TUI cache bounded public-page metadata and text plus reusable TypeSafe
classifications in the platform user-cache directory. Classification questions for one
link are batched into one request. They skip local, private, likely authenticated, and
credential-bearing URLs; those bookmarks remain visible from their Zen metadata.
Existing entries remain cached until `zen-bookmarks index --refresh` is run.

Search lazily indexes missing links, uses local BM25 retrieval to select up to 30
candidates, and asks TypeSafe one independent Noul relevance question per candidate.
The CLI caches each judgment by normalized query, bookmark-content hash, model, and
question version, so repeating an unchanged search makes no TypeSafe requests. Results
below 0.5 relevance are hidden by default; `--min-relevance` changes that cutoff. Use
`--cache <path>` to override the default SQLite location.

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

## License

[MIT](LICENSE)
